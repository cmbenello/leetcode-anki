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
export async function fetchCatalog({ pageSize = 100, pause = 250 } = {}) {
  const rows = [];
  let skip = 0, total = Infinity;
  while (skip < total) {
    const res = await fetch(GQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Referer': 'https://leetcode.com/problemset/' },
      body: JSON.stringify({ query: CATALOG_QUERY, variables: { skip, limit: pageSize } }),
    });
    if (!res.ok) throw new Error(`LeetCode catalog ${res.status}`);
    const list = (await res.json())?.data?.problemsetQuestionList;
    if (!list) throw new Error('LeetCode catalog: unexpected response');
    total = list.total;
    for (const q of list.questions || []) {
      rows.push({
        s: q.titleSlug, t: q.title, d: DIFF_CODE[q.difficulty] || 'M',
        a: Math.round((q.acRate ?? 50) * 10) / 10, p: q.paidOnly ? 1 : 0,
        g: (q.topicTags || []).map(t => t.slug), n: q.frontendQuestionId,
      });
    }
    if (!list.questions?.length) break;
    skip += list.questions.length;
    await new Promise(r => setTimeout(r, pause));
  }
  return rows;
}
