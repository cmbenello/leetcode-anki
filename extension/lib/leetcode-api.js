// LeetCode public GraphQL — no auth required for `question` lookups.
// Called from the background worker (which has host permissions for leetcode.com)
// so cross-origin works whether the user is on leetcode.com or neetcode.io.

const GQL = 'https://leetcode.com/graphql';

const QUERY = `
  query questionData($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      title
      titleSlug
      questionFrontendId
      difficulty
      isPaidOnly
      acRate
      similarQuestions
      topicTags { name slug }
    }
  }
`;

export async function fetchQuestionMeta(slug) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Referer': 'https://leetcode.com/',
    },
    body: JSON.stringify({ query: QUERY, variables: { titleSlug: slug } }),
  });
  if (!res.ok) throw new Error(`LeetCode GraphQL ${res.status}`);
  const json = await res.json();
  const q = json?.data?.question;
  if (!q) return null;
  return {
    questionId: q.questionId,
    title: q.title,
    slug: q.titleSlug,
    frontendId: q.questionFrontendId ?? null,
    difficulty: q.difficulty,                  // "Easy" | "Medium" | "Hard"
    isPaidOnly: !!q.isPaidOnly,
    acRate: typeof q.acRate === 'number' ? q.acRate : null,
    // LeetCode's curated neighbours — the model's notion of a "near variant".
    similar: parseSimilar(q.similarQuestions),
    tags: (q.topicTags || []).map(t => ({ name: t.name, slug: t.slug })),
  };
}

function parseSimilar(raw) {
  try {
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return Array.isArray(arr) ? arr.map(x => x.titleSlug).filter(Boolean) : [];
  } catch { return []; }
}

// ---------- full problem catalog (candidates for recommendations) ----------
const CATALOG_QUERY = `
  query problemsetQuestionList($skip: Int, $limit: Int) {
    problemsetQuestionList: questionList(categorySlug: "", limit: $limit, skip: $skip, filters: {}) {
      total: totalNum
      questions: data {
        acRate difficulty paidOnly: isPaidOnly title titleSlug
        frontendQuestionId: questionFrontendId
        topicTags { slug }
      }
    }
  }
`;

const DIFF_CODE = { Easy: 'E', Medium: 'M', Hard: 'H' };

/**
 * Fetch every problem, compactly: ~4k rows x ~120 bytes. The server caps a
 * page at 100 rows whatever `limit` says, so we advance by rows RECEIVED —
 * advancing by the requested size silently skips most of the catalog.
 * Row: { s: slug, t: title, d: 'E'|'M'|'H', a: acRate, p: 1 if paid, g: [tag slugs], n: frontend id }
 */
async function fetchCatalogPage(skip, limit) {
  const res = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': 'https://leetcode.com/problemset/' },
    body: JSON.stringify({ query: CATALOG_QUERY, variables: { skip, limit } }),
  });
  if (!res.ok) throw new Error(`LeetCode catalog ${res.status}`);
  const list = (await res.json())?.data?.problemsetQuestionList;
  if (!list) throw new Error('LeetCode catalog: unexpected response');
  return list;
}

/**
 * Pages are fetched a few at a time (the server caps each at 100 rows), so a
 * refresh takes seconds rather than the ~30s of a sequential crawl.
 * onProgress(done, total) is called as pages land.
 */
export async function fetchCatalog({ pageSize = 100, concurrency = 4, onProgress = null } = {}) {
  const first = await fetchCatalogPage(0, pageSize);
  const total = first.total;
  const pages = new Map([[0, first.questions || []]]);
  let done = pages.get(0).length;
  onProgress?.(done, total);
  const skips = [];
  for (let s = pages.get(0).length || pageSize; s < total; s += pageSize) skips.push(s);
  let next = 0;
  async function worker() {
    while (next < skips.length) {
      const skip = skips[next++];
      const list = await fetchCatalogPage(skip, pageSize);
      pages.set(skip, list.questions || []);
      done += (list.questions || []).length;
      onProgress?.(done, total);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  const rows = [];
  const seen = new Set();
  for (const skip of [...pages.keys()].sort((a, b) => a - b)) {
    for (const q of pages.get(skip)) {
      if (seen.has(q.titleSlug)) continue;
      seen.add(q.titleSlug);
      rows.push({
        s: q.titleSlug, t: q.title, d: DIFF_CODE[q.difficulty] || 'M',
        a: Math.round((q.acRate ?? 50) * 10) / 10, p: q.paidOnly ? 1 : 0,
        g: (q.topicTags || []).map(t => t.slug), n: q.frontendQuestionId,
      });
    }
  }
  return rows;
}
