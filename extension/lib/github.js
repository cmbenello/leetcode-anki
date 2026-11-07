// GitHub Git Data API client.
// One commit per grade event, multiple files in that commit.
//
// Flow: get ref -> get commit -> get base tree -> create blobs -> create tree
//   -> create commit -> update ref
//
// Token + repo come from chrome.storage settings. Caller passes them in so
// this module is testable.

const GH = 'https://api.github.com';

class GitHubError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

async function gh(token, path, init = {}) {
  const res = await fetch(`${GH}${path}`, {
    ...init,
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  if (!res.ok) throw new GitHubError(`GitHub ${res.status} on ${path}`, res.status, body);
  return body;
}

async function getDefaultBranch(token, owner, repo) {
  const info = await gh(token, `/repos/${owner}/${repo}`);
  return info.default_branch || 'main';
}

// UTF-8 safe base64 encode for the Contents API.
function utf8ToBase64(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

// Empty GitHub repos reject every Git Data API call with 409 "Git Repository
// is empty". The Contents API still works, so we use it to land an initial
// commit (and create the default branch) before any blob/tree/commit calls.
async function bootstrapEmptyRepo(token, owner, name, branch) {
  await gh(token, `/repos/${owner}/${name}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'init: bootstrap repo',
      content: utf8ToBase64('# Tracker\n\nInitialized by leetcode-anki. Will be regenerated on the next grade.\n'),
      branch,
    }),
  });
}

/**
 * Commit `files` to `owner/repo` in a single commit on the default branch.
 *
 * files: [{ path: "solutions/two-sum/solution.py", content: "..." }]
 *   - utf-8 strings only (good enough for code, json, md)
 * message: commit message
 *
 * Returns the new commit sha.
 *
 * ALL commits (LeetCode grades, the leetcode sync-queue flush, and the quant
 * batches) funnel through one serialization chain so two never build on the same
 * branch tip and race the ref PATCH — the source of the 422 "not a fast forward".
 */
let _commitChain = Promise.resolve();
export function commitFiles(opts) {
  const p = _commitChain.then(() => _commitFilesImpl(opts));
  _commitChain = p.catch(() => {});   // the next commit waits for this one, unaffected by its outcome
  return p;
}
async function _commitFilesImpl({ token, repo, message, files }) {
  if (!token) throw new Error('Missing GitHub token');
  if (!repo || !repo.includes('/')) throw new Error('Repo must be owner/name');
  if (!files?.length) throw new Error('No files to commit');

  const [owner, name] = repo.split('/');
  const branch = await getDefaultBranch(token, owner, name);

  // 1. ref -> latest commit sha on branch.
  //    Empty repos respond 409 "Git Repository is empty" on every Git Data
  //    endpoint. Bootstrap with the Contents API (which works on empty
  //    repos), then re-read the ref and proceed normally.
  let parentSha = null;
  try {
    const ref = await gh(token, `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    parentSha = ref.object.sha;
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 409) throw e;
    await bootstrapEmptyRepo(token, owner, name, branch);
    const ref = await gh(token, `/repos/${owner}/${name}/git/ref/heads/${branch}`);
    parentSha = ref.object.sha;
  }

  // 2. base tree
  const parentCommit = await gh(token, `/repos/${owner}/${name}/git/commits/${parentSha}`);
  const baseTreeSha = parentCommit.tree.sha;

  // 3. tree with INLINE content. Passing `content` per entry makes GitHub create
  //    the blobs as part of the tree call — ONE request instead of one POST per
  //    file. A 100-file batch was tripping the secondary rate limit (403 on
  //    /git/blobs); this collapses it to a single mutative request. Our files are
  //    all UTF-8 text (json/md), which is exactly what inline `content` supports.
  const tree = await gh(token, `/repos/${owner}/${name}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: files.map(f => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })),
    }),
  });

  // 4. commit
  const commit = await gh(token, `/repos/${owner}/${name}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({ message, tree: tree.sha, parents: [parentSha] }),
  });

  // 6. fast-forward the ref
  await gh(token, `/repos/${owner}/${name}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: false }),
  });

  return commit.sha;
}

/**
 * commitFiles + bounded retry.
 *
 * GitHub answers the ref PATCH with 422 ("not a fast forward") when the branch
 * tip moved between our read and our write — a concurrent commit, or the MV3
 * worker restarting mid-flight. commitFiles re-reads the tip on every call, so
 * retrying simply rebuilds on the fresh parent. 403 with a rate-limit body gets
 * a longer backoff.
 *
 * This used to live only in the quant batch path, which meant a single 422 on
 * the LeetCode path dropped the commit into the retry queue for good.
 */
export async function commitWithRetry({ token, repo, message, files, attempts = 6 }) {
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return { ok: true, sha: await commitFiles({ token, repo, message, files }) };
    } catch (e) {
      lastErr = e;
      const rateLimited = e && e.status === 403
        && e.body && /rate limit/i.test(e.body.message || '');
      const transient = e && (e.status === 422 || e.status === 409 || e.status >= 500);
      if ((transient || rateLimited) && attempt < attempts) {
        const wait = rateLimited
          ? 6000 * attempt
          : 300 * attempt + Math.floor(Math.random() * 300);
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      break;
    }
  }
  const detail = lastErr?.body?.message ? `: ${lastErr.body.message}` : '';
  return { ok: false, error: (lastErr?.message || String(lastErr)) + detail, cause: lastErr };
}

/**
 * Read a single file from the default branch (for merging log.md / stats.json).
 * Returns null if the file does not exist.
 */
export async function readFile({ token, repo, path }) {
  const [owner, name] = repo.split('/');
  try {
    const f = await gh(token, `/repos/${owner}/${name}/contents/${encodeURIComponent(path)}`);
    if (Array.isArray(f)) return null;
    // f.content is base64 with newlines
    const b64 = (f.content || '').replace(/\n/g, '');
    return atob(b64);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/** Quick check that token + repo work and the user has write access. */
export async function verifyAccess({ token, repo }) {
  const [owner, name] = repo.split('/');
  const info = await gh(token, `/repos/${owner}/${name}`);
  if (!info.permissions?.push) throw new Error('Token does not have push access');
  return { defaultBranch: info.default_branch, fullName: info.full_name };
}

export { GitHubError };
