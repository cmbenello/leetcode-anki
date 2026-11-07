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
globalThis.fetch = async () => ({ ok: false, status: 503, json: async () => ({}), text: async () => '' });
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
  assert.equal(store.cards['two-sum'].submissions.length, 1);
});

test('a verdict landing after you navigated away is filed under its own problem', async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'coin-change', title: 'Coin Change', url: null, status: 'Wrong Answer', submissionId: '10', source: 'network' });
  assert.equal(store.cards['coin-change'].submissions[0].status, 'Wrong Answer');
  assert.equal(store.cards['coin-change'].title, 'Coin Change');
});

test("the previous problem's title doesn't stick to a new card", async () => {
  freshStore();
  await send({ kind: 'recordSubmission', slug: 'valid-anagram', title: 'Coin Change',
    url: 'https://leetcode.com/problems/valid-anagram/', status: 'Wrong Answer', submissionId: '11', source: 'network' });
  assert.equal(store.cards['valid-anagram'].title, 'Valid Anagram');
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
  await send({ kind: 'recordSubmission', slug: 'coin-change', title: 'Coin Change', url: null, status: 'Wrong Answer', submissionId: '12', source: 'network' });
  const rows = (await send({ kind: 'exportDrill' })).jsonl.trim().split('\n').map(JSON.parse);
  const ts = rows.filter(r => r.item === 'lc:two-sum');
  assert.equal(ts[0].p_pred, null, 'v1 prediction dropped');
  assert.equal(ts.at(-1).p_pred, HONEST);
  assert.equal(ts.at(-1).difficulty, 'Easy');
  assert.equal(ts.at(-1).acRate, 55);
  assert.ok(rows.some(r => r.item === 'lc:coin-change' && r.kind === 'abandoned' && r.correct === 0));
});

let failed = 0;
for (const { name, fn } of tests) {
  try { await fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.warn = quiet;
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
