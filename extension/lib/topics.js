// Topics: the arcs of the growth view, and what "suggest a problem in this
// topic" means. They follow NeetCode's roadmap: a problem NeetCode lists goes
// in NeetCode's own (hand-picked) category; anything else is classified from
// its LeetCode tags. Shared by the graph (newtab/growth.js) and the
// recommender (background.js) so the two always agree. Pure.
//
// Why not tags alone: LeetCode tags nearly every tree problem "Depth-First
// Search"/"Breadth-First Search" and linked-list problems "Two Pointers", so a
// tag ranking filed Invert Binary Tree under graphs and Linked List Cycle
// under two pointers.

/** Display order around the ring (NeetCode's roadmap), label, and hue (no yellows). */
export const TOPICS = [
  { key: 'arrays',          label: 'arrays & hashing', nc: 'Arrays & Hashing',        hue: 210 },
  { key: 'two-pointers',    label: 'two pointers',     nc: 'Two Pointers',            hue: 20 },
  { key: 'sliding-window',  label: 'sliding window',   nc: 'Sliding Window',          hue: 190 },
  { key: 'stack',           label: 'stack',            nc: 'Stack',                   hue: 330 },
  { key: 'binary-search',   label: 'binary search',    nc: 'Binary Search',           hue: 145 },
  { key: 'linked-list',     label: 'linked list',      nc: 'Linked List',             hue: 245 },
  { key: 'trees',           label: 'trees',            nc: 'Trees',                   hue: 120 },
  { key: 'tries',           label: 'tries',            nc: 'Tries',                   hue: 300 },
  { key: 'heap',            label: 'heap',             nc: 'Heap / Priority Queue',   hue: 355 },
  { key: 'backtracking',    label: 'backtracking',     nc: 'Backtracking',            hue: 280 },
  { key: 'graphs',          label: 'graphs',           nc: 'Graphs',                  hue: 200 },
  { key: 'advanced-graphs', label: 'advanced graphs',  nc: 'Advanced Graphs',         hue: 225 },
  { key: 'dp-1d',           label: '1-D DP',           nc: '1-D Dynamic Programming', hue: 160 },
  { key: 'dp-2d',           label: '2-D DP',           nc: '2-D Dynamic Programming', hue: 175 },
  { key: 'greedy',          label: 'greedy',           nc: 'Greedy',                  hue: 30 },
  { key: 'intervals',       label: 'intervals',        nc: 'Intervals',               hue: 90 },
  { key: 'math',            label: 'math & geometry',  nc: 'Math & Geometry',         hue: 265 },
  { key: 'bits',            label: 'bits',             nc: 'Bit Manipulation',        hue: 315 },
  { key: 'other',           label: 'other',            nc: null,                      hue: 220 },
];
export const TOPIC_KEYS = TOPICS.map(t => t.key);
const BY_NC = Object.fromEntries(TOPICS.filter(t => t.nc).map(t => [t.nc, t.key]));

/** LeetCode tag -> topic, for problems NeetCode doesn't list. */
const TAG_TOPIC = {
  'trie': 'tries',
  'shortest-path': 'advanced-graphs', 'minimum-spanning-tree': 'advanced-graphs', 'eulerian-circuit': 'advanced-graphs',
  'strongly-connected-component': 'advanced-graphs', 'biconnected-component': 'advanced-graphs',
  'tree': 'trees', 'binary-tree': 'trees', 'binary-search-tree': 'trees',
  'graph': 'graphs', 'depth-first-search': 'graphs', 'breadth-first-search': 'graphs', 'union-find': 'graphs', 'topological-sort': 'graphs',
  'heap-priority-queue': 'heap',
  'linked-list': 'linked-list', 'doubly-linked-list': 'linked-list',
  'sliding-window': 'sliding-window', 'monotonic-queue': 'sliding-window',
  'binary-search': 'binary-search',
  'stack': 'stack', 'monotonic-stack': 'stack', 'queue': 'stack',
  'two-pointers': 'two-pointers',
  'backtracking': 'backtracking',
  'dynamic-programming': 'dp-1d', 'memoization': 'dp-1d',
  'greedy': 'greedy',
  'bit-manipulation': 'bits', 'bitmask': 'bits',
  'math': 'math', 'geometry': 'math', 'number-theory': 'math', 'combinatorics': 'math',
  'array': 'arrays', 'hash-table': 'arrays', 'string': 'arrays', 'sorting': 'arrays', 'prefix-sum': 'arrays',
  'counting': 'arrays', 'matrix': 'arrays', 'simulation': 'arrays', 'hash-function': 'arrays',
  // less common tags, folded into the arc they're practised with
  'design': 'arrays', 'divide-and-conquer': 'arrays', 'enumeration': 'arrays', 'string-matching': 'arrays',
  'rolling-hash': 'arrays', 'bucket-sort': 'arrays', 'counting-sort': 'arrays', 'merge-sort': 'arrays', 'radix-sort': 'arrays',
  'segment-tree': 'arrays', 'binary-indexed-tree': 'arrays', 'iterator': 'arrays',
  'recursion': 'backtracking',
  'quickselect': 'heap', 'ordered-set': 'heap', 'data-stream': 'heap',
  'interactive': 'binary-search',
  'game-theory': 'math', 'probability-and-statistics': 'math', 'randomized': 'math', 'brainteaser': 'math',
  'reservoir-sampling': 'math', 'rejection-sampling': 'math',
};
// Most specific first: a tree problem's DFS tag must not make it a graph
// problem, a linked list's two-pointer tag must not make it two pointers.
const PRIORITY = ['tries', 'dp-2d', 'dp-1d', 'backtracking', 'advanced-graphs', 'trees', 'graphs', 'heap', 'linked-list',
  'sliding-window', 'binary-search', 'stack', 'two-pointers', 'greedy', 'bits', 'math', 'arrays'];

export const tagTopic = (tag) => TAG_TOPIC[tag] || null;

/**
 * A problem's topic: NeetCode's category when it lists the problem (`pattern`,
 * e.g. "Trees"), else from its LeetCode tags.
 */
export function primaryTopic(tags = [], pattern = null) {
  if (pattern && BY_NC[pattern]) return BY_NC[pattern];
  const set = new Set();
  for (const t of tags) { const k = TAG_TOPIC[t]; if (k) set.add(k); }
  if (set.has('dp-1d') && tags.includes('matrix')) set.add('dp-2d');
  for (const k of PRIORITY) if (set.has(k)) return k;
  return 'other';
}

/** The LeetCode tags that make up a topic (for the recommender's weakness pool). */
export function topicTags(topic) {
  const tags = Object.entries(TAG_TOPIC).filter(([, k]) => k === topic).map(([t]) => t);
  if (topic === 'dp-2d') tags.push('dynamic-programming', 'matrix');
  return tags;
}
