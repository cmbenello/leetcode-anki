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
      difficulty
      isPaidOnly
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
    difficulty: q.difficulty,                  // "Easy" | "Medium" | "Hard"
    isPaidOnly: !!q.isPaidOnly,
    tags: (q.topicTags || []).map(t => ({ name: t.name, slug: t.slug })),
  };
}
