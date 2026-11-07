// Run with:  node tests/model.test.js
import assert from 'node:assert/strict';
import {
  replay, predict, recommend, similarity, recallBonus, priorBeta, pBase, thetaOf,
  calibration, mastery, mulberry32, GLOBAL, THETA0, NEAR,
} from '../extension/lib/model.js';
import { makeGoal, goalProgress, goalMatches, parseSlugList, BLIND_75 } from '../extension/lib/goals.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const H = 3600e3, D = 24 * H;
const NOW = Date.UTC(2026, 10, 7, 12);

const items = {
  'two-sum':        { slug: 'two-sum', title: 'Two Sum', difficulty: 'Easy', acRate: 55, tags: ['array', 'hash-table'] },
  'coin-change':    { slug: 'coin-change', title: 'Coin Change', difficulty: 'Medium', acRate: 45, tags: ['dynamic-programming'], similar: ['coin-change-ii', 'minimum-cost-for-tickets'] },
  'coin-change-ii': { slug: 'coin-change-ii', title: 'Coin Change II', difficulty: 'Medium', acRate: 60, tags: ['dynamic-programming'] },
  // fixture: an EASIER near variant (Drill's bank has these on purpose — E24 transfer runs easy -> hard)
  'minimum-cost-for-tickets': { slug: 'minimum-cost-for-tickets', title: 'Min Cost Tickets', difficulty: 'Easy', acRate: 75, tags: ['dynamic-programming', 'array'] },
  'word-ladder':    { slug: 'word-ladder', title: 'Word Ladder', difficulty: 'Hard', acRate: 40, tags: ['graph', 'breadth-first-search'] },
  'number-of-islands': { slug: 'number-of-islands', title: 'Number of Islands', difficulty: 'Medium', acRate: 60, tags: ['graph', 'depth-first-search'] },
  'premium-one':    { slug: 'premium-one', title: 'Premium', difficulty: 'Medium', acRate: 50, tags: ['graph'], paid: true },
};
const catalog = Object.values(items);

test('difficulty priors order Easy < Medium < Hard', () => {
  assert.ok(priorBeta(items['two-sum']) < priorBeta(items['coin-change']));
  assert.ok(priorBeta(items['coin-change']) < priorBeta(items['word-ladder']));
});

test('cold-start predictions are sensible for an average user', () => {
  const st = replay([], items);
  const e = predict(st, items['two-sum'], NOW).p;
  const h = predict(st, items['word-ladder'], NOW).p;
  assert.ok(e > 0.6 && e < 0.9, `easy ${e}`);
  assert.ok(h > 0.05 && h < 0.35, `hard ${h}`);
});

test('a solve raises topic ability, a miss lowers it', () => {
  const up = replay([{ slug: 'coin-change', ts: NOW - D, correct: 1, tags: ['dynamic-programming'] }], items);
  const dn = replay([{ slug: 'coin-change', ts: NOW - D, correct: 0, tags: ['dynamic-programming'] }], items);
  assert.ok(thetaOf(up, 'dynamic-programming') > THETA0);
  assert.ok(thetaOf(dn, 'dynamic-programming') < THETA0);
  assert.ok(thetaOf(up, GLOBAL) > THETA0);
});

test('E26 recall table: fail bonus vanishes after a day, pass bonus decays over a month', () => {
  assert.equal(recallBonus(0, 1800), 1.2);
  assert.equal(recallBonus(0, 2 * 86400), 0);
  assert.equal(recallBonus(1, 3 * 86400), 0.35);
  assert.equal(recallBonus(1, 60 * 86400), 0);
});

test('E17c: a repeat is predicted higher but does NOT inflate ability', () => {
  const a = { slug: 'coin-change', ts: NOW - 2 * H, correct: 1, tags: ['dynamic-programming'] };
  const st = replay([a], items);
  const pr = predict(st, items['coin-change'], NOW);
  assert.ok(pr.recall > 0 && pr.p > pr.pBase, 'recall bonus applied to prediction');
  // Ability after the repeat moves from p_base, identically to a fresh item of equal p_base.
  const st2 = replay([a, { ...a, ts: NOW }], items);
  const expected = pBase(st, 'coin-change', ['dynamic-programming']);
  assert.ok(expected < pr.p, 'update reference is the un-boosted p_base');
  assert.ok(Number.isFinite(thetaOf(st2, 'dynamic-programming')));
});

test('similarity: curated similar-question = 1, tag overlap stays below NEAR', () => {
  assert.equal(similarity(items['coin-change'], items['coin-change-ii']), 1);
  assert.equal(similarity(items['coin-change-ii'], items['coin-change']), 1, 'symmetric');
  const tagOnly = similarity(items['number-of-islands'], items['word-ladder']);
  assert.ok(tagOnly > 0 && tagOnly < NEAR);
});

test('recommender skips solved, premium, and the failed item inside its day', () => {
  const st = replay([
    { slug: 'two-sum', ts: NOW - 5 * D, correct: 1, tags: ['array', 'hash-table'] },
    { slug: 'coin-change', ts: NOW - 3 * H, correct: 0, tags: ['dynamic-programming'] },
  ], items);
  const recs = recommend({ st, catalog, known: items, now: NOW, rng: mulberry32(1), k: 10 });
  const slugs = recs.map(r => r.item.slug);
  assert.ok(!slugs.includes('two-sum'), 'solved goes to SR, not recommendations');
  assert.ok(!slugs.includes('premium-one'), 'premium excluded');
  assert.ok(!slugs.includes('coin-change'), 'failed item waits a day');
});

test('E24: no near variant within the hour of a miss; preferred from 1h to 7d', () => {
  const missedAt = (ago) => replay([{ slug: 'coin-change', ts: NOW - ago, correct: 0, tags: ['dynamic-programming'] }], items);
  const hot = recommend({ st: missedAt(20 * 60e3), catalog, known: items, now: NOW, rng: mulberry32(2), k: 10 });
  assert.ok(!hot.some(r => r.item.slug === 'coin-change-ii'), 'variant blocked within the hour');
  const warm = recommend({ st: missedAt(6 * H), catalog, known: items, now: NOW, rng: mulberry32(2), k: 10 });
  const v = warm.find(r => r.item.slug === 'minimum-cost-for-tickets');
  assert.ok(v && v.variant, 'the easy near variant is offered once due');
  assert.match(v.reason, /variant of Coin Change/);
  // ...but a near variant you'd probably fail right now is NOT flagged (p < 0.6).
  const hard = warm.find(r => r.item.slug === 'coin-change-ii');
  assert.ok(!hard || !hard.variant, 'too-hard variant not pushed as a retry');
});

test('goal focus pulls recommendations onto the goal', () => {
  const st = replay([], items);
  const goal = { tags: ['graph'], matches: (it) => (it.tags || []).includes('graph') };
  const recs = recommend({ st, catalog, known: items, now: NOW, rng: mulberry32(3), goal, k: 2 });
  assert.ok(recs.every(r => r.onGoal), JSON.stringify(recs.map(r => r.item.slug)));
});

test('recommendations are stable for a fixed seed', () => {
  const st = replay([], items);
  const a = recommend({ st, catalog, known: items, now: NOW, rng: mulberry32(9) }).map(r => r.item.slug);
  const b = recommend({ st, catalog, known: items, now: NOW, rng: mulberry32(9) }).map(r => r.item.slug);
  assert.deepEqual(a, b);
});

test('calibration and mastery summaries', () => {
  const att = Array.from({ length: 6 }, (_, i) => ({ slug: 'two-sum', ts: NOW - i * D, correct: i % 2, pPred: 0.5, tags: ['array'] }));
  const c = calibration(att);
  assert.equal(c.n, 6);
  assert.ok(Math.abs(c.gap) < 1e-9);
  const m = mastery(replay(att, items));
  assert.ok(m.length >= 1 && m.every(r => r.concept !== GLOBAL));
});

// ---- goals ----
test('Blind 75 has 75 unique slugs', () => {
  assert.equal(new Set(BLIND_75).size, 75);
});

test('goal progress counts distinct matching solves, with pace to deadline', () => {
  const g = makeGoal({ name: 'Google', type: 'tags', tags: ['graph'], target: 10, deadline: '2026-11-17' });
  const solved = [
    { slug: 'number-of-islands', tags: ['graph'] },
    { slug: 'word-ladder', tags: ['graph'] },
    { slug: 'two-sum', tags: ['array'] },
  ];
  const p = goalProgress(g, solved, NOW);
  assert.equal(p.done, 2);
  assert.equal(p.remaining, 8);
  assert.ok(p.daysLeft >= 10 && p.daysLeft <= 11);
  assert.ok(p.perDay > 0.7 && p.perDay < 0.9);
});

test('list goals target their own length; parseSlugList reads URLs and slugs', () => {
  const slugs = parseSlugList('https://leetcode.com/problems/two-sum/ coin-change, https://leetcode.com/problems/word-ladder/description/');
  assert.deepEqual(slugs, ['two-sum', 'coin-change', 'word-ladder']);
  const g = makeGoal({ name: 'Mine', type: 'list', slugs });
  assert.equal(g.target, 3);
  assert.ok(goalMatches(g, 'coin-change'));
  assert.ok(!goalMatches(g, 'house-robber'));
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
