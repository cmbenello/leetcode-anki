// Thin promise wrapper around chrome.storage.local with named keys.
// Service workers in MV3 die when idle, so all state must round-trip through here.

import { DEFAULT_INTERVALS_MIN, DEFAULT_GROWTH } from './sm2.js';

const KEYS = {
  CARDS: 'cards',          // { [slug]: card }
  META: 'meta',            // { [slug]: { difficulty, tags, fetchedAt } }
  SETTINGS: 'settings',
  SYNC_QUEUE: 'syncQueue',
  STATS: 'stats',
};

const DEFAULT_SETTINGS = {
  // GitHub
  githubToken: '',
  githubRepo: '',
  syncEnabled: false,
  defaultLang: 'python3',

  // Scheduler
  intervals: { ...DEFAULT_INTERVALS_MIN },
  growth:    { ...DEFAULT_GROWTH },

  // Daily reminder
  dailyReminderEnabled: false,
  dailyReminderTime: '09:00',  // local time HH:MM
};

async function get(key, fallback) {
  const out = await chrome.storage.local.get(key);
  return out[key] ?? fallback;
}
async function set(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ---------- cards ----------
export async function getCards()       { return get(KEYS.CARDS, {}); }
export async function setCards(cards)  { return set(KEYS.CARDS, cards); }
export async function getCard(slug) {
  const cards = await getCards();
  return cards[slug];
}
export async function upsertCard(card) {
  const cards = await getCards();
  cards[card.slug] = card;
  await setCards(cards);
  return card;
}

// ---------- per-problem metadata (difficulty, tags) ----------
export async function getAllMeta()        { return get(KEYS.META, {}); }
export async function getMeta(slug)       { return (await getAllMeta())[slug] ?? null; }
export async function upsertMeta(slug, m) {
  const all = await getAllMeta();
  all[slug] = { ...m, fetchedAt: Date.now() };
  await set(KEYS.META, all);
  return all[slug];
}

// ---------- settings ----------
export async function getSettings() {
  const s = await get(KEYS.SETTINGS, {});
  return {
    ...DEFAULT_SETTINGS,
    ...s,
    intervals: { ...DEFAULT_SETTINGS.intervals, ...(s.intervals || {}) },
    growth:    { ...DEFAULT_SETTINGS.growth,    ...(s.growth    || {}) },
  };
}
export async function setSettings(patch) {
  const cur = await getSettings();
  const next = {
    ...cur,
    ...patch,
    intervals: { ...cur.intervals, ...(patch.intervals || {}) },
    growth:    { ...cur.growth,    ...(patch.growth    || {}) },
  };
  await set(KEYS.SETTINGS, next);
  return next;
}

// ---------- sync queue ----------
export async function getSyncQueue()         { return get(KEYS.SYNC_QUEUE, []); }
export async function setSyncQueue(queue)    { return set(KEYS.SYNC_QUEUE, queue); }
export async function pushSyncQueue(item) {
  const q = await getSyncQueue();
  q.push(item);
  await setSyncQueue(q);
  return q;
}

// ---------- stats ----------
export async function getStats() {
  return get(KEYS.STATS, { totalReviews: 0, lapses: 0, lastReviewAt: 0, byDay: {} });
}
export async function bumpStats({ isLapse, now = Date.now() }) {
  const s = await getStats();
  s.totalReviews += 1;
  if (isLapse) s.lapses += 1;
  s.lastReviewAt = now;
  const dayKey = new Date(now).toISOString().slice(0, 10);
  s.byDay[dayKey] = (s.byDay[dayKey] || 0) + 1;
  await set(KEYS.STATS, s);
  return s;
}

export { KEYS, DEFAULT_SETTINGS };
