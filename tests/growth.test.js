// Run with:  node tests/growth.test.js
// The growth view's layout is pure; these pin down how problems are linked.
import assert from 'node:assert/strict';
import { layout, relate, primaryTopic, colonize, branchWidth } from '../extension/newtab/growth.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const DAY = 864e5, NOW = Date.UTC(2026, 10, 7);
const P = (slug, tags, extra = {}, i = 0) => ({ slug, title: slug, tags, t: NOW - (100 - i) * DAY, ...extra });

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
  const c = P('z', ['depth-first-search']);
  const d = P('w', ['breadth-first-search']);
  assert.equal(relate(a, b).via, 'pattern');
  assert.equal(relate(c, d).via, 'topic');
});

test('layout: a problem grows from its similar question, not the most recent one', () => {
  const probs = [
    P('coin-change', ['dynamic-programming'], { similar: ['coin-change-ii'] }, 0),
    P('house-robber', ['dynamic-programming'], {}, 1),
    P('climbing-stairs', ['dynamic-programming'], {}, 2),
    P('coin-change-ii', ['dynamic-programming'], {}, 3),
  ];
  const L = layout(probs, { width: 1000, height: 800, target: 10, now: NOW });
  const n = Object.fromEntries(L.nodes.map(x => [x.slug, x]));
  assert.equal(n['coin-change-ii'].parentTitle, 'coin-change');
  assert.equal(n['coin-change-ii'].via, 'similar');
  assert.equal(n['coin-change'].parentTitle, null, 'first in its topic starts at the centre');
});

test('layout: ties go to the most recent earlier problem', () => {
  const probs = [P('a', ['tree'], {}, 0), P('b', ['tree'], {}, 1), P('c', ['tree'], {}, 2)];
  const L = layout(probs, { width: 1000, height: 800, target: 10, now: NOW });
  assert.equal(L.nodes[2].parentTitle, 'b');
});

test('layout: links stay inside a topic and always point outward', () => {
  const probs = [
    P('two-sum', ['array', 'hash-table'], {}, 0),
    P('coin-change', ['dynamic-programming'], { similar: ['two-sum'] }, 1),   // cross-topic "similar" is ignored
    P('house-robber', ['dynamic-programming'], {}, 2),
  ];
  const L = layout(probs, { width: 1000, height: 800, target: 10, now: NOW });
  const n = Object.fromEntries(L.nodes.map(x => [x.slug, x]));
  assert.equal(n['coin-change'].parentTitle, null);
  assert.equal(n['house-robber'].parentTitle, 'coin-change');
  assert.equal(primaryTopic(['array', 'dynamic-programming']), 'dynamic-programming');
});

test('cross-topic links: shared second topic, and similar questions across topics', () => {
  const probs = [
    P('binary-search', ['binary-search', 'array'], {}, 0),
    P('koko-eating-bananas', ['binary-search', 'array'], {}, 1),
    P('house-robber', ['dynamic-programming', 'array'], {}, 2),
    // a DP problem that is also a binary-search problem
    P('russian-doll-envelopes', ['dynamic-programming', 'binary-search', 'array'], {}, 3),
    P('two-sum', ['array', 'hash-table'], { similar: ['house-robber'] }, 4),   // contrived cross-topic similar
  ];
  const L = layout(probs, { width: 1000, height: 800, target: 10, now: NOW });
  const pairs = L.crossLinks.map(c => [c.a.slug, c.b.slug].sort().join('|'));
  assert.ok(pairs.some(p => p.includes('russian-doll-envelopes') && (p.includes('koko') || p.includes('binary-search|'))),
    `expected a DP<->binary-search link, got ${JSON.stringify(pairs)}`);
  assert.ok(pairs.includes('house-robber|two-sum'), 'similar question across topics links too');
  const rde = L.nodes.find(x => x.slug === 'russian-doll-envelopes');
  assert.ok(rde.alsoIn.includes('binary-search'));
  for (const c of L.crossLinks) assert.notEqual(c.a.sec, c.b.sec, 'cross links only join different topics');
});

// ---- space colonization ----
const ring = (n, r0, r1, a0, a1, seed = 1) => Array.from({ length: n }, (_, i) => {
  const f = ((i * 7919 + seed) % 997) / 997, g = ((i * 104729 + seed) % 991) / 991;
  const r = r0 + (r1 - r0) * f, a = a0 + (a1 - a0) * g;
  return { x: 500 + Math.cos(a) * r, y: 400 + Math.sin(a) * r };
});

test('colonize: every problem is reached and the tree is connected', () => {
  const pts = ring(120, 90, 330, -0.6, 0.6);
  const t = colonize(pts, { x: 586, y: 400 }, { D: 6, dk: 10, maxIter: 400 });
  assert.equal(t.leaf.length, 120);
  for (let i = 0; i < 120; i++) assert.ok(t.leaf[i] >= 0 && t.leaf[i] < t.xs.length);
  for (let j = 1; j < t.xs.length; j++) assert.ok(t.par[j] >= 0 && t.par[j] < j, 'parents precede children');
  assert.equal(t.feeds[0], 120, 'the root feeds every problem');
});

test('pipe model: branches never get thicker toward the tips', () => {
  const t = colonize(ring(80, 90, 330, -0.5, 0.5, 3), { x: 586, y: 400 }, { D: 6, dk: 10, maxIter: 400 });
  for (let j = 1; j < t.xs.length; j++) assert.ok(t.feeds[t.par[j]] >= t.feeds[j]);
  assert.ok(branchWidth(100) > branchWidth(4) && branchWidth(4) > branchWidth(1));
});

test('not forky: two nearby problems share most of their limb', () => {
  const pts = [{ x: 820, y: 395 }, { x: 822, y: 410 }];
  const t = colonize(pts, { x: 586, y: 400 }, { D: 6, dk: 10, maxIter: 400 });
  const path = (j) => { const out = []; while (j >= 0) { out.push(j); j = t.par[j]; } return new Set(out); };
  const a = path(t.leaf[0]), b = path(t.leaf[1]);
  const shared = [...a].filter(x => b.has(x)).length;
  assert.ok(shared / Math.max(a.size, b.size) > 0.8, `shared ${shared} of ${Math.max(a.size, b.size)}`);
});

test('layout of 600 problems grows in well under a second', () => {
  const tags = [['dynamic-programming'], ['graph'], ['array', 'two-pointers'], ['tree'], ['binary-search'], ['string']];
  const probs = Array.from({ length: 600 }, (_, i) => P(`p${i}`, tags[i % tags.length], {}, i));
  const t0 = performance.now();
  layout(probs, { width: 1400, height: 1000, target: 600, now: NOW });
  const ms = performance.now() - t0;
  assert.ok(ms < 800, `${ms.toFixed(0)} ms`);
  console.log(`       (600 problems: ${ms.toFixed(0)} ms)`);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
