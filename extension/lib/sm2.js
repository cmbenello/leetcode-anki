// Spaced-repetition scheduler.
//
// Not strict SM-2: intervals are stored in MINUTES (not days) and the
// "ease" concept is replaced by a per-button growth multiplier so we can
// have sub-day initial intervals (Again = 30m) and still get exponential
// spacing on repeated success.
//
// Per-card state:
//   { slug, title, intervalMin, reps, lapses, due, history, ... }
//
// Settings (from chrome.storage):
//   intervals: { again, hard, good, easy }  // minutes — base/floor for each button
//   growth:    { again, hard, good, easy }  // multiplier applied to prevInterval on repeats
//
// On grade(card, button, settings):
//   - new card                : intervalMin = base[button]
//   - "again"                 : reset reps; intervalMin = base.again; lapses += 1
//   - subsequent good/hard/easy : intervalMin = max(base[button], prev * growth[button])
//   ...then every result is scaled by the card's EASE (below).
//
// Ease (the SM-2 idea, re-expressed as a multiplier on our configurable base):
// without it, a lapse only reset `reps`, so the very next Good jumped straight
// back to the full 3-day base — a problem failed five times was scheduled
// exactly like one never failed. Now each card carries `ease` (default 1.0):
//   again x0.80, hard x0.95, good x1.00, easy x1.05, clamped to [0.5, 1.5],
// applied from the NEXT grade on (the current grade uses the ease you had).
// A never-failed card stays at 1.0, so its schedule is bit-for-bit unchanged.

export const BUTTONS = [
  { id: 'again', label: 'Again', quality: 0 },
  { id: 'hard',  label: 'Hard',  quality: 3 },
  { id: 'good',  label: 'Good',  quality: 4 },
  { id: 'easy',  label: 'Easy',  quality: 5 },
];

export const QUALITY = Object.freeze({ AGAIN: 0, HARD: 3, GOOD: 4, EASY: 5 });

const QUALITY_TO_BUTTON = { 0: 'again', 3: 'hard', 4: 'good', 5: 'easy' };

export const DEFAULT_INTERVALS_MIN = Object.freeze({
  again: 30,        // 30 min
  hard:  1440,      // 1 day
  good:  4320,      // 3 days
  easy:  14400,     // 10 days
});

export const DEFAULT_GROWTH = Object.freeze({
  again: 1.0,       // unused — Again always resets to base
  hard:  1.2,
  good:  2.5,
  easy:  3.5,
});

export const EASE = Object.freeze({
  start: 1.0, min: 0.5, max: 1.5,
  step: { again: 0.80, hard: 0.95, good: 1.0, easy: 1.05 },
});

const MIN_MS = 60 * 1000;

export function newCard(slug, title, site = null) {
  return {
    slug,
    title: title ?? slug,
    site,
    intervalMin: 0,
    ease: EASE.start,
    reps: 0,
    lapses: 0,
    due: Date.now(),
    history: [],
    notesCreated: false,
  };
}

function buttonIdFromQuality(q) {
  return QUALITY_TO_BUTTON[q] ?? null;
}

/**
 * Apply a grade. Returns { card, prevIntervalMin, nextIntervalMin }.
 * Does not mutate the input card.
 *
 * `quality` is a SM-2 quality number (0/3/4/5). For convenience the function
 * also accepts a button id string ('again'|'hard'|'good'|'easy').
 */
export function grade(card, quality, settings = {}, now = Date.now()) {
  const button = typeof quality === 'string'
    ? quality
    : buttonIdFromQuality(quality);
  if (!button) throw new Error(`unknown quality: ${quality}`);

  const intervals = { ...DEFAULT_INTERVALS_MIN, ...(settings.intervals || {}) };
  const growth    = { ...DEFAULT_GROWTH,        ...(settings.growth    || {}) };

  const useEase = settings.easeEnabled !== false;

  const c = { ...card, history: [...(card.history ?? [])] };
  const prev = c.intervalMin ?? 0;
  const base = intervals[button];

  // THIS interval uses the ease earned so far; the button then nudges ease for
  // future intervals. So a first grade always lands exactly on the configured
  // base (Again = 30m means 30m), and a lapse shortens the NEXT interval.
  const priorEase = useEase ? (c.ease ?? EASE.start) : EASE.start;
  const nextEase = useEase
    ? Math.min(EASE.max, Math.max(EASE.min, priorEase * EASE.step[button]))
    : EASE.start;
  c.ease = Math.round(nextEase * 1000) / 1000;

  let raw;
  if (button === 'again') {
    c.lapses = (c.lapses ?? 0) + 1;
    c.reps = 0;
    raw = base;
  } else {
    raw = ((c.reps ?? 0) === 0 || prev === 0)
      ? base
      : Math.max(base, Math.round(prev * growth[button]));
    c.reps = (c.reps ?? 0) + 1;
  }
  c.intervalMin = Math.max(1, Math.round(raw * priorEase));

  c.due = now + c.intervalMin * MIN_MS;
  return { card: c, prevIntervalMin: prev, nextIntervalMin: c.intervalMin };
}

export function isDue(card, now = Date.now()) {
  return (card.due ?? 0) <= now;
}

export function minutesUntilDue(card, now = Date.now()) {
  return Math.ceil(((card.due ?? now) - now) / MIN_MS);
}

// ---------- formatting helpers (used by UI) ----------

export function formatDuration(min) {
  if (min == null) return '—';
  if (min < 1) return '<1m';
  if (min < 60) return `${Math.round(min)}m`;
  if (min < 1440) {
    const h = min / 60;
    return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
  }
  if (min < 1440 * 30) {
    const d = min / 1440;
    return Number.isInteger(d) ? `${d}d` : `${d.toFixed(1)}d`;
  }
  if (min < 1440 * 365) return `${Math.round(min / 1440 / 30)}mo`;
  return `${Math.round(min / 1440 / 365)}y`;
}

export function parseDuration(s) {
  if (s == null) return null;
  const str = String(s).trim().toLowerCase();
  if (str === '') return null;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.round(parseFloat(str)); // raw minutes
  const re = /(\d+(?:\.\d+)?)\s*(d|h|m)/g;
  let total = 0, matched = false, m;
  while ((m = re.exec(str)) !== null) {
    matched = true;
    const n = parseFloat(m[1]);
    const unit = m[2];
    total += unit === 'd' ? n * 1440 : unit === 'h' ? n * 60 : n;
  }
  return matched ? Math.round(total) : null;
}
