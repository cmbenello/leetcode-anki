// Run with:  node tests/background.test.js
//
// Loads the REAL service worker (extension/background.js) against a stubbed
// chrome.* — no network, no catalog — and drives its message handlers. Covers
// the bugs that motivated the v0.3 rewrite, so they can't quietly come back:
// verdict dedupe, off-page verdicts, stale titles, local day keys, and the
// logged prediction leaking the outcome it predicts.
import assert from 'node:assert/strict';
import { eloP, priorBeta } from '../extension/lib/model.js';

const store = {};
let onMessage = null;
const noop = { addListener() {} };
globalThis.chrome = {
  storage: { local: {
    get: async (k) => (typeof k === 'string' ? { [k]: structuredClone(store[k]) } : {}),
    set: async (o) => { for (const [k, v] of Object.entries(o)) store[k] = structuredClone(v); },
    remove: async (k) => { delete store[k]; },
  } },
  runtime: { onMessage: { addListener: (f) => { onMessage = f; } }, onInstalled: noop, onStartup: noop, getURL: (p) => p, id: 't' },
  webNavigation: { onHistoryStateUpdated: noop },
  alarms: { create() {}, clear: async () => true, onAlarm: noop },
  notifications: { create() {}, clear() {}, onClicked: noop },
  tabs: { query: async () => [], update: async () => {}, create: async () => {}, sendMessage: async () => {} },
};
// No network. Packaged extension files (data/*.json) are served from disk, as
// chrome.runtime.getURL + fetch would inside the extension.
import { readFileSync } from 'node:fs';
const EXT_DIR = new URL('../extension/', import.meta.url);
// A personal, git-ignored *.local.json never leaks into tests: a test sets
// `localSeed` when it wants one.
let localSeed = null;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (/\.local\.json$/.test(u)) {
    return localSeed ? { ok: true, status: 200, json: async () => localSeed } : { ok: false, status: 404, json: async () => ({}) };
  }
  if (!/^https?:/.test(u)) {
    const body = readFileSync(new URL(u, EXT_DIR), 'utf8');
    return { ok: true, status: 200, json: async () => JSON.parse(body), text: async () => body };
  }
  return { ok: false, status: 503, json: async () => ({}), text: async () => '' };
};
const quiet = console.warn; console.warn = () => {};
await import('../extension/background.js');

const send = (msg) => new Promise((res) => onMessage(msg, { tab: { id: 1 } }, res));
const META = {
  'two-sum': { title: 'Two Sum', slug: 'two-sum', difficulty: 'Easy', acRate: 55,
    tags: [{ slug: 'array', name: 'Array' }, { slug: 'hash-table', name: 'Hash Table' }], similar: [] },
  'coin-change': { title: 'Coin Change', slug: 'coin-change', difficulty: 'Medium', acRate: 45,
    tags: [{ slug: 'dynamic-programming', name: 'DP' }], similar: [] },
};
function freshStore() {
  for (const k of Object.keys(store)) delete store[k];
  store.meta = Object.fromEntries(Object.entries(META).map(([k, v]) => [k, { ...v, fetchedAt: Date.now() }]));
}
const URL_TS = 'https://leetcode.com/problems/two-sum/';
// The honest cold-start prediction for Two Sum: nothing known, θ = 1200 everywhere.
const HONEST = Math.round(eloP(1200, priorBeta(META['two-sum'])) * 1000) / 1000;

async function acThenGrade(factors) {
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS,
    status: 'Accepted', submissionId: '501', source: 'network', code: 'x', language: 'python3' });
  return send({ kind: 'grade', slug: 'two-sum', title: 'Two Sum', quality: 4, durationMs: 300000,
    url: URL_TS, submission: { status: 'Accepted', at: Date.now() }, factors });
}

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('logged prediction does not see the outcome (startedAt given)', async () => {
  freshStore();
  await acThenGrade({ peeked: false, hints: 0, failsBeforeAc: 0, startedAt: Date.now() - 10 * 60e3 });
  const h = store.cards['two-sum'].history.at(-1);
  assert.equal(h.pPred, HONEST, `logged ${h.pPred}, honest ${HONEST}`);
  assert.equal(h.pPredV, 2);
});

test('logged prediction does not see the outcome (old tab, no startedAt)', async () => {
  freshStore();
  await acThenGrade({ peeked: false, hints: 0, failsBeforeAc: 0 });
  assert.equal(store.cards['two-sum'].history.at(-1).pPred, HONEST);
});

test('a resubmitted verdict id is stored once', async () => {
  freshStore();
  const msg = { kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Accepted', submissionId: '9', source: 'network' };
  await send(msg);
  const r = await send(msg);
  assert.ok(r.duplicate);
  assert.equal(store.pendingProblems['two-sum'].submissions.length, 1);
});

test('a verdict landing after you navigated away is filed under its own problem', async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'coin-change', title: 'Coin Change', url: null, status: 'Wrong Answer', submissionId: '10', source: 'network' });
  assert.equal(store.pendingProblems['coin-change'].submissions[0].status, 'Wrong Answer');
  assert.equal(store.pendingProblems['coin-change'].title, 'Coin Change');
});

test("the previous problem's title doesn't stick to a new card", async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'valid-anagram', title: 'Coin Change',
    url: 'https://leetcode.com/problems/valid-anagram/', status: 'Wrong Answer', submissionId: '11', source: 'network' });
  assert.equal(store.pendingProblems['valid-anagram'].title, 'Valid Anagram');
});

test('reviews are bucketed by LOCAL day', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  const d = new Date();
  const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  assert.equal(store.stats.byDay[key], 1);
});

test('Drill export: honest p_pred only, prior inputs included, abandoned attempts counted', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  // a pre-fix (v1) entry whose prediction had seen the outcome
  store.cards['two-sum'].history.unshift({ t: Date.now() - 9 * 86400e3, q: 4, pPred: 0.99 });
  // coin-change is tracked (rated long ago), so a later WA counts as an attempt
  store.cards['coin-change'] = { slug: 'coin-change', title: 'Coin Change', reps: 1, due: Date.now(), history: [{ t: Date.now() - 40 * 864e5, q: 4 }], submissions: [] };
  await send({ kind: 'recordSubmission', slug: 'coin-change', title: 'Coin Change', url: null, status: 'Wrong Answer', submissionId: '12', source: 'network' });
  const rows = (await send({ kind: 'exportDrill' })).jsonl.trim().split('\n').map(JSON.parse);
  const ts = rows.filter(r => r.item === 'lc:two-sum');
  assert.equal(ts[0].p_pred, null, 'v1 prediction dropped');
  assert.equal(ts.at(-1).p_pred, HONEST);
  assert.equal(ts.at(-1).difficulty, 'Easy');
  assert.equal(ts.at(-1).acRate, 55);
  assert.ok(rows.some(r => r.item === 'lc:coin-change' && r.kind === 'abandoned' && r.correct === 0));
});

// ---- history import ----
const T0 = Math.floor(Date.now() / 1000);
const PAGE = [
  { id: 1001, title: 'Two Sum', titleSlug: 'two-sum', statusDisplay: 'Accepted', lang: 'python3', runtime: '50 ms', memory: '17 MB', timestamp: String(T0 - 86400 * 200) },
  { id: 1002, title: 'Coin Change', titleSlug: 'coin-change', statusDisplay: 'Wrong Answer', lang: 'python3', runtime: 'N/A', memory: 'N/A', timestamp: String(T0 - 86400 * 100) },
  { id: 1003, title: 'Coin Change', titleSlug: 'coin-change', statusDisplay: 'Accepted', lang: 'python3', runtime: '900 ms', memory: '18 MB', timestamp: String(T0 - 86400 * 100 + 600) },
  { id: 1004, title: 'Valid Anagram', titleSlug: 'valid-anagram', statusDisplay: 'Accepted', lang: 'python3', runtime: '20 ms', memory: '16 MB', timestamp: String(T0 - 86400 * 10) },
];
const running = (extra = {}) => ({ running: true, perDay: 2, pages: 0, added: 0, newCards: 0, completedOnce: false, heartbeat: Date.now(), ...extra });
const localDay = (ms) => new Date(ms).toDateString();

test('history import: merges by submission id and never double-counts', async () => {
  freshStore();
  store.importState = running();
  let r = await send({ kind: 'importBatch', submissions: PAGE, cursor: { offset: 4 } });
  assert.ok(r.ok && !r.stop);
  r = await send({ kind: 'importBatch', submissions: PAGE, cursor: { offset: 8 } });   // same page again
  assert.equal(store.cards['coin-change'].submissions.length, 2);
  assert.equal(store.importState.added, 4);
  assert.equal(store.cards['coin-change'].title, 'Coin Change');
  assert.equal(store.cards['coin-change'].submissions[1].runtime, '900 ms');
  assert.equal(store.cards['coin-change'].submissions[0].runtime, undefined, "'N/A' isn't stored");
});

test('history import: reviews trickle in a few a day, oldest first, none due today', async () => {
  freshStore();
  store.importState = running();
  await send({ kind: 'importBatch', submissions: PAGE, cursor: {} });
  await send({ kind: 'importProgress', finished: true });
  const due = (s) => store.cards[s].due;
  for (const s of ['two-sum', 'coin-change', 'valid-anagram']) assert.ok(due(s) > Date.now(), `${s} due now`);
  assert.equal(localDay(due('two-sum')), localDay(due('coin-change')), 'perDay 2: first two share a day');
  assert.ok(due('valid-anagram') - due('two-sum') > 20 * 3600e3, 'third spills to the next day');
  assert.equal(store.importState.completedOnce, true);
  assert.equal(store.importState.scheduled, 3);
  const g = await send({ kind: 'getGoals' });
  assert.equal(g.totalSolved, 3, 'imported ACs count as solved');
});

test('history import: an already-graded problem keeps its own schedule', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  const before = store.cards['two-sum'].due;
  store.importState = running();
  await send({ kind: 'importBatch', submissions: PAGE, cursor: {} });
  await send({ kind: 'importProgress', finished: true });
  assert.equal(store.cards['two-sum'].due, before);
});

test('history import: a re-run stops at the first page it already has', async () => {
  freshStore();
  store.importState = running();
  await send({ kind: 'importBatch', submissions: PAGE, cursor: {} });
  await send({ kind: 'importProgress', finished: true });
  store.importState = running({ completedOnce: true });
  const r = await send({ kind: 'importBatch', submissions: PAGE, cursor: {} });
  assert.ok(r.stop, 'caught up');
  assert.equal(store.importState.running, false);
});

test('history import: logged out gives a clear message', async () => {
  freshStore();
  store.importState = running();
  await send({ kind: 'importProgress', error: 'not-logged-in' });
  assert.match(store.importState.error, /not logged in/);
  assert.equal(store.importState.running, false);
});

test('malformed card records cannot break goals, ranking or the due list', async () => {
  freshStore();
  const now = Date.now(), D = 864e5;
  store.cards = {
    'two-sum': { slug: 'two-sum', title: 'Two Sum', reps: 1, due: now - D, history: [{ t: now - 3 * D, q: 4 }], submissions: [{ t: now - 3 * D, status: 'Accepted' }] },
    'null-card': null,
    'no-slug': { title: 'No Slug', reps: 2, history: [{ t: now - 5 * D, q: 4 }] },
    'at-stamps': { slug: 'at-stamps', reps: 1, history: [{ at: now - 4 * D, q: 4 }], submissions: [{ at: now - 4 * D, status: 'Accepted' }] },
    'no-time': { slug: 'no-time', reps: 1, history: [{ q: 4 }], submissions: [{ status: 'Accepted' }] },
    'subs-object': { slug: 'subs-object', reps: 1, history: [{ t: now - 3 * D, q: 3 }], submissions: { a: 1 } },
    'bad-due': { slug: 'bad-due', reps: 1, due: 'soon', history: [{ t: now - 2 * D, q: 5 }] },
  };
  for (const kind of ['getGoals', 'getGoalView', 'getRecommendations', 'getDueList']) {
    const r = await send({ kind, id: null });
    assert.ok(r?.ok, `${kind}: ${r?.error}`);
  }
  const g = await send({ kind: 'getGoals' });
  assert.equal(g.totalSolved, 6, 'every recoverable card still counts');
  const v = await send({ kind: 'getGoalView', id: null });
  assert.ok(v.problems.every(p => Number.isFinite(p.t)), 'no NaN dates reach the growth view');
});

// ---- NeetCode ----
test('NeetCode sync: completions become undated solves, deduped, kept out of dated history', async () => {
  freshStore();
  let r = await send({ kind: 'neetcodeProgress', slugs: ['two-sum', 'contains-duplicate', 'Not A Slug!'], account: true });
  assert.ok(r.ok);
  assert.equal(r.added, 2);
  assert.equal(store.cards['contains-duplicate'].title, 'Contains Duplicate', 'title from the catalog');
  assert.ok(store.cards['two-sum'].due > Date.now(), 'joins reviews later, not due now');
  r = await send({ kind: 'neetcodeProgress', slugs: ['two-sum', 'contains-duplicate'], account: true });
  assert.equal(r.added, 0, 're-sync adds nothing');
  assert.equal(store.cards['two-sum'].submissions.length, 1);
  const g = await send({ kind: 'getGoals' });
  assert.equal(g.totalSolved, 2);
  const v = await send({ kind: 'getGoalView', id: null });
  assert.ok(v.problems.every(p => p.undated && p.t === 0), 'undated problems form the trunk');
  assert.equal(v.problems.find(p => p.slug === 'two-sum').nc, 'two-integer-sum', 'NeetCode page slug attached');
  const rows = (await send({ kind: 'exportDrill' })).jsonl.trim().split('\n').map(JSON.parse);
  assert.ok(rows.every(x => x.kind === 'neetcode' && x.correct === 1 && x.ts < 1));
});

test('NeetCode sync: a problem also solved on LeetCode keeps its real date', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  await send({ kind: 'neetcodeProgress', slugs: ['two-sum'], account: true });
  const v = await send({ kind: 'getGoalView', id: null });
  const p = v.problems.find(x => x.slug === 'two-sum');
  assert.ok(!p.undated && p.t > 0);
  const rows = (await send({ kind: 'exportDrill' })).jsonl.trim().split('\n').map(JSON.parse);
  assert.ok(!rows.some(x => x.kind === 'neetcode'), 'no extra undated attempt when a dated one exists');
});

test('getHome: goals and the active goal\'s view in one answer', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  const g = await send({ kind: 'saveGoal', goal: { name: 'Arrays', type: 'tags', tags: ['array'], target: 10 } });
  const h = await send({ kind: 'getHome' });
  assert.ok(h.ok && h.goals.ok && h.view.ok);
  assert.equal(h.goals.activeId, g.goal.id);
  assert.equal(h.view.goal.id, g.goal.id, 'the view is for the active goal');
  assert.ok(h.view.problems.some(p => p.slug === 'two-sum'));
  assert.ok(Array.isArray(h.view.phases));
});

// ---- prep phases ----
const solvedOn = (slug, d, id) => ({ slug, title: slug, site: 'leetcode', reps: 1, lapses: 0, due: Date.now() + 864e5,
  history: [{ t: d.getTime(), q: 4 }], submissions: [{ t: d.getTime(), status: 'Accepted', id }] });

test('prep phases: grouped by LOCAL first-solve day; outside a phase or undated is Unstructured', async () => {
  freshStore();
  let r = await send({ kind: 'savePhases', phases: [
    { name: 'Company B', from: '2026-08-24' },
    { name: 'Company A', from: '2026-03-02', to: '2026-04-17' },
  ] });
  assert.ok(r.ok, r.error);
  assert.deepEqual(r.phases.map(p => p.name), ['Company A', 'Company B'], 'kept in date order');
  store.cards = {
    'two-sum': solvedOn('two-sum', new Date(2026, 3, 17, 23, 30), '1'),        // last evening of A: still A
    'coin-change': solvedOn('coin-change', new Date(2026, 6, 1, 12), '2'),     // between phases
    'house-robber': solvedOn('house-robber', new Date(2026, 9, 20, 9), '3'),   // B, ongoing
    'contains-duplicate': solvedOn('contains-duplicate', new Date(2025, 0, 5, 12), '4'),
  };
  await send({ kind: 'neetcodeProgress', slugs: ['valid-anagram'], account: true });   // undated
  const v = await send({ kind: 'getGoalView', id: null });
  const ph = Object.fromEntries(v.problems.map(p => [p.slug, p.phase]));
  assert.equal(ph['two-sum'], 'company-a');
  assert.equal(ph['coin-change'], 'unstructured');
  assert.equal(ph['house-robber'], 'company-b');
  assert.equal(ph['contains-duplicate'], 'unstructured');
  assert.equal(ph['valid-anagram'], 'unstructured');
  assert.deepEqual(v.phases.map(p => [p.name, p.count]), [['Company A', 1], ['Company B', 1], ['Unstructured', 3]]);
});

test('prep phases: seeded from data/phases.local.json; a newer seed replaces unedited phases, never edited ones', async () => {
  freshStore();
  localSeed = { version: 1, phases: [{ name: 'Seeded', from: '2026-01-01', to: '2026-02-01' }] };
  try {
    let r = await send({ kind: 'getPhases' });
    assert.deepEqual(r.phases.map(p => p.name), ['Seeded']);
    localSeed = { version: 1, phases: [{ name: 'Same version', from: '2026-03-01' }] };
    r = await send({ kind: 'getPhases' });
    assert.deepEqual(r.phases.map(p => p.name), ['Seeded'], 'same seed version: stored phases stay');
    localSeed = { version: 2, phases: [{ name: 'Better guess', from: '2026-03-01' }] };
    r = await send({ kind: 'getPhases' });
    assert.deepEqual(r.phases.map(p => p.name), ['Better guess'], 'newer seed replaces an unedited list');
    await send({ kind: 'savePhases', phases: [{ name: 'Mine', from: '2026-04-01' }] });
    localSeed = { version: 3, phases: [{ name: 'Even newer', from: '2026-05-01' }] };
    r = await send({ kind: 'getPhases' });
    assert.deepEqual(r.phases.map(p => p.name), ['Mine'], 'edits are never overwritten');
    await send({ kind: 'savePhases', phases: [] });
    r = await send({ kind: 'getPhases' });
    assert.deepEqual(r.phases, [], 'deleting them all is respected too');
  } finally { localSeed = null; }
  freshStore();
  assert.deepEqual((await send({ kind: 'getPhases' })).phases, [], 'no seed file: no phases');
});

test('prep phases: bad rows are refused with a reason, nothing saved', async () => {
  freshStore();
  await send({ kind: 'savePhases', phases: [{ name: 'Keep', from: '2026-01-01' }] });
  const r = await send({ kind: 'savePhases', phases: [{ name: 'Oops', from: '2026-05-10', to: '2026-04-01' }] });
  assert.equal(r.ok, false);
  assert.match(r.error, /ends before it starts/);
  assert.deepEqual((await send({ kind: 'getPhases' })).phases.map(p => p.name), ['Keep']);
});

test('NeetCode 150 / 250 goal presets', async () => {
  freshStore();
  let r = await send({ kind: 'saveGoal', goal: { preset: 'nc150' } });
  assert.ok(r.ok, r.error);
  assert.equal(r.goal.target, 150);
  assert.equal(r.goal.name, 'NeetCode 150');
  r = await send({ kind: 'saveGoal', goal: { preset: 'nc250', name: 'Summer grind' } });
  assert.equal(r.goal.target, 250);
  assert.equal(r.goal.name, 'Summer grind');
});

// ---- rating bar: Esc keeps the solve but schedules no review ----
test('an Accepted problem is held until rated; Esc stores it with no review', async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Accepted', submissionId: '77', source: 'network', code: 'x' });
  assert.ok(!store.cards?.['two-sum'], 'no card on the verdict alone');
  assert.ok(store.pendingProblems['two-sum']);
  const r = await send({ kind: 'dismissRating', slug: 'two-sum' });
  assert.ok(r.stored);
  assert.ok(!store.pendingProblems['two-sum']);
  const c = store.cards['two-sum'];
  assert.ok(c.noReview, 'stored without a review');
  assert.equal(c.submissions.length, 1);
  assert.equal(c.history.length, 0, 'no grade was given');
  const g = await send({ kind: 'getGoals' });
  assert.equal(g.totalSolved, 1, 'it still counts as solved');
  const d = await send({ kind: 'getDueList' });
  assert.ok(!d.due.some(x => x.slug === 'two-sum') && !d.upcoming.some(x => x.slug === 'two-sum'), 'never in the review lists');
  const v = await send({ kind: 'getGoalView', id: null });
  assert.ok(v.problems.some(p => p.slug === 'two-sum'), 'and it grows on the graph');
});

test('a problem stored with no review joins reviews when you rate it later', async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Accepted', submissionId: '80', source: 'network' });
  await send({ kind: 'dismissRating', slug: 'two-sum' });
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Accepted', submissionId: '81', source: 'network' });
  await send({ kind: 'grade', slug: 'two-sum', title: 'Two Sum', quality: 4, durationMs: 1000, url: URL_TS, factors: { startedAt: Date.now() - 1000 } });
  const c = store.cards['two-sum'];
  assert.ok(!c.noReview);
  assert.equal(c.history.length, 1);
  assert.ok(c.due > Date.now() && c.due < Date.now() + 365 * 864e5, 'scheduled normally');
  assert.equal(c.submissions.length, 2);
});

test('Esc with nothing held is a no-op', async () => {
  freshStore();
  const r = await send({ kind: 'dismissRating', slug: 'coin-change' });
  assert.equal(r.stored, false);
  assert.ok(!store.cards?.['coin-change']);
});

test('rating a held problem turns it into a card with its submissions', async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Wrong Answer', submissionId: '78', source: 'network' });
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  const c = store.cards['two-sum'];
  assert.equal(c.submissions.length, 2, 'the WA and the AC both carried over');
  assert.equal(c.history.length, 1);
  assert.ok(!store.pendingProblems['two-sum']);
});

test('Esc on a problem you already track keeps its history', async () => {
  freshStore();
  await acThenGrade({ startedAt: Date.now() - 60e3 });
  await send({ kind: 'recordSubmission', slug: 'two-sum', title: 'Two Sum', url: URL_TS, status: 'Accepted', submissionId: '79', source: 'network' });
  const r = await send({ kind: 'dismissRating', slug: 'two-sum' });
  assert.ok(r.kept);
  assert.equal(store.cards['two-sum'].submissions.length, 2);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.warn = quiet;
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
