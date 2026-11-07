// Thin promise wrapper around chrome.storage.local with named keys.
// Service workers in MV3 die when idle, so all state must round-trip through here.

import { DEFAULT_INTERVALS_MIN, DEFAULT_GROWTH } from './sm2.js';
import { dayKeyMs } from './dates.js';
import { sanitizeCards } from './cards.js';

const KEYS = {
  CARDS: 'cards',          // { [slug]: card }
  META: 'meta',            // { [slug]: { difficulty, tags, fetchedAt } }
  SETTINGS: 'settings',
  SYNC_QUEUE: 'syncQueue',
  STATS: 'stats',
  SCHEMA: 'schemaVersion',
  GOALS: 'goals',
  ACTIVE_GOAL: 'activeGoal',
  CATALOG: 'catalog',          // { fetchedAt, rows: [...] } — see lib/leetcode-api.js
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
  // Shrink a card's intervals after lapses, grow them after Easy runs.
  // Off => every card is scheduled as if it had never been failed.
  easeEnabled: true,

  // New-tab dashboard colour scheme: 'glass' | 'ocean' | 'dusk' | 'graphite'
  theme: 'glass',
  // Where clicking a problem on the dashboard takes you: 'leetcode' | 'neetcode'
  openOn: 'leetcode',

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
// Normalised on every read (see lib/cards.js): one malformed record must not
// be able to break every request that walks the card list.
export async function getCards() {
  const cards = await get(KEYS.CARDS, {});
  sanitizeCards(cards);
  return cards;
}
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
  const key = dayKeyMs(now);       // LOCAL day — see lib/dates.js
  s.byDay[key] = (s.byDay[key] || 0) + 1;
  await set(KEYS.STATS, s);
  return s;
}

export async function setStats(stats) { return set(KEYS.STATS, stats); }

// ---------- schema version (one-shot migrations) ----------
export async function getSchemaVersion()  { return get(KEYS.SCHEMA, 0); }
export async function setSchemaVersion(v) { return set(KEYS.SCHEMA, v); }

// ---------- goals ----------
export async function getGoals()             { return get(KEYS.GOALS, []); }
export async function setGoals(goals)        { return set(KEYS.GOALS, goals); }
export async function getActiveGoalId()      { return get(KEYS.ACTIVE_GOAL, null); }
export async function setActiveGoalId(id)    { return set(KEYS.ACTIVE_GOAL, id); }

// ---------- problem catalog ----------
export async function getCatalog()           { return get(KEYS.CATALOG, null); }
export async function setCatalog(rows)       { return set(KEYS.CATALOG, { fetchedAt: Date.now(), rows }); }

export { KEYS, DEFAULT_SETTINGS };
