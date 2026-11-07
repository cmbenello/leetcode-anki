// Goals: "Prepare for Google interview", "Blind 75", "Get good at DP".
//
// A goal is one of:
//   all   — every problem counts                      { target }
//   tags  — problems carrying any of these topics     { tags: ['graph', 'dynamic-programming'], target }
//   list  — a fixed set of problems                   { slugs: [...] }   (target = list length)
// Progress counts DISTINCT problems you've solved that match, all-time — a
// new goal starts from what you've already done, not from zero.
//
// Pure functions only (no chrome.*), so they run in node tests and in any
// extension context.

/** @typedef {{ id: string, name: string, type: 'all'|'tags'|'list', target?: number,
 *   tags?: string[], slugs?: string[], deadline?: string|null, createdAt: number }} Goal */

// The canonical Blind 75 (LeetCode slugs). Premium-only problems are included
// as listed; they simply can't be recommended to a free account.
export const BLIND_75 = [
  // array
  'two-sum', 'best-time-to-buy-and-sell-stock', 'contains-duplicate', 'product-of-array-except-self',
  'maximum-subarray', 'maximum-product-subarray', 'find-minimum-in-rotated-sorted-array',
  'search-in-rotated-sorted-array', '3sum', 'container-with-most-water',
  // binary
  'sum-of-two-integers', 'number-of-1-bits', 'counting-bits', 'missing-number', 'reverse-bits',
  // dynamic programming
  'climbing-stairs', 'coin-change', 'longest-increasing-subsequence', 'longest-common-subsequence',
  'word-break', 'combination-sum-iv', 'house-robber', 'house-robber-ii', 'decode-ways', 'unique-paths',
  'jump-game',
  // graph
  'clone-graph', 'course-schedule', 'pacific-atlantic-water-flow', 'number-of-islands',
  'longest-consecutive-sequence', 'alien-dictionary', 'graph-valid-tree',
  'number-of-connected-components-in-an-undirected-graph',
  // interval
  'insert-interval', 'merge-intervals', 'non-overlapping-intervals', 'meeting-rooms', 'meeting-rooms-ii',
  // linked list
  'reverse-linked-list', 'linked-list-cycle', 'merge-two-sorted-lists', 'merge-k-sorted-lists',
  'remove-nth-node-from-end-of-list', 'reorder-list',
  // matrix
  'set-matrix-zeroes', 'spiral-matrix', 'rotate-image', 'word-search',
  // string
  'longest-substring-without-repeating-characters', 'longest-repeating-character-replacement',
  'minimum-window-substring', 'valid-anagram', 'group-anagrams', 'valid-parentheses', 'valid-palindrome',
  'longest-palindromic-substring', 'palindromic-substrings', 'encode-and-decode-strings',
  // tree
  'maximum-depth-of-binary-tree', 'same-tree', 'invert-binary-tree', 'binary-tree-maximum-path-sum',
  'binary-tree-level-order-traversal', 'serialize-and-deserialize-binary-tree', 'subtree-of-another-tree',
  'construct-binary-tree-from-preorder-and-inorder-traversal', 'validate-binary-search-tree',
  'kth-smallest-element-in-a-bst', 'lowest-common-ancestor-of-a-binary-search-tree',
  'implement-trie-prefix-tree', 'design-add-and-search-words-data-structure', 'word-search-ii',
  // heap
  'top-k-frequent-elements', 'find-median-from-data-stream',
];

export const PRESETS = {
  blind75: { name: 'Blind 75', type: 'list', slugs: BLIND_75 },
  everything: { name: 'All practice', type: 'all', target: 150 },
};

// Topic slugs commonly weighted in big-tech interview loops — a sensible
// starting focus for a "<company> interview" goal; editable.
export const INTERVIEW_TAGS = [
  'array', 'string', 'hash-table', 'two-pointers', 'sliding-window', 'binary-search',
  'tree', 'graph', 'breadth-first-search', 'depth-first-search', 'dynamic-programming',
  'heap-priority-queue', 'backtracking', 'linked-list', 'stack',
];

export function makeGoal(fields, now = Date.now()) {
  const g = {
    id: fields.id || `g${now.toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`,
    name: String(fields.name || 'Goal').trim().slice(0, 60),
    type: fields.type === 'tags' || fields.type === 'list' ? fields.type : 'all',
    tags: Array.isArray(fields.tags) ? [...new Set(fields.tags)] : [],
    slugs: Array.isArray(fields.slugs) ? [...new Set(fields.slugs)] : [],
    deadline: fields.deadline || null,
    createdAt: fields.createdAt || now,
  };
  g.target = g.type === 'list' ? g.slugs.length : Math.max(1, Math.round(+fields.target || 75));
  return g;
}

/** Does a problem count toward this goal? `tags` are topic slugs. */
export function goalMatches(goal, slug, tags = []) {
  if (goal.type === 'list') return goal.slugs.includes(slug);
  if (goal.type === 'tags') return tags.some(t => goal.tags.includes(t));
  return true;
}

/** Extract LeetCode slugs from pasted URLs / slugs (for custom list goals). */
export function parseSlugList(text) {
  const out = [];
  for (const tok of String(text || '').split(/[\s,]+/)) {
    if (!tok) continue;
    const m = tok.match(/leetcode\.com\/problems\/([a-z0-9-]+)/i) || tok.match(/^([a-z0-9]+(?:-[a-z0-9]+)*)$/i);
    if (m) out.push(m[1].toLowerCase());
  }
  return [...new Set(out)];
}

/**
 * Progress for a goal.
 * solved: [{ slug, tags, firstSolvedAt }]
 * Returns { done, target, pct, remaining, perDay|null, daysLeft|null }.
 */
export function goalProgress(goal, solved, now = Date.now()) {
  const done = solved.filter(p => goalMatches(goal, p.slug, p.tags)).length;
  const target = Math.max(goal.target || 1, 1);
  const remaining = Math.max(0, target - done);
  let daysLeft = null, perDay = null;
  if (goal.deadline) {
    const end = new Date(`${goal.deadline}T23:59:59`).getTime();
    daysLeft = Math.max(0, Math.ceil((end - now) / 86400000));
    perDay = daysLeft > 0 ? remaining / daysLeft : (remaining ? Infinity : 0);
  }
  return { done, target, pct: Math.min(1, done / target), remaining, daysLeft, perDay };
}
