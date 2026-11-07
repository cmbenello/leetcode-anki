// Topics: how LeetCode's tags collapse into the arcs of the growth view.
// Shared by the graph (newtab/growth.js) and the recommender (background.js)
// so "suggest a DP problem" means exactly the problems the DP arc holds. Pure.

export const ALIAS = {
  'breadth-first-search': 'graph', 'depth-first-search': 'graph', 'topological-sort': 'graph',
  'shortest-path': 'graph', 'binary-tree': 'tree', 'binary-search-tree': 'tree',
  'monotonic-stack': 'stack', 'memoization': 'dynamic-programming', 'heap-priority-queue': 'heap',
  'union-find': 'graph', 'prefix-sum': 'array', 'sorting': 'array', 'matrix': 'array',
  'counting': 'hash-table', 'bitmask': 'bit-manipulation', 'queue': 'stack',
};
// Primary topic = the most "technique-like" tag a problem carries; generic
// tags (array, string, hash table) only win when nothing more specific exists.
export const PRIORITY = [
  'dynamic-programming', 'backtracking', 'graph', 'trie', 'heap', 'binary-search', 'sliding-window',
  'two-pointers', 'linked-list', 'tree', 'stack', 'greedy', 'bit-manipulation', 'math',
  'string', 'hash-table', 'array',
];

export function primaryTopic(tags = []) {
  const norm = new Set(tags.map(t => ALIAS[t] || t));
  for (const t of PRIORITY) if (norm.has(t)) return t;
  return 'other';
}

/** The raw LeetCode tags that make up a topic ('graph' -> graph, BFS, DFS, …). */
export function topicTags(topic) {
  if (topic === 'other') return [];
  return [topic, ...Object.entries(ALIAS).filter(([, t]) => t === topic).map(([tag]) => tag)];
}
