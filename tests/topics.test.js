// Run with:  node tests/topics.test.js
// Topic arcs (lib/topics.js): NeetCode's category when it lists the problem,
// else LeetCode tags, ranked so the usual misfilings can't happen.
import assert from 'node:assert/strict';
import { primaryTopic, topicTags, tagTopic, TOPIC_KEYS } from '../extension/lib/topics.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });

test('tree problems are trees, not graphs, despite their DFS/BFS tags', () => {
  assert.equal(primaryTopic(['tree', 'depth-first-search', 'breadth-first-search', 'binary-tree']), 'trees');        // Invert Binary Tree
  assert.equal(primaryTopic(['tree', 'depth-first-search', 'binary-search-tree', 'binary-tree']), 'trees');          // Validate BST
  assert.equal(primaryTopic(['array', 'depth-first-search', 'breadth-first-search', 'union-find', 'matrix']), 'graphs'); // Number of Islands
});

test('linked lists beat two pointers; tries beat backtracking; DP on a grid is 2-D DP', () => {
  assert.equal(primaryTopic(['hash-table', 'linked-list', 'two-pointers']), 'linked-list');                // Linked List Cycle
  assert.equal(primaryTopic(['array', 'string', 'backtracking', 'trie', 'matrix']), 'tries');              // Word Search II
  assert.equal(primaryTopic(['array', 'dynamic-programming', 'matrix']), 'dp-2d');                        // Minimum Path Sum
  assert.equal(primaryTopic(['array', 'dynamic-programming']), 'dp-1d');                                  // House Robber
  assert.equal(primaryTopic(['graph', 'heap-priority-queue', 'shortest-path']), 'advanced-graphs');      // Network Delay Time
});

test('NeetCode\'s own category wins when it lists the problem; its JS course is ignored', () => {
  assert.equal(primaryTopic(['array', 'sorting'], 'Intervals'), 'intervals');                              // Merge Intervals
  assert.equal(primaryTopic(['dynamic-programming', 'tree', 'depth-first-search', 'binary-tree'], 'Trees'), 'trees');
  assert.equal(primaryTopic(['array', 'hash-table'], 'JavaScript'), 'arrays');
  assert.equal(primaryTopic([], null), 'other');
});

test('every topic has tags for the recommender, and tags map back to real topics', () => {
  for (const k of TOPIC_KEYS) if (!['intervals', 'other'].includes(k)) assert.ok(topicTags(k).length, k);
  assert.equal(tagTopic('binary-tree'), 'trees');
  assert.ok(topicTags('dp-2d').includes('matrix'));
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
