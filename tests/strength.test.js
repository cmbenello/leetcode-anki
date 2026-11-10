// Run with:  node tests/strength.test.js
// Topic strength: the predictor's chance on a typical Medium, per topic and subtopic.
import assert from 'node:assert/strict';
import { topicStrength, cleanScore, CONFIDENT_N } from '../extension/lib/strength.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
// a small made-up catalog: trees (BST and plain) and graphs, Easy/Medium/Hard
const D = ['Easy', 'Medium', 'Medium', 'Medium', 'Hard'];
const rows = [];
for (let i = 0; i < 40; i++) rows.push({ slug: `tree-${i}`, tags: i % 2 ? ['tree', 'binary-search-tree'] : ['tree'], difficulty: D[i % 5], acRate: 50 });
for (let i = 0; i < 40; i++) rows.push({ slug: `graph-${i}`, tags: ['graph'], difficulty: D[i % 5], acRate: 50 });
rows.push({ slug: 'paid-1', tags: ['graph'], difficulty: 'Medium', acRate: 50, paid: true });
const items = Object.fromEntries(rows.map(r => [r.slug, r]));
const topicOf = (x) => (x.tags.includes('tree') ? 'trees' : 'graphs');
const subOf = (t, x) => (t === 'trees' && x.tags.includes('binary-search-tree') ? 'bst' : 'core');
const att = (slug, i, correct, extra = {}) => ({ slug, ts: 1e12 + i * 3600e3, correct, tags: items[slug].tags, ...extra });

test('solving a topic raises it; failing a topic lowers it', () => {
  const attempts = [];
  for (let i = 0; i < 12; i++) attempts.push(att(`tree-${i}`, i, 1));
  for (let i = 0; i < 12; i++) attempts.push(att(`graph-${i}`, 20 + i, i % 3 === 0 ? 1 : 0));
  const s = topicStrength({ attempts, items, rows, topicOf, subOf });
  assert.ok(s.topics.trees.p > 0.7, `trees ${s.topics.trees.p}`);
  assert.ok(s.topics.graphs.p < 0.45, `graphs ${s.topics.graphs.p}`);
  assert.equal(s.topics.trees.n, 12);
  assert.ok(s.topics.trees.sure);
});

test('no history: everything sits at the prior, marked as a guess', () => {
  const s = topicStrength({ attempts: [], items, rows, topicOf, subOf });
  assert.ok(Math.abs(s.topics.trees.p - s.topics.graphs.p) < 0.01);
  assert.ok(s.topics.trees.p > 0.35 && s.topics.trees.p < 0.6, `a Medium at the prior: ${s.topics.trees.p}`);
  assert.equal(s.topics.trees.n, 0);
  assert.equal(s.topics.trees.sure, false);
});

test('subtopics move on their own evidence', () => {
  const attempts = [];
  for (let i = 1; i < 16; i += 2) attempts.push(att(`tree-${i}`, i, 1));       // BSTs: all solved
  for (let i = 0; i < 16; i += 2) attempts.push(att(`tree-${i}`, 30 + i, 0));  // plain trees: all failed
  const s = topicStrength({ attempts, items, rows, topicOf, subOf });
  assert.ok(s.subs.trees.bst.p > s.subs.trees.core.p + 0.2, JSON.stringify(s.subs.trees));
  assert.equal(s.subs.trees.bst.n, 8);
  assert.ok(!s.subs.graphs.core.sure && CONFIDENT_N > 0);
});

test('a hard-felt solve counts for less than an easy one (partial credit)', () => {
  const easy = [], hard = [];
  for (let i = 0; i < 6; i++) { easy.push(att(`tree-${i}`, i, 1, { perceived: 1 })); hard.push(att(`tree-${i}`, i, 1, { perceived: 4 })); }
  const a = topicStrength({ attempts: easy, items, rows, topicOf, subOf }), b = topicStrength({ attempts: hard, items, rows, topicOf, subOf });
  assert.ok(a.topics.trees.p > b.topics.trees.p);
});

test('cleanScore: first try is full credit; retries, a hard feel and hints take some off', () => {
  assert.equal(cleanScore({ correct: 1 }), 1);
  assert.equal(cleanScore({ correct: 1, fails: 0 }), 1);
  assert.ok(cleanScore({ correct: 1, fails: 1 }) < 1);
  assert.ok(cleanScore({ correct: 1, fails: 3 }) < cleanScore({ correct: 1, fails: 1 }));
  assert.equal(cleanScore({ correct: 1, fails: 9 }), cleanScore({ correct: 1, fails: 3 }), 'capped');
  assert.ok(cleanScore({ correct: 1, perceived: 4 }) < cleanScore({ correct: 1, perceived: 1 }));
  assert.ok(cleanScore({ correct: 1, hints: 2 }) < 1);
  assert.equal(cleanScore({ correct: 0, fails: 0 }), 0);
});

test('strength is about how cleanly, not how many: 10 first-try solves beat 30 that each needed retries', () => {
  const attempts = [];
  for (let i = 0; i < 10; i++) attempts.push(att(`tree-${i}`, i, 1, { fails: 0 }));
  for (let i = 0; i < 30; i++) attempts.push(att(`graph-${i % 40}`, 20 + i, 1, { fails: 2 }));
  const s = topicStrength({ attempts, items, rows, topicOf, subOf });
  assert.ok(s.topics.trees.p > s.topics.graphs.p, `clean ${s.topics.trees.p} vs many ${s.topics.graphs.p}`);
});

test('premium problems are left out', () => {
  const s = topicStrength({ attempts: [], items, rows: [rows.at(-1)], topicOf, subOf });
  assert.deepEqual(s.topics, {});
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
