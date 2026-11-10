// Subtopics: how a topic splits when you open it on the graph.
//
// LeetCode has no official subcategories, but its newer fine-grained tags say
// what kind of problem something is within a topic: binary-search-tree,
// lowest-common-ancestor and dp-on-trees inside trees; union-find and
// topological-sort inside graphs; knapsack-problem and bitmask inside DP.
// Each topic has an ordered list of rules, and a problem goes to the first
// rule its tags match:
//   any: at least one of these tags     not: none of these tags
// Anything no rule matches goes to the topic's last entry, its core bucket.
// The rules were picked from tag counts across the catalog
// (data/catalog.json), most specific first, and checked against
// well-known problems (tests/subtopics.test.js). Pure: the graph, the
// strength scores and the recommender all use it.

import { topicTags } from './topics.js';

const S = (key, label, any = null, not = null) => ({ key, label, any, not });

export const SUBTOPICS = {
  arrays: [
    S('prefix-sum', 'prefix sums', ['prefix-sum']),
    S('matrix', 'matrices', ['matrix']),
    S('design', 'design', ['design', 'data-stream']),
    S('hashing', 'hashing & counting', ['hash-table', 'counting']),
    S('sorting', 'sorting', ['sorting', 'counting-sort', 'bucket-sort', 'radix-sort']),
    S('strings', 'strings', ['string', 'string-matching', 'rolling-hash', 'hash-function', 'knuth-morris-pratt-algorithm']),
    S('simulation', 'simulation', ['simulation', 'enumeration']),
    S('core', 'arrays'),
  ],
  'two-pointers': [
    S('sorted', 'after sorting', ['sorting', 'binary-search']),
    S('strings', 'strings', ['string']),
    S('greedy', 'greedy squeeze', ['greedy', 'dynamic-programming', 'monotonic-stack']),
    S('core', 'in-place arrays'),
  ],
  'sliding-window': [
    S('deque', 'window max / deque', ['monotonic-queue', 'queue', 'heap-priority-queue']),
    S('binary-search', 'with binary search', ['binary-search']),
    S('prefix-sum', 'prefix sums', ['prefix-sum']),
    S('strings', 'strings', ['string']),
    S('counting', 'counting', ['hash-table', 'counting']),
    S('core', 'arrays'),
  ],
  stack: [
    S('monotonic', 'monotonic stack', ['monotonic-stack']),
    S('design', 'design', ['design']),
    S('expressions', 'expressions', ['math', 'recursion']),
    S('parsing', 'brackets & parsing', ['bracket-sequences', 'string']),
    S('core', 'stacks'),
  ],
  'binary-search': [
    S('matrix', 'matrices', ['matrix']),
    S('design', 'design', ['design']),
    S('divide', 'divide & conquer', ['divide-and-conquer']),
    S('prefix-sum', 'prefix sums', ['prefix-sum']),
    S('sorted', 'with sorting & pointers', ['sorting', 'two-pointers']),
    S('math', 'math', ['math', 'number-theory']),
    S('core', 'search spaces'),
  ],
  'linked-list': [
    S('design', 'design', ['design', 'doubly-linked-list']),
    S('fast-slow', 'fast & slow pointers', ['two-pointers', 'floyds-cycle-finding-algorithm']),
    S('merging', 'merging & sorting', ['divide-and-conquer', 'merge-sort', 'sorting', 'heap-priority-queue']),
    S('math', 'arithmetic', ['math']),
    S('recursion', 'reversal & recursion', ['recursion', 'stack']),
    S('core', 'pointer surgery'),
  ],
  trees: [
    S('lca', 'ancestors (LCA)', ['lowest-common-ancestor', 'binary-lifting']),
    S('bst', 'binary search trees', ['binary-search-tree']),
    S('dp', 'tree DP', ['dp-on-trees', 'dynamic-programming']),
    S('design', 'design & serialising', ['design']),
    S('build', 'construction', ['divide-and-conquer']),
    S('bfs', 'level order (BFS)', ['breadth-first-search'], ['depth-first-search']),
    S('core', 'DFS & recursion'),
  ],
  tries: [
    S('design', 'design', ['design']),
    S('search', 'word search', ['depth-first-search', 'backtracking', 'matrix']),
    S('xor', 'bitwise (XOR)', ['bit-manipulation']),
    S('matching', 'string matching', ['string-matching', 'rolling-hash', 'hash-function']),
    S('core', 'prefix trees'),
  ],
  heap: [
    S('streams', 'two heaps & streams', ['data-stream']),
    S('design', 'design', ['design']),
    S('top-k', 'k-th & top-k', ['quickselect', 'divide-and-conquer']),
    S('scheduling', 'scheduling (greedy)', ['greedy']),
    S('ordered', 'ordered sets', ['ordered-set']),
    S('core', 'priority queues'),
  ],
  backtracking: [
    S('grids', 'grids', ['matrix']),
    S('subsets', 'subsets & bitmasks', ['bit-manipulation', 'bitmask']),
    S('strings', 'strings & partitions', ['string']),
    S('math', 'math', ['math', 'combinatorics', 'number-theory']),
    S('core', 'combinations & permutations'),
  ],
  graphs: [
    S('topo', 'topological sort', ['topological-sort', 'directed-acyclic-graph']),
    S('grids', 'grids', ['matrix']),
    S('union-find', 'union find', ['union-find']),
    S('bfs', 'BFS', ['breadth-first-search'], ['depth-first-search']),
    S('core', 'DFS & traversal'),
  ],
  'advanced-graphs': [
    S('shortest', 'shortest paths', ['shortest-path', 'dijkstra', '0-1-bfs']),
    S('mst', 'spanning trees', ['minimum-spanning-tree', 'prims-algorithm', 'kruskals-algorithm', 'boruvkas-algorithm']),
    S('euler', 'Euler paths', ['eulerian-circuit', 'eulerian-path']),
    S('components', 'components', ['strongly-connected-component', 'biconnected-component']),
    S('union-find', 'union find', ['union-find']),
    S('core', 'graph algorithms'),
  ],
  'dp-1d': [
    S('bitmask', 'bitmask DP', ['bitmask']),
    S('knapsack', 'knapsack', ['knapsack-problem', '0-1-knapsack', 'complete-knapsack']),
    S('lis', 'LIS & binary search', ['longest-increasing-subsequence', 'binary-search']),
    S('graph', 'on trees & graphs', ['tree', 'graph', 'depth-first-search', 'breadth-first-search']),
    S('strings', 'strings', ['string']),
    S('counting', 'counting ways', ['combinatorics', 'math', 'number-theory']),
    S('core', 'linear sequences'),
  ],
  'dp-2d': [
    S('knapsack', 'knapsack', ['knapsack-problem', '0-1-knapsack', 'complete-knapsack']),
    S('strings', 'strings (LCS, edit distance)', ['string', 'longest-common-subsequence']),
    S('games', 'games', ['game-theory', 'minimax-algorithm']),
    S('grids', 'grid paths', ['matrix', 'combinatorics']),
    S('core', 'interval & state DP'),
  ],
  greedy: [
    S('dp', 'greedy vs DP', ['dynamic-programming']),
    S('sorting', 'sorting', ['sorting', 'counting-sort']),
    S('strings', 'strings', ['string']),
    S('math', 'math', ['math', 'number-theory']),
    S('counting', 'counting', ['hash-table', 'counting']),
    S('core', 'arrays'),
  ],
  intervals: [
    S('sweep', 'sweep line', ['sweep-line', 'prefix-sum']),
    S('heap', 'with heaps', ['heap-priority-queue']),
    S('core', 'merging intervals'),
  ],
  math: [
    S('matrix', 'matrices', ['matrix']),
    S('geometry', 'geometry', ['geometry']),
    S('number-theory', 'number theory', ['number-theory', 'greatest-common-divisor', 'euclidean-algorithm', 'primality-test', 'sieve-theory', 'prime-factorization', 'prime-number-sieve']),
    S('combinatorics', 'combinatorics', ['combinatorics', 'probability-and-statistics']),
    S('strings', 'strings', ['string']),
    S('simulation', 'simulation', ['simulation']),
    S('core', 'arithmetic'),
  ],
  bits: [
    S('dp', 'bit DP', ['dynamic-programming', 'bitmask']),
    S('math', 'arithmetic', ['math']),
    S('strings', 'strings', ['string']),
    S('core', 'bit tricks'),
  ],
  other: [
    S('sql', 'SQL', ['database']),
    S('concurrency', 'concurrency', ['concurrency']),
    S('shell', 'shell', ['shell']),
    S('core', 'misc'),
  ],
};

const FALLBACK = [S('core', 'all')];
const rulesOf = (topic) => SUBTOPICS[topic] || FALLBACK;
const matches = (rule, set) => !!rule.any && rule.any.some(t => set.has(t)) && !(rule.not || []).some(t => set.has(t));

/** The subtopic a problem goes in, within its topic. */
export function subtopicOf(topic, tags = []) {
  const set = new Set(tags);
  const rules = rulesOf(topic);
  for (const r of rules) if (matches(r, set)) return r.key;
  return rules[rules.length - 1].key;
}

/** Every subtopic a problem's tags fit, its own first (for links between subtopics). */
export function subtopicsMatching(topic, tags = []) {
  const set = new Set(tags);
  return rulesOf(topic).filter(r => matches(r, set)).map(r => r.key);
}

/** A topic's subtopics in display order: [{ key, label }]. */
export const subtopicList = (topic) => rulesOf(topic).map(({ key, label }) => ({ key, label }));

export const subtopicLabel = (topic, key) => rulesOf(topic).find(r => r.key === key)?.label || String(key).replace(/-/g, ' ');

/** Tags that describe a subtopic, for the recommender (the core bucket uses its topic's). */
export function subtopicTags(topic, key) {
  const r = rulesOf(topic).find(x => x.key === key);
  return r?.any ? [...r.any] : topicTags(topic);
}
