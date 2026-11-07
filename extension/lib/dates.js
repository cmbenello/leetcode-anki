// Day bucketing — ONE source of truth.
//
// Why this file exists: `stats.byDay` used to be written with
// `new Date(t).toISOString().slice(0, 10)` (a UTC date) while the newtab
// dashboard read it back with a LOCAL date. West of UTC that silently
// misfiles every evening review under tomorrow's key: the "reviewed today"
// counter reads 0, the streak snaps, and heatmap cells land a column late.
//
// A study streak is a human, local-time concept — 11pm Friday is Friday.
// So every day key in the extension is LOCAL, and it comes from here.

/** Local YYYY-MM-DD for a Date. */
export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local YYYY-MM-DD for an epoch-ms timestamp. */
export function dayKeyMs(ms) {
  return dayKey(new Date(ms));
}

/** Today's local day key. */
export function todayKey() {
  return dayKey(new Date());
}

/**
 * Local day keys for the `n` days ending today, oldest first.
 * Steps by calendar date (not by 86_400_000ms) so DST transitions don't
 * duplicate or skip a day.
 */
export function lastNDayKeys(n) {
  const out = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);          // midday anchor: immune to DST shifts
  d.setDate(d.getDate() - (n - 1));
  for (let i = 0; i < n; i++) {
    out.push(dayKey(d));
    d.setDate(d.getDate() + 1);
  }
  return out;
}

/**
 * Consecutive days with at least one review, ending today — or yesterday, so
 * the streak doesn't read 0 until you've started the current day.
 */
export function computeStreak(byDay, now = new Date()) {
  const d = new Date(now);
  d.setHours(12, 0, 0, 0);
  if (!byDay[dayKey(d)]) d.setDate(d.getDate() - 1);
  let count = 0;
  while (byDay[dayKey(d)]) {
    count += 1;
    d.setDate(d.getDate() - 1);
  }
  return count;
}
