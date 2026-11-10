// Run with:  node tests/subtopics.test.js
// Subtopics split an opened topic by LeetCode's finer tags. These pin down
// where well-known problems land (their real catalog tags).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SUBTOPICS, subtopicOf, subtopicsMatching, subtopicList, subtopicTags } from '../extension/lib/subtopics.js';
import { TOPIC_KEYS, primaryTopic } from '../extension/lib/topics.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const cat = JSON.parse(readFileSync(new URL('../extension/data/catalog.json', import.meta.url)));
const nc = JSON.parse(readFileSync(new URL('../extension/data/neetcode.json', import.meta.url)));
const tagsOf = Object.fromEntries(cat.rows.map(r => [r.s, r.g]));
const ncOf = Object.fromEntries(nc.rows.map(r => [r.s, r.p]));
const where = (slug) => { const t = primaryTopic(tagsOf[slug], ncOf[slug]); return `${t}/${subtopicOf(t, tagsOf[slug])}`; };

test('every topic has subtopics, each ending in its core bucket', () => {
  for (const t of TOPIC_KEYS) {
    const list = SUBTOPICS[t];
    assert.ok(list?.length >= 2, `${t} has subtopics`);
    assert.equal(list[list.length - 1].any, null, `${t} ends in a catch-all`);
    assert.equal(new Set(list.map(x => x.key)).size, list.length, `${t} keys are unique`);
  }
});

test('trees: LCA, BSTs, tree DP, construction, level order, DFS', () => {
  assert.equal(where('lowest-common-ancestor-of-a-binary-tree'), 'trees/lca');
  assert.equal(where('lowest-common-ancestor-of-a-binary-search-tree'), 'trees/lca');
  assert.equal(where('validate-binary-search-tree'), 'trees/bst');
  assert.equal(where('kth-smallest-element-in-a-bst'), 'trees/bst');
  assert.equal(where('binary-tree-maximum-path-sum'), 'trees/dp');
  assert.equal(where('serialize-and-deserialize-binary-tree'), 'trees/design');
  assert.equal(where('construct-binary-tree-from-preorder-and-inorder-traversal'), 'trees/build');
  assert.equal(where('binary-tree-level-order-traversal'), 'trees/bfs');
  assert.equal(where('maximum-depth-of-binary-tree'), 'trees/core', 'tagged both DFS and BFS: not "level order"');
  assert.equal(where('diameter-of-binary-tree'), 'trees/dp', 'LeetCode tags it dp-on-trees: heights combined at each node');
  assert.equal(where('balanced-binary-tree'), 'trees/core');
});

test('graphs and DP split the way you would study them', () => {
  assert.equal(where('course-schedule'), 'graphs/topo');
  assert.equal(where('number-of-islands'), 'graphs/grids', 'a grid beats its union-find tag');
  assert.equal(where('redundant-connection'), 'graphs/union-find');
  assert.equal(where('word-ladder'), 'graphs/bfs');
  assert.equal(where('network-delay-time'), 'advanced-graphs/shortest');
  assert.equal(where('min-cost-to-connect-all-points'), 'advanced-graphs/mst');
  assert.equal(where('reconstruct-itinerary'), 'advanced-graphs/euler');
  assert.equal(where('partition-equal-subset-sum'), 'dp-1d/knapsack');
  assert.equal(where('longest-increasing-subsequence'), 'dp-1d/lis');
  assert.equal(where('word-break'), 'dp-1d/strings');
  assert.equal(where('house-robber'), 'dp-1d/core');
  assert.equal(where('longest-common-subsequence'), 'dp-2d/strings');
  assert.equal(where('coin-change-ii'), 'dp-2d/knapsack');
});

test('stacks, lists and heaps', () => {
  assert.equal(where('daily-temperatures'), 'stack/monotonic');
  assert.equal(where('min-stack'), 'stack/design');
  assert.equal(where('valid-parentheses'), 'stack/parsing');
  assert.equal(where('lru-cache'), 'linked-list/design');
  assert.equal(where('linked-list-cycle'), 'linked-list/fast-slow');
  assert.equal(where('merge-k-sorted-lists'), 'linked-list/merging');
  assert.equal(where('find-median-from-data-stream'), 'heap/streams');
  assert.equal(where('kth-largest-element-in-an-array'), 'heap/top-k');
  assert.equal(where('task-scheduler'), 'heap/scheduling');
});

test('subtopicsMatching lists every fit, its own first; tags for the recommender', () => {
  const tags = tagsOf['lowest-common-ancestor-of-a-binary-search-tree'];
  const all = subtopicsMatching('trees', tags);
  assert.equal(all[0], 'lca');
  assert.ok(all.includes('bst'));
  assert.deepEqual(subtopicTags('trees', 'bst'), ['binary-search-tree']);
  assert.ok(subtopicTags('trees', 'core').includes('tree'), 'the core bucket asks for the topic itself');
  assert.equal(subtopicList('trees')[0].label, 'ancestors (LCA)');
  assert.equal(subtopicOf('no-such-topic', ['array']), 'core');
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
