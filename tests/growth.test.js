// Run with:  node tests/growth.test.js
// The growth view's layout is pure; these pin down how problems are placed and linked.
import assert from 'node:assert/strict';
import { layout, relate, primaryTopic, difficultyScore } from '../extension/newtab/growth.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const DAY = 864e5, NOW = Date.UTC(2026, 10, 7);
const P = (slug, tags, extra = {}, i = 0) => ({ slug, title: slug, tags, difficulty: 'Medium', acRate: 50, t: NOW - (500 - i) * DAY, ...extra });
const OPTS = { width: 1300, height: 940, target: 400, now: NOW };

// ---- relatedness ----
test('relate: a LeetCode similar question beats shared topics', () => {
  const a = P('coin-change', ['dynamic-programming', 'array'], { similar: ['coin-change-ii'] });
  const b = P('coin-change-ii', ['dynamic-programming', 'array']);
  const c = P('house-robber', ['dynamic-programming', 'array']);
  assert.equal(relate(b, a).via, 'similar');
  assert.ok(relate(b, a).score > relate(b, c).score);
});

test('relate: same NeetCode pattern adds weight; no shared tags reads as "same topic"', () => {
  const a = P('x', ['graph', 'breadth-first-search'], { pattern: 'Graphs' });
  const b = P('y', ['graph', 'depth-first-search'], { pattern: 'Graphs' });
  assert.equal(relate(a, b).via, 'pattern');
  assert.equal(relate(P('z', ['depth-first-search']), P('w', ['breadth-first-search'])).via, 'topic');
});

test('difficulty score: Easy < Medium < Hard, and acceptance rate refines it', () => {
  assert.ok(difficultyScore({ difficulty: 'Easy', acRate: 65 }) < difficultyScore({ difficulty: 'Medium', acRate: 50 }));
  assert.ok(difficultyScore({ difficulty: 'Medium', acRate: 50 }) < difficultyScore({ difficulty: 'Hard', acRate: 35 }));
  assert.ok(difficultyScore({ difficulty: 'Medium', acRate: 30 }) > difficultyScore({ difficulty: 'Medium', acRate: 70 }));
});

// ---- links ----
test('links: a problem builds on its similar question, not just the most recent one', () => {
  const probs = [
    P('coin-change', ['dynamic-programming'], { similar: ['coin-change-ii'] }, 0),
    P('house-robber', ['dynamic-programming'], {}, 1),
    P('climbing-stairs', ['dynamic-programming'], {}, 2),
    P('coin-change-ii', ['dynamic-programming'], {}, 3),
  ];
  const n = Object.fromEntries(layout(probs, OPTS).nodes.map(x => [x.slug, x]));
  assert.equal(n['coin-change-ii'].parentTitle, 'coin-change');
  assert.equal(n['coin-change-ii'].via, 'similar');
  assert.equal(n['coin-change'].parentTitle, null);
});

test('links: ties go to the most recent earlier problem', () => {
  const L = layout([P('a', ['tree'], {}, 0), P('b', ['tree'], {}, 1), P('c', ['tree'], {}, 2)], OPTS);
  assert.equal(L.nodes.find(x => x.slug === 'c').parentTitle, 'b');
});

test('cross-topic links: shared second topic, and similar questions across topics', () => {
  const probs = [
    P('binary-search', ['binary-search', 'array'], {}, 0),
    P('koko-eating-bananas', ['binary-search', 'array'], {}, 1),
    P('house-robber', ['dynamic-programming', 'array'], {}, 2),
    P('russian-doll-envelopes', ['dynamic-programming', 'binary-search', 'array'], {}, 3),
    P('two-sum', ['array', 'hash-table'], { similar: ['house-robber'] }, 4),
  ];
  const L = layout(probs, OPTS);
  const pairs = L.crossLinks.map(c => [c.a.slug, c.b.slug].sort().join('|'));
  assert.ok(pairs.some(p => p.includes('russian-doll-envelopes')), JSON.stringify(pairs));
  assert.ok(pairs.includes('house-robber|two-sum'));
  assert.ok(L.nodes.find(x => x.slug === 'russian-doll-envelopes').alsoIn.includes('binary-search'));
  for (const c of L.crossLinks) assert.notEqual(c.a.sec, c.b.sec);
});

// ---- rings ----
test('rings: easy inside, medium in the middle, hard outside', () => {
  const diffs = ['Easy', 'Medium', 'Hard'];
  const probs = Array.from({ length: 120 }, (_, i) => P(`q${i}`, [['array'], ['graph'], ['dynamic-programming']][i % 3], { difficulty: diffs[(i * 7) % 3] }, i));
  const L = layout(probs, OPTS);
  for (const nd of L.nodes) {
    assert.ok(Math.abs(nd.r - L.rings[nd.ring]) < 1e-6, `${nd.slug} off its ring`);
    assert.equal(nd.ring, { Easy: 0, Medium: 1, Hard: 2 }[nd.difficulty]);
  }
  assert.ok(L.rings[0] < L.rings[1] && L.rings[1] < L.rings[2]);
});

test('rings: a problem sits beside the one it built on, even on another ring', () => {
  const probs = [
    P('coin-change', ['dynamic-programming'], { similar: ['coin-change-ii'] }, 0),
    ...Array.from({ length: 30 }, (_, i) => P(`dp${i}`, ['dynamic-programming'], {}, i + 1)),
    P('coin-change-ii', ['dynamic-programming'], { difficulty: 'Hard' }, 40),
  ];
  const L = layout(probs, OPTS);
  const a = L.nodes.find(x => x.slug === 'coin-change'), b = L.nodes.find(x => x.slug === 'coin-change-ii');
  const sec = L.sectors.find(s => s.topic === 'dynamic-programming');
  const step = sec.span / sec.count;
  assert.ok(Math.abs(a.ang - b.ang) <= step * 1.01, `angular gap ${(Math.abs(a.ang - b.ang) / step).toFixed(1)} slots`);
});

test('rings: one layer per ring — dense topics jam together, never stack', () => {
  const probs = Array.from({ length: 400 }, (_, i) => P(`p${i}`, ['dynamic-programming'], { difficulty: 'Medium' }, i));
  const L = layout(probs, { ...OPTS, target: 400 });
  for (const nd of L.nodes) assert.ok(Math.abs(nd.r - L.rings[1]) < 1e-6, 'every Medium sits exactly on the medium ring');
});

test('layout of 600 problems is fast', () => {
  const tags = [['dynamic-programming'], ['graph'], ['array', 'two-pointers'], ['tree'], ['binary-search'], ['string']];
  const probs = Array.from({ length: 600 }, (_, i) => P(`p${i}`, tags[i % tags.length], { difficulty: ['Easy', 'Medium', 'Hard'][i % 3] }, i));
  const t0 = performance.now();
  layout(probs, { ...OPTS, target: 600 });
  const ms = performance.now() - t0;
  assert.ok(ms < 400, `${ms.toFixed(0)} ms`);
  console.log(`       (600 problems: ${ms.toFixed(0)} ms)`);
  assert.equal(primaryTopic(['array', 'dynamic-programming']), 'dynamic-programming');
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
