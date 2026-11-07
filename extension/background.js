// Service worker. Owns SR computation, storage writes, GitHub sync,
// LeetCode metadata fetching, and the daily reminder notification.

import { newCard, grade as applyGrade, BUTTONS, formatDuration } from './lib/sm2.js';
import {
  getCard, upsertCard, getSettings, bumpStats, getStats, setStats, getCards, setCards,
  pushSyncQueue, getSyncQueue, setSyncQueue,
  getMeta, getAllMeta, upsertMeta,
  getSchemaVersion, setSchemaVersion,
  getGoals, setGoals, getActiveGoalId, setActiveGoalId, getCatalog, setCatalog,
  getPhasesRaw, setPhases,
} from './lib/storage.js';
import { replay, predict, recommend, evidenceFor, mastery, calibration, mulberry32 } from './lib/model.js';
import { makeGoal, goalMatches, goalProgress, PRESETS, INTERVIEW_TAGS, parseSlugList } from './lib/goals.js';
import { commitWithRetry } from './lib/github.js';
import { dayKeyMs, todayKey, lastNDayKeys } from './lib/dates.js';
import { fetchQuestionMeta, fetchCatalog } from './lib/leetcode-api.js';
import { sanitizeCards } from './lib/cards.js';
import { validatePhases, normalizePhases, phasesFor, phaseSummary } from './lib/phases.js';
import { primaryTopic, topicTags } from './lib/topics.js';

const LANG_EXT = {
  python: 'py', python3: 'py',
  cpp: 'cpp', c: 'c',
  java: 'java',
  javascript: 'js', typescript: 'ts',
  go: 'go', golang: 'go',
  rust: 'rs',
  kotlin: 'kt', swift: 'swift', ruby: 'rb', scala: 'scala',
  php: 'php', csharp: 'cs', 'c#': 'cs',
  plaintext: 'txt',
};

function extFor(language, fallbackLang) {
  return LANG_EXT[(language || '').toLowerCase()]
      || LANG_EXT[(fallbackLang || '').toLowerCase()]
      || 'txt';
}
function buttonLabelFor(q) { return BUTTONS.find(b => b.quality === q)?.label ?? String(q); }
function buttonIdFor(q)    { return BUTTONS.find(b => b.quality === q)?.id    ?? 'good'; }

// ---------- SPA navigation: tell content script to re-init ----------
chrome.webNavigation.onHistoryStateUpdated.addListener(
  (details) => {
    if (details.frameId !== 0) return;
    chrome.tabs.sendMessage(details.tabId, { kind: 'spa-navigated' }).catch(() => {});
  },
  {
    url: [
      { hostSuffix: 'leetcode.com', pathPrefix: '/problems/' },
      { hostSuffix: 'leetcode.com', pathPrefix: '/problem/' },
      { hostSuffix: 'neetcode.io' },
    ],
  }
);

// ---------- message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      switch (msg?.kind) {
        case 'getCardWithPredictions': {
          const settings = await getSettings();
          const slug = msg.slug;
          let card = await getCard(slug);
          if (!card) card = newCard(slug, msg.title);
          const predictions = {};
          for (const b of BUTTONS) {
            const { nextIntervalMin } = applyGrade(card, b.quality, settings);
            predictions[b.id] = nextIntervalMin;
          }
          const starred = !!(card.starred || (await getPending())[slug]?.starred);
          let difficulty = (await getMeta(slug))?.difficulty || null;
          if (!difficulty) { await haveCatalog(); difficulty = (await catalogIndex()).bySlug[slug]?.difficulty || null; }
          sendResponse({ ok: true, card, predictions, starred, difficulty });
          break;
        }
        case 'setStar': {
          sendResponse(await setStar(msg.slug, !!msg.starred));
          break;
        }
        case 'grade': {
          const result = await handleGrade(msg);
          sendResponse(result);
          // No auto-advance — the content script will surface a "Next problem"
          // button after grading so the user controls when to move on.
          break;
        }
        case 'ensureMeta': {
          ensureMeta(msg.slug, msg.lcSlug).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'flushSyncQueue': {
          sendResponse(await flushSyncQueue());
          break;
        }
        case 'getDueList': {
          sendResponse(await getDueList());
          break;
        }
        case 'getCardStats': {
          sendResponse(await getCardStats(msg.slug));
          break;
        }
        case 'getSolvedCount': {
          const cards = await getCards();
          let solved = 0;
          for (const c of Object.values(cards)) {
            if (isSolved(c)) solved += 1;
          }
          sendResponse({ ok: true, solved, total: Object.keys(cards).length });
          break;
        }
        case 'updateDailyReminder': {
          await scheduleDailyReminder();
          sendResponse({ ok: true });
          break;
        }
        case 'fireReminderNow': {
          await fireDailyReminder();
          sendResponse({ ok: true });
          break;
        }
        case 'startSession': {
          sendResponse(await startSession(sender.tab?.id));
          break;
        }
        case 'startSessionAt': {
          sendResponse(await startSessionAt(msg.slug, sender.tab?.id));
          break;
        }
        case 'getGoals': {
          sendResponse(await getGoalsWithProgress());
          break;
        }
        case 'saveGoal': {
          sendResponse(await saveGoal(msg.goal || {}));
          break;
        }
        case 'deleteGoal': {
          sendResponse(await deleteGoal(msg.id));
          break;
        }
        case 'setActiveGoal': {
          await setActiveGoalId(msg.id ?? null);
          sendResponse({ ok: true });
          break;
        }
        case 'getHome': {
          sendResponse(await getHome());
          break;
        }
        case 'getGoalView': {
          sendResponse(await getGoalView(msg.id));
          break;
        }
        case 'getRecommendations': {
          sendResponse(await getRecommendations(msg.id, msg.k, msg.topic || null));
          break;
        }
        case 'getPhases': {
          sendResponse({ ok: true, phases: await loadPhases() });
          break;
        }
        case 'savePhases': {
          sendResponse(await savePhases(msg.phases));
          break;
        }
        case 'dismissRating': {
          sendResponse(await dismissRating(msg.slug));
          break;
        }
        case 'neetcodeProgress': {
          sendResponse(await mergeNeetcodeProgress(msg.slugs || [], !!msg.account));
          break;
        }
        case 'startImport': {
          sendResponse(await startImport(msg.perDay));
          break;
        }
        case 'importBatch': {
          sendResponse(await importBatch(msg.submissions || [], msg.cursor || {}));
          break;
        }
        case 'importProgress': {
          sendResponse(await importProgress(msg));
          break;
        }
        case 'getImportState': {
          sendResponse({ ok: true, state: await getImportState() });
          break;
        }
        case 'cancelImport': {
          await setImportState({ ...(await getImportState()), running: false, cancelled: true });
          sendResponse({ ok: true });
          break;
        }
        case 'exportDrill': {
          sendResponse({ ok: true, jsonl: await drillAttemptsJsonl() });
          break;
        }
        case 'cleanSubmissions': {
          sendResponse(await cleanSubmissions({ dryRun: !!msg.dryRun }));
          break;
        }
        case 'stopSession': {
          sendResponse(await stopSession());
          break;
        }
        case 'getSession': {
          sendResponse({ ok: true, session: await getSession() });
          break;
        }
        case 'skipInSession': {
          const tabId = sender.tab?.id;
          if (tabId) advanceSession(tabId).catch(() => {});
          sendResponse({ ok: true });
          break;
        }
        case 'repairCardUrls': {
          sendResponse(await repairCardUrls());
          break;
        }
        case 'deleteCard': {
          sendResponse(await deleteCardBySlug(msg.slug));
          break;
        }
        case 'recordSubmission': {
          sendResponse(await recordSubmissionEvent(msg));
          break;
        }
        case 'quant-grade': {
          if (!quantSenderAllowed(sender)) { sendResponse({ ok: false, error: 'origin not allowed' }); break; }
          sendResponse(await syncQuantCard(msg.card));
          break;
        }
        case 'quant-grade-batch': {
          if (!quantSenderAllowed(sender)) { sendResponse({ ok: false, error: 'origin not allowed' }); break; }
          sendResponse(await syncQuantBatch(msg.cards || []));
          break;
        }
        case 'quant-list': {
          if (!quantSenderAllowed(sender)) { sendResponse({ ok: false, error: 'origin not allowed' }); break; }
          sendResponse({ ok: true, ids: Object.keys(await getQuantIndex()) });
          break;
        }
        case 'quant-cards': {
          // Read-only list of synced quant cards for the extension's own dashboard
          // pages (newtab/popup). No origin gate: external pages can't reach this
          // (not externally_connectable; the content relay only forwards grade/list).
          const qix = await getQuantIndex();
          sendResponse({ ok: true, cards: Object.keys(qix).map(id => Object.assign({ id: id, slug: id }, qix[id])) });
          break;
        }
        default:
          sendResponse({ ok: false, error: `unknown kind: ${msg?.kind}` });
      }
    } catch (e) {
      console.error('[lcanki bg]', e);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

// ---------- titles ----------
// LeetCode slugs are derived from titles ("Pow(x, n)" -> "powx-n"), so a
// title whose letters contain the slug's letters is verifiably right.
const alnum = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const slugTitle = (slug) => String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
function titleMatchesSlug(title, slug) { return !!title && alnum(title).includes(alnum(slug)); }

// Priority: LeetCode's own title (GraphQL meta) > a title that provably
// matches the slug > what we already had > what the page said > the slug.
// The old rule ("set once, never change") meant a title captured mid-
// navigation from the PREVIOUS problem stuck to the card forever.
function bestTitle(slug, existing, incoming, meta, site = null) {
  if (meta?.title && (meta.slug === slug || titleMatchesSlug(meta.title, slug))) return meta.title;
  if (titleMatchesSlug(existing, slug)) return existing;
  if (titleMatchesSlug(incoming, slug)) return incoming;
  // On LeetCode a title that doesn't contain the slug is almost certainly a
  // stale one from the previous page; the slug is a safer stand-in until
  // metadata lands. NeetCode slugs legitimately differ from titles.
  if (site === 'leetcode') return slugTitle(slug);
  return existing || incoming || slugTitle(slug);
}

// ---------- grade handler ----------
function siteFromUrl(url) {
  return (url || '').includes('neetcode.io') ? 'neetcode' : 'leetcode';
}
function siteLabel(s) { return s === 'neetcode' ? 'NeetCode' : 'LeetCode'; }
function problemUrl(site, slug) {
  return site === 'neetcode'
    ? `https://neetcode.io/problems/${slug}`
    : `https://leetcode.com/problems/${slug}/`;
}
// Strip /solution, /solutions, /description, /submissions, /editorial, /discuss
// etc. off the end of a problem URL, plus any query/hash. We always want to
// re-land on the bare editor view, never the solution viewer.
function normalizeProblemUrl(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    const m = u.pathname.match(/^(\/(?:problems?|practice)\/[^/]+)/);
    if (!m) return url;
    const trailing = u.hostname.includes('leetcode.com') ? '/' : '';
    return `${u.protocol}//${u.host}${m[1]}${trailing}`;
  } catch {
    return url;
  }
}

async function handleGrade({ slug, title, quality, durationMs, readingMs, codingMs, code, language, url, submission, factors }) {
  const settings = await getSettings();
  // Drill logs the model's prediction for every attempt so it can later show
  // whether its numbers were honest. That only works if the prediction is the
  // one you'd have seen when you STARTED: built from earlier attempts only and
  // evaluated at that moment. Building it from everything stored at grade time
  // leaked the outcome in — this attempt's own Accepted verdict is already
  // stored by then, so it counted as an earlier attempt, moving ability and
  // triggering the recall bonus (Drill's importer caught a 50% problem logged
  // as 78%).
  let pPred = null;
  try {
    const startedAt = factors?.startedAt ?? null;
    const prevGradeT = (await getCard(slug))?.history?.at(-1)?.t ?? 0;
    const asOf = startedAt ?? Date.now();
    // Tabs running an older content script don't send startedAt: then drop
    // everything on THIS problem since its last grade — conservative, no leak.
    const keep = startedAt
      ? (a) => a.ts < startedAt
      : (a) => !(a.slug === slug && a.ts > prevGradeT);
    const { st, known } = await learnerState({ keep });
    const item = known[slug] || { slug, tags: tagSlugs(await getMeta(slug)) };
    pPred = Math.round(predict(st, item, asOf).p * 1000) / 1000;
  } catch (e) { /* prediction is best-effort */ }
  const site = siteFromUrl(url);
  let existing = await getCard(slug);
  if (!existing) {
    // first rating: promote what was held for this problem into a real card
    const pend = await getPending();
    const held = pend[slug];
    existing = newCard(slug, held?.title || title, site);
    if (held) {
      existing.submissions = held.submissions;
      if (held.starred) existing.starred = true;
      if (held.url) existing.lastUrl = held.url;
      if (held.code != null) { existing.pendingCode = held.code; existing.pendingLang = held.lang; }
      delete pend[slug];
      await setPending(pend);
    }
  }
  existing.title = bestTitle(slug, existing.title, title, await getMeta(slug), site);
  existing.site = site;
  if (url) existing.lastUrl = normalizeProblemUrl(url);
  if (existing.noReview) { delete existing.noReview; existing.due = Date.now(); }   // rated now: it joins reviews

  const { card, prevIntervalMin, nextIntervalMin } = applyGrade(existing, quality, settings);
  card.history.push({
    t: Date.now(),
    q: quality,
    button: buttonIdFor(quality),
    durationMs: durationMs ?? null,
    readingMs: readingMs ?? null,
    codingMs:  codingMs  ?? null,
    lang: language ?? null,
    submission: submission ?? null,
    factors: factors ?? null,       // { peeked, hints, failsBeforeAc, timeToAcMs, firstTryAc, startedAt }
    pPred,
    pPredV: 2,                      // v1 predictions leaked the outcome; only v2 are trusted
  });
  // Code to commit: what the editor holds right now, else what we stashed at
  // the Accepted verdict. Then clear the stash — this grade owns it.
  const commitCode = code ?? card.pendingCode ?? null;
  const commitLang = language ?? card.pendingLang ?? null;
  const hadPending = card.pendingCode != null;
  delete card.pendingCode; delete card.pendingLang;
  delete card.pendingAt;   delete card.pendingStatus;

  await upsertCard(card);
  await bumpStats({ isLapse: quality < 3 });
  await ensureMeta(slug).catch(() => {});

  // ONE commit per grade, carrying the grade you just gave. Previously sync
  // fired only on the Accepted verdict — which lands BEFORE you grade — so the
  // repo's meta.json/history/dashboards were always one grade behind, and a
  // grade with no fresh AC never reached GitHub at all.
  let syncError = null;
  const settings2 = await getSettings();
  if (settings2.syncEnabled && settings2.githubToken && settings2.githubRepo) {
    const label = buttonLabelFor(quality);
    const message = `${card.site}/${slug}: ${label} (${formatDuration(prevIntervalMin)} → ${formatDuration(nextIntervalMin)})`;
    const r = await syncToGitHub({
      card, code: commitCode, language: commitLang, url, settings: settings2, message,
    });
    if (!r.ok) {
      syncError = r.error;
      await pushSyncQueue({
        slug, t: Date.now(), reason: r.error,
        code: commitCode, language: commitLang, url, message,
      });
    }
  } else if (hadPending) {
    // Sync off: nothing to do with the stash; it was cleared above.
  }

  return { ok: true, prevIntervalMin, nextIntervalMin, syncError };
}

// Submissions for a problem you don't track yet wait here until you rate it.
// Rating turns them into a review card. Closing the bar (Esc / ×) stores the
// solve WITHOUT a review: a record with noReview set, never due, that still
// counts as solved (growth view, daily tracker, goals, the learner model).
// Rate it on a later attempt and it joins reviews like any other card.
const PENDING_KEY = 'pendingProblems';
async function getPending() { return (await chrome.storage.local.get(PENDING_KEY))[PENDING_KEY] || {}; }
async function setPending(p) {
  const cutoff = Date.now() - 14 * 864e5;                 // forget stale ones
  for (const [k, v] of Object.entries(p)) if ((v.at || 0) < cutoff) delete p[k];
  await chrome.storage.local.set({ [PENDING_KEY]: p });
}
const NEVER = Number.MAX_SAFE_INTEGER;
const inReview = (c) => !c.noReview;
async function dismissRating(slug) {
  if (!slug || (await getCard(slug))) return { ok: true, kept: true };   // tracked problems keep their history
  const pend = await getPending();
  const held = pend[slug];
  if (!held) return { ok: true, stored: false };
  const c = newCard(slug, held.title || slugTitle(slug), held.site || 'leetcode');
  c.submissions = held.submissions;
  if (held.starred) c.starred = true;
  if (held.url) c.lastUrl = held.url;
  if (held.code != null) {
    // the hourly sweep still commits an Accepted solution if sync is on
    c.pendingCode = held.code; c.pendingLang = held.lang ?? null;
    c.pendingAt = Date.now(); c.pendingStatus = 'Accepted';
  }
  c.noReview = true;
  c.due = NEVER;
  await upsertCard(c);
  delete pend[slug];
  await setPending(pend);
  return { ok: true, stored: true };
}

// ★ "come back to this": on the card, or on the held solve until it becomes one.
async function setStar(slug, starred) {
  if (!slug) return { ok: false, error: 'missing slug' };
  const card = await getCard(slug);
  if (card) {
    if (starred) { card.starred = true; card.starredAt = Date.now(); } else { delete card.starred; delete card.starredAt; }
    await upsertCard(card);
    return { ok: true, starred };
  }
  const pend = await getPending();
  if (!pend[slug]) return { ok: false, error: 'nothing recorded for this problem yet' };
  if (starred) pend[slug].starred = true; else delete pend[slug].starred;
  await setPending(pend);
  return { ok: true, starred, pending: true };
}

async function recordSubmissionEvent({ slug, title, url, status, submissionId, source, detail, code, language }) {
  if (!slug || !status) return { ok: false, error: 'missing slug or status' };
  const prior = await getCard(slug);
  if (!prior) return holdSubmission({ slug, title, url, status, submissionId, source, detail, code, language });
  // url is null when the verdict landed after you navigated to another
  // problem — keep the card's known site instead of guessing from nothing.
  const site = url ? siteFromUrl(url) : (prior?.site || 'leetcode');
  const existing = prior ?? newCard(slug, title, site);
  existing.title = bestTitle(slug, existing.title, title, await getMeta(slug), site);
  existing.site = site;
  if (url) existing.lastUrl = normalizeProblemUrl(url);
  existing.submissions = existing.submissions || [];

  // Exact dedupe. The content script dedupes too, but it can be re-injected
  // (extension reload, SPA re-init) and lose its memory; storage can't.
  const id = submissionId ? String(submissionId) : null;
  if (id && existing.submissions.some(x => x.id === id)) {
    return { ok: true, duplicate: true };
  }

  const entry = { t: Date.now(), status, source: source || 'dom' };
  if (id) entry.id = id;
  if (detail) {
    if (detail.runtime)        entry.runtime = detail.runtime;
    if (detail.memory)         entry.memory = detail.memory;
    if (detail.totalCorrect != null)   entry.correct = detail.totalCorrect;
    if (detail.totalTestcases != null) entry.total = detail.totalTestcases;
  }
  existing.submissions.push(entry);

  // On Accepted, stash the code. The commit happens when you GRADE (one
  // commit per grade, with the grade in it). If you never grade, the hourly
  // sweep commits the stash so an Accepted solution is never lost.
  if (/accepted/i.test(status) && code != null) {
    existing.pendingCode = code;
    existing.pendingLang = language ?? null;
    existing.pendingAt = Date.now();
    existing.pendingStatus = status;
  }
  await upsertCard(existing);

  ensureMeta(slug).catch(() => {});
  return { ok: true };
}

async function holdSubmission({ slug, title, url, status, submissionId, source, detail, code, language }) {
  const pend = await getPending();
  const p = pend[slug] || { title, site: url ? siteFromUrl(url) : 'leetcode', url: null, submissions: [] };
  const id = submissionId ? String(submissionId) : null;
  if (id && p.submissions.some(x => x.id === id)) return { ok: true, duplicate: true, pending: true };
  const entry = { t: Date.now(), status, source: source || 'dom' };
  if (id) entry.id = id;
  if (detail?.runtime) entry.runtime = detail.runtime;
  if (detail?.memory) entry.memory = detail.memory;
  p.submissions.push(entry);
  if (title) p.title = bestTitle(slug, p.title, title, await getMeta(slug), p.site);
  if (url) p.url = normalizeProblemUrl(url);
  if (/accepted/i.test(status) && code != null) { p.code = code; p.lang = language ?? null; }
  p.at = Date.now();
  pend[slug] = p;
  await setPending(pend);
  ensureMeta(slug).catch(() => {});
  return { ok: true, pending: true };
}

async function deleteCardBySlug(slug) {
  if (!slug) return { ok: false, error: 'no slug' };
  const cards = await getCards();
  if (!cards[slug]) return { ok: false, error: 'card not found' };
  delete cards[slug];
  await setCards(cards);
  // If a session is active, drop the deleted slug from any remaining queue.
  const session = await getSession();
  if (session) {
    const before = session.queue.length;
    session.queue = session.queue.filter((q, i) => i < session.index || q.slug !== slug);
    if (session.queue.length !== before) await setSession(session);
  }
  return { ok: true };
}

// ---------- one-shot repair: backfill site + lastUrl on old cards ----------
async function repairCardUrls() {
  const cards = await getCards();
  const slugs = Object.keys(cards);
  let repaired = 0, lc = 0, nc = 0, errors = 0, skipped = 0;

  for (const slug of slugs) {
    const card = cards[slug];
    if (card.lastUrl) { skipped += 1; continue; }
    try {
      const meta = await fetchQuestionMeta(slug);
      if (meta) {
        card.site = 'leetcode';
        card.lastUrl = `https://leetcode.com/problems/${slug}/`;
        lc += 1;
      } else {
        // Slug doesn't exist on LeetCode — assume NeetCode. NC has a few
        // problems that don't exist on LC, plus NC sometimes uses a different
        // slug than LC for the same problem.
        card.site = 'neetcode';
        card.lastUrl = `https://neetcode.io/problems/${slug}`;
        nc += 1;
      }
      repaired += 1;
    } catch (e) {
      console.warn('[lcanki] repair failed for', slug, e?.message || e);
      errors += 1;
    }
    // Be polite to LeetCode's GraphQL — ~5 req/sec ceiling.
    await new Promise(r => setTimeout(r, 200));
  }
  await setCards(cards);
  return { ok: true, repaired, lc, nc, errors, skipped, total: slugs.length };
}

// ---------- practice session ----------
// session = { queue: [{slug, site, title}], index, completed, startedAt }
const SESSION_KEY = 'lcanki:session';

async function getSession() {
  const out = await chrome.storage.local.get(SESSION_KEY);
  return out[SESSION_KEY] ?? null;
}
async function setSession(s) {
  if (s == null) await chrome.storage.local.remove(SESSION_KEY);
  else await chrome.storage.local.set({ [SESSION_KEY]: s });
}

async function startSessionAt(slug, senderTabId) {
  const cards = await getCards();
  const clicked = cards[slug];
  if (!clicked) return { ok: false, error: 'card not found' };

  const now = Date.now();
  const due = Object.values(cards)
    .filter(c => (c.due ?? 0) <= now && c.slug !== slug)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  // Clicked card goes first, then the rest of due cards in due order.
  const ordered = [clicked, ...due];
  const queue = dedupeBySlug(ordered).map(c => ({
    slug: c.slug,
    site: c.site || 'leetcode',
    title: c.title,
    url: normalizeProblemUrl(c.lastUrl || problemUrl(c.site || 'leetcode', c.slug)),
  }));

  const session = { queue, index: 0, completed: 0, startedAt: Date.now() };
  await setSession(session);
  openProblem(queue[0].url, senderTabId);
  return { ok: true, session };
}

// A card counts as "solved" if any of: it has a recorded Accepted submission,
// it has a graded history entry whose submission was Accepted, or the user
// has graded it with non-fail at least once (reps > 0).
function isSolved(c) {
  if ((c.reps ?? 0) > 0) return true;
  if ((c.submissions ?? []).some(s => /accepted/i.test(s?.status || ''))) return true;
  if ((c.history ?? []).some(h => /accepted/i.test(h?.submission?.status || ''))) return true;
  return false;
}

function dedupeBySlug(cards) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    if (seen.has(c.slug)) continue;
    seen.add(c.slug);
    out.push(c);
  }
  return out;
}

async function startSession(senderTabId) {
  const cards = await getCards();
  const now = Date.now();
  const due = Object.values(cards)
    .filter(c => (c.due ?? 0) <= now)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  if (!due.length) return { ok: false, error: 'no due problems' };

  const queue = dedupeBySlug(due).map(c => ({
    slug: c.slug,
    site: c.site || 'leetcode',
    title: c.title,
    // Prefer the exact URL the user last graded on. Slugs differ between
    // LeetCode and NeetCode for the same problem; only the captured URL is
    // a reliable "go back to where you were" identifier.
    url: normalizeProblemUrl(c.lastUrl || problemUrl(c.site || 'leetcode', c.slug)),
  }));
  const session = { queue, index: 0, completed: 0, startedAt: Date.now() };
  await setSession(session);

  // Navigate in the background. We do NOT await the tab API here because
  // the popup awaits this message response and chrome.tabs.update can
  // block while the popup is up, leaving the popup hung.
  openProblem(queue[0].url, senderTabId);

  return { ok: true, session };
}

// senderTabId is set when the request came from a page in a tab (the newtab
// dashboard, a problem page). Navigating THAT tab is what the user expects;
// the old code inspected the active tab's URL, saw chrome-extension://…/newtab,
// decided it wasn't a problem page, and opened a second tab.
function openProblem(url, senderTabId) {
  (async () => {
    try {
      if (senderTabId) { await chrome.tabs.update(senderTabId, { url }); return; }
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab && /\/problems?\//.test(tab.url || '')) {
        await chrome.tabs.update(tab.id, { url });
      } else {
        await chrome.tabs.create({ url, active: true });
      }
    } catch (e) {
      console.warn('[lcanki] openProblem failed:', e?.message || e);
    }
  })();
}

async function stopSession() {
  await setSession(null);
  return { ok: true };
}

async function advanceSession(senderTabId) {
  const session = await getSession();
  if (!session) return;
  session.index += 1;
  session.completed += 1;

  if (session.index >= session.queue.length) {
    await setSession(null);
    chrome.notifications?.create('lcanki-session-done', {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icons/icon128.png'),
      title: 'Session complete',
      message: `Reviewed ${session.completed} problem${session.completed === 1 ? '' : 's'}.`,
      priority: 1,
    });
    return;
  }

  await setSession(session);
  const next = session.queue[session.index];
  const url = normalizeProblemUrl(next.url || problemUrl(next.site, next.slug));
  if (senderTabId) {
    chrome.tabs.update(senderTabId, { url }).catch(() => {});
  }
}

// ---------- metadata cache ----------
async function ensureMeta(slug, lcSlug) {
  if (!slug) return null;
  const existing = await getMeta(slug);
  // refresh every 7 days, but always retry if no metadata yet
  if (existing?.difficulty && Date.now() - (existing.fetchedAt ?? 0) < 7 * 24 * 3600 * 1000) {
    return existing;
  }
  try {
    // NeetCode slugs sometimes differ from LeetCode's. Caller can pass the
    // resolved LeetCode slug via `lcSlug`; we still store under the original
    // (NeetCode) slug so card lookups stay keyed by URL slug.
    const lookup = lcSlug || slug;
    const meta = await fetchQuestionMeta(lookup);
    if (meta) {
      await upsertMeta(slug, meta);
      const card = await getCard(slug);
      if (card) {
        const t = bestTitle(slug, card.title, null, meta);
        if (t !== card.title) { card.title = t; await upsertCard(card); }
      }
      return meta;
    }
  } catch (e) {
    console.warn('[lcanki] meta fetch failed', slug, e.message);
  }
  return existing;
}

// ---------- GitHub sync ----------
// Called from recordSubmissionEvent ONLY (on Accepted). Commits the current
// editor code plus regenerated dashboards. Not invoked on grade events.
async function syncToGitHub({ card, code, language, url, settings, message }) {
  const ext = extFor(language, settings.defaultLang);
  const slug = card.slug;
  const site = card.site || siteFromUrl(url);
  const dir = `${site}/${slug}`;
  const meta = await getMeta(slug);

  const files = [];

  if (code != null) {
    files.push({ path: `${dir}/solution.${ext}`, content: code });
  }

  files.push({ path: `${dir}/meta.json`, content: renderMetaJson(card, meta, url) });

  files.push({ path: `${dir}/README.md`, content: renderProblemReadme(card, meta) });

  // Seed notes.md once. Never overwrite — that's where the user writes their
  // approach. We track creation in card.notesCreated.
  let notesNewlyCreated = false;
  if (!card.notesCreated) {
    files.push({
      path: `${dir}/notes.md`,
      content: renderInitialNotes(card, meta),
    });
    notesNewlyCreated = true;
  }

  files.push({ path: `${site}/README.md`, content: await renderSiteReadme(site) });

  files.push({ path: 'log.md',     content: await renderLog() });
  files.push({ path: 'stats.json', content: JSON.stringify(await getStats(), null, 2) + '\n' });
  files.push({ path: 'README.md',  content: await renderReadme() });
  files.push({ path: 'drill/attempts.jsonl', content: await drillAttemptsJsonl() });

  const r = await commitWithRetry({
    token: settings.githubToken,
    repo: settings.githubRepo,
    message: message || `${site}/${slug}: sync`,
    files,
  });
  if (r.ok && notesNewlyCreated) {
    const fresh = await getCard(slug);
    if (fresh) { fresh.notesCreated = true; await upsertCard(fresh); }
  }
  return r;
}

// Build the per-problem file set for one card (used by the queue flush so a
// retry re-sends the REAL solution + meta, not just dashboards).
async function problemFiles(card, code, language, url, settings) {
  const site = card.site || siteFromUrl(url);
  const dir = `${site}/${card.slug}`;
  const meta = await getMeta(card.slug);
  const files = [];
  if (code != null) files.push({ path: `${dir}/solution.${extFor(language, settings.defaultLang)}`, content: code });
  files.push({ path: `${dir}/meta.json`, content: renderMetaJson(card, meta, url) });
  files.push({ path: `${dir}/README.md`, content: renderProblemReadme(card, meta) });
  return files;
}

function renderMetaJson(card, meta, url) {
  return JSON.stringify({
    slug: card.slug,
    title: card.title,
    site: card.site,
    url: url || card.lastUrl || null,
    difficulty: meta?.difficulty ?? null,
    tags: meta?.tags ?? [],
    intervalMin: card.intervalMin,
    ease: card.ease ?? 1,
    reps: card.reps,
    lapses: card.lapses,
    due: card.due,
    dueIso: new Date(card.due).toISOString(),
    history: card.history,
    submissions: card.submissions ?? [],
  }, null, 2) + '\n';
}

// ---------- learner model (ported from Drill — see lib/model.js) ----------

const tagSlugs = (meta) => (meta?.tags || []).map(t => t.slug);

// Per-problem metadata comes from a GraphQL lookup when you open a problem.
// Imported history covers hundreds of problems you haven't reopened, so fall
// back to the catalog (same source, one bulk download) for topics,
// difficulty and title — otherwise they'd land in the jungle as "other".
function metaWithCatalog(metaAll, cat) {
  const out = { ...metaAll };
  for (const slug of Object.keys(cat.bySlug)) {
    if (out[slug]?.tags?.length) continue;
    const c = cat.bySlug[slug];
    out[slug] = { ...(out[slug] || {}), title: out[slug]?.title || c.title, slug,
                  difficulty: out[slug]?.difficulty || c.difficulty, acRate: out[slug]?.acRate ?? c.acRate,
                  tags: (c.tags || []).map(t => ({ slug: t, name: t })), fromCatalog: true };
  }
  return out;
}

// A graded history entry is a SOLVE for the model only if it really was one:
// not graded Again, not after peeking at the editorial/solutions, and not
// attached to a failing verdict.
function attemptCorrect(h) {
  if (h.q === 0) return 0;
  if (h.factors?.peeked) return 0;
  if (h.submission?.status && !/accepted/i.test(h.submission.status)) return 0;
  return 1;
}

const SESSION_GAP_MS = 3 * 3600e3;
/**
 * Every attempt the model learns from:
 *   - graded attempts (history), scored by attemptCorrect;
 *   - submission sessions you never graded: no AC => you tried and left (a
 *     miss); AC => you solved it and closed the modal (a solve). Without
 *     these, walking away from a problem looked like never having tried it.
 */
function cardsToAttempts(cards, metaAll) {
  const out = [];
  for (const c of Object.values(cards)) {
    if (!c?.slug) continue;
    const tags = tagSlugs(metaAll[c.slug]);
    const hist = c.history ?? [];
    for (const h of hist) {
      // Pre-fix (v1) predictions had already seen the outcome — drop them
      // rather than let them pass for calibration evidence.
      out.push({ slug: c.slug, ts: h.t, correct: attemptCorrect(h), tags, pPred: h.pPredV === 2 ? (h.pPred ?? null) : null,
                 seconds: h.durationMs ? h.durationMs / 1000 : null, verdict: h.submission?.status ?? null,
                 factors: h.factors ?? null, kind: 'graded' });
    }
    // NeetCode completions have no time: they can't join a submission session,
    // but they ARE evidence you solved it. Count one solve, placed at the very
    // start of history (no recall bonus, no fake activity), and only when
    // nothing dated already covers the problem.
    const allSubs = c.submissions ?? [];
    const dated = allSubs.filter(x => !x.undated);
    if (allSubs.some(x => x.undated) && !hist.length && !dated.length) {
      out.push({ slug: c.slug, ts: 1, correct: 1, tags, pPred: null, seconds: null,
                 verdict: 'Accepted', factors: null, kind: 'neetcode' });
    }
    const subs = dated.slice().sort((a, b) => a.t - b.t);
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const start = group[0].t, end = group[group.length - 1].t;
      const graded = hist.some(h => h.t >= start - 5 * 60e3 && h.t <= end + 6 * 3600e3);
      if (!graded) {
        const ac = group.some(g => /accepted/i.test(g.status));
        out.push({ slug: c.slug, ts: end, correct: ac ? 1 : 0, tags, pPred: null, seconds: null,
                   verdict: group[group.length - 1].status, factors: null, kind: ac ? 'ungraded-ac' : 'abandoned' });
      }
      group = [];
    };
    for (const sub of subs) {
      if (group.length && sub.t - group[group.length - 1].t > SESSION_GAP_MS) flush();
      group.push(sub);
    }
    flush();
  }
  return out.sort((a, b) => a.ts - b.ts);
}

let catalogMemo = { at: -1, rows: [], bySlug: {} };
async function catalogIndex() {
  const cat = await getCatalog();
  if (!cat) return catalogMemo;
  if (cat.fetchedAt !== catalogMemo.at) {
    const D = { E: 'Easy', M: 'Medium', H: 'Hard' };
    const rows = cat.rows.map(r => ({ slug: r.s, title: r.t, difficulty: D[r.d], acRate: r.a, paid: !!r.p, tags: r.g, id: r.n }));
    catalogMemo = { at: cat.fetchedAt, rows, bySlug: Object.fromEntries(rows.map(r => [r.slug, r])) };
  }
  return catalogMemo;
}

const CATALOG_MAX_AGE = 7 * 24 * 3600e3;
let catalogFetching = null;
let catalogStatus = { refreshing: false, done: 0, total: 0, error: null };

// The extension ships a snapshot (data/catalog.json, refreshed with
// scripts/update-catalog.mjs) so recommendations work the moment it's
// installed. Before this, the first new tab sat on "Thinking…" for ~30s
// while 42 catalog pages downloaded one after another.
async function loadBundledCatalog() {
  try {
    const res = await fetch(chrome.runtime.getURL('data/catalog.json'));
    const snap = await res.json();
    if (Array.isArray(snap?.rows) && snap.rows.length > 1000) {
      await chrome.storage.local.set({ catalog: { fetchedAt: snap.fetchedAt || 0, rows: snap.rows, bundled: true } });
      return true;
    }
  } catch (e) {
    console.warn('[lcanki] bundled catalog unavailable:', e?.message || e);
  }
  return false;
}

async function haveCatalog() {
  if (await getCatalog()) return true;
  return loadBundledCatalog();
}

function ensureCatalog({ force = false } = {}) {
  if (catalogFetching) return catalogFetching;
  catalogFetching = (async () => {
    try {
      await haveCatalog();
      const cat = await getCatalog();
      if (!force && cat && Date.now() - cat.fetchedAt < CATALOG_MAX_AGE) return;
      catalogStatus = { refreshing: true, done: 0, total: 0, error: null };
      const rows = await fetchCatalog({
        onProgress: (done, total) => { catalogStatus.done = done; catalogStatus.total = total; },
      });
      if (rows.length > 1000) await setCatalog(rows);   // never replace a good catalog with a partial one
    } catch (e) {
      catalogStatus.error = e?.message || String(e);
      console.warn('[lcanki] catalog refresh failed (keeping the current list):', catalogStatus.error);
    } finally {
      catalogStatus.refreshing = false;
      catalogFetching = null;
    }
  })();
  return catalogFetching;
}

/** Everything the model needs, built from local data. */
async function learnerState({ keep = null } = {}) {
  await haveCatalog();
  const cat = await catalogIndex();
  const [cards, metaAll] = [await getCards(), metaWithCatalog(await getAllMeta(), cat)];
  const known = {};
  for (const [slug, m] of Object.entries(metaAll)) {
    if (m.fromCatalog && !cards[slug]) continue;     // only problems you've touched
    known[slug] = {
      slug, title: m.title || cards[slug]?.title || slug, difficulty: m.difficulty,
      acRate: m.acRate ?? cat.bySlug[slug]?.acRate ?? null, tags: tagSlugs(m), similar: m.similar || [],
    };
  }
  const items = { ...cat.bySlug, ...known };
  const all = cardsToAttempts(cards, metaAll);
  const attempts = keep ? all.filter(keep) : all;
  return { st: replay(attempts, items), attempts, known, cards, metaAll, cat };
}

// Every dated solve: Accepted submissions and graded attempts that counted.
function solveTimes(c) {
  return [
    ...(c.history ?? []).filter(h => attemptCorrect(h)).map(h => h.t),
    ...(c.submissions ?? []).filter(x => !x.undated && /accepted/i.test(x.status)).map(x => x.t),
  ].filter(Number.isFinite);
}

function firstSolvedAt(c) {
  const ts = [
    ...(c.history ?? []).filter(h => attemptCorrect(h)).map(h => h.t),
    ...(c.submissions ?? []).filter(x => !x.undated && /accepted/i.test(x.status)).map(x => x.t),
  ];
  const ok = ts.filter(Number.isFinite);
  if (ok.length) return Math.min(...ok);
  const h0 = c.history?.[0]?.t;
  return (c.reps ?? 0) > 0 && Number.isFinite(h0) ? h0 : null;
}

function solvedProblems(cards, metaAll, nc = null) {
  const out = [];
  for (const c of Object.values(cards)) {
    if (!c?.slug || !isSolved(c)) continue;
    const m = metaAll[c.slug];
    const first = firstSolvedAt(c);
    // Solved only on NeetCode (no date): sort before everything dated, so
    // these form the trunk near the centre rather than a fake burst today.
    const undated = first == null && (c.submissions ?? []).some(x => x.undated);
    out.push({
      slug: c.slug, title: c.title || c.slug, site: c.site || 'leetcode',
      tags: tagSlugs(m), tagNames: (m?.tags || []).map(t => t.name),
      difficulty: m?.difficulty ?? null,
      acRate: m?.acRate ?? null,                 // with the label, places it by difficulty
      t: undated ? 0 : (first ?? c.history?.[0]?.t ?? Date.now()),
      undated,
      due: c.due ?? null, reviews: (c.history ?? []).length, lapses: c.lapses ?? 0,
      url: normalizeProblemUrl(c.lastUrl || problemUrl(c.site || 'leetcode', c.slug)),
      nc: nc?.bySlug[c.slug]?.n ?? null,
      // what the growth view links by: LeetCode's curated similar questions,
      // then NeetCode's pattern (e.g. "1-D Dynamic Programming")
      similar: m?.similar ?? [],
      pattern: nc?.bySlug[c.slug]?.p ?? null,
      starred: !!c.starred,                      // ★ come back to this
      solveTimes: solveTimes(c),                 // for phases; dropped before it leaves the worker
    });
  }
  return out.sort((a, b) => a.t - b.t || (a.slug < b.slug ? -1 : 1));
}

// ---------- NeetCode ----------
// data/neetcode.json (scripts/update-neetcode.mjs): LeetCode slug -> NeetCode
// page slug, pattern, and list membership (bit 1 NeetCode 150, 2 NeetCode
// 250, 4 Blind 75).
let ncMemo = null;
async function neetcodeIndex() {
  if (ncMemo) return ncMemo;
  try {
    const snap = await (await fetch(chrome.runtime.getURL('data/neetcode.json'))).json();
    const bySlug = Object.fromEntries((snap.rows || []).map(r => [r.s, r]));
    ncMemo = {
      bySlug,
      nc150: snap.rows.filter(r => r.f & 1).map(r => r.s),
      nc250: snap.rows.filter(r => r.f & 2).map(r => r.s),
    };
  } catch (e) {
    ncMemo = { bySlug: {}, nc150: [], nc250: [] };
  }
  return ncMemo;
}
const neetcodeUrl = (ncSlug) => (ncSlug ? `https://neetcode.io/problems/${ncSlug}` : null);

/**
 * Merge NeetCode's completed list (LeetCode slugs, read from neetcode.io by
 * content/neetcode-sync.js). NeetCode keeps no dates, so each becomes one
 * undated Accepted entry with a stable id — re-syncs never duplicate, and
 * undated entries are kept out of the daily tracker and streak. New problems
 * join reviews a few a day, like an import.
 */
async function mergeNeetcodeProgress(slugs, account) {
  const valid = [...new Set(slugs.map(x => String(x).toLowerCase()).filter(x => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(x)))];
  const cards = await getCards();
  const cat = await catalogIndex();
  const nc = await neetcodeIndex();
  const now = Date.now();
  let added = 0, newCards = 0;
  for (const slug of valid) {
    let c = cards[slug];
    if (!c) {
      c = newCard(slug, cat.bySlug[slug]?.title || nc.bySlug[slug]?.t || slugTitle(slug), 'leetcode');
      c.lastUrl = `https://leetcode.com/problems/${slug}/`;
      c.imported = true;
      c.due = Number.MAX_SAFE_INTEGER;            // scheduled just below
      cards[slug] = c;
      newCards += 1;
    }
    c.submissions = c.submissions || [];
    const id = `nc:${slug}`;
    if (c.submissions.some(x => x.id === id)) continue;
    c.submissions.push({ t: now, status: 'Accepted', id, source: 'neetcode', undated: true });
    added += 1;
  }
  const st = await getImportState();
  const scheduled = scheduleImported(cards, st?.perDay || 5, now);
  if (added || scheduled) await setCards(cards);
  await chrome.storage.local.set({ neetcodeSync: { at: now, count: valid.length, account, added, newCards } });
  return { ok: true, added, newCards, total: valid.length };
}

// ---------- goals ----------
async function richMeta() {
  await haveCatalog();
  return metaWithCatalog(await getAllMeta(), await catalogIndex());
}

async function getGoalsWithProgress() {
  const [goals, activeId, cards, metaAll] = [await getGoals(), await getActiveGoalId(), await getCards(), await richMeta()];
  const solved = solvedProblems(cards, metaAll);
  return {
    ok: true,
    activeId: goals.some(g => g.id === activeId) ? activeId : (goals[0]?.id ?? null),
    goals: goals.map(g => ({ ...g, progress: goalProgress(g, solved) })),
    totalSolved: solved.length,
    presets: { blind75: PRESETS.blind75.slugs.length, interviewTags: INTERVIEW_TAGS },
  };
}

async function saveGoal(fields) {
  let f = { ...fields };
  if (f.preset === 'blind75') f = { ...PRESETS.blind75, ...f, type: 'list', slugs: PRESETS.blind75.slugs };
  if (f.preset === 'nc150' || f.preset === 'nc250') {
    const nc = await neetcodeIndex();
    const slugs = f.preset === 'nc150' ? nc.nc150 : nc.nc250;
    f = { name: f.preset === 'nc150' ? 'NeetCode 150' : 'NeetCode 250', ...f, type: 'list', slugs };
  }
  if (f.type === 'list' && typeof f.slugsText === 'string') f.slugs = parseSlugList(f.slugsText);
  if (f.type === 'list' && !f.slugs?.length) return { ok: false, error: 'a list goal needs at least one problem' };
  if (f.type === 'tags' && !f.tags?.length) return { ok: false, error: 'pick at least one topic' };
  const goals = await getGoals();
  const prev = goals.find(g => g.id === f.id);
  const g = makeGoal({ ...prev, ...f });
  const next = prev ? goals.map(x => (x.id === g.id ? g : x)) : [...goals, g];
  await setGoals(next);
  if (!prev) await setActiveGoalId(g.id);
  return { ok: true, goal: g };
}

async function deleteGoal(id) {
  const goals = (await getGoals()).filter(g => g.id !== id);
  await setGoals(goals);
  if ((await getActiveGoalId()) === id) await setActiveGoalId(goals[0]?.id ?? null);
  return { ok: true };
}

async function goalById(id) {
  const goals = await getGoals();
  return goals.find(g => g.id === id) || null;
}

// Imported and NeetCode-synced problems never had their metadata fetched,
// and metadata from before v0.3 has no `similar` field — so the growth view
// can't link them by similar question. Fill those in slowly in the
// background (one request every ~0.4s, a batch per run) so links improve
// over a few visits without hammering LeetCode.
let similarBackfill = null;
let lastBackfillAt = 0;
function backfillSimilar(cards) {
  if (similarBackfill || Date.now() - lastBackfillAt < 10 * 60e3) return;
  lastBackfillAt = Date.now();
  similarBackfill = (async () => {
    try {
      const metaAll = await getAllMeta();
      const todo = Object.values(cards)
        .filter(c => isSolved(c) && !(metaAll[c.slug] && Array.isArray(metaAll[c.slug].similar)))
        .map(c => c.slug)
        .slice(0, 80);
      for (const slug of todo) {
        try {
          const m = await fetchQuestionMeta(slug);
          if (m) await upsertMeta(slug, m);
        } catch (e) { break; }                  // offline or rate-limited: try again next run
        await new Promise(r => setTimeout(r, 400));
      }
    } finally {
      similarBackfill = null;
    }
  })();
}

// ---------- prep phases ----------
// Named date windows ("Company A 2026") that group problems by the day you
// first solved them; the rest is "Unstructured". Stored in chrome.storage and
// edited in Options. The very first time, a personal seed can come from
// data/phases.local.json (git-ignored; format in data/phases.example.json),
// so your own timeline never lands in the repo.
// The seed file carries a version: a newer seed replaces phases that came
// from an older seed, but never ones you've edited in Options.
const PHASES_META = 'phasesMeta';              // { seedVersion, edited }
async function readPhaseSeed() {
  try {
    const r = await fetch(chrome.runtime.getURL('data/phases.local.json'));
    if (r.ok) { const j = await r.json(); return { version: Number(j.version) || 1, phases: j.phases || [] }; }
  } catch (e) { /* no seed file */ }
  return null;
}
async function loadPhases() {
  const raw = await getPhasesRaw();
  const meta = (await chrome.storage.local.get(PHASES_META))[PHASES_META] || {};
  if (raw !== undefined && meta.edited) return normalizePhases(raw);
  const seed = await readPhaseSeed();
  if (raw !== undefined && !(seed && seed.version > (meta.seedVersion || 0))) return normalizePhases(raw);
  const phases = normalizePhases(seed?.phases || []);
  await setPhases(phases);
  await chrome.storage.local.set({ [PHASES_META]: { seedVersion: seed?.version || 0, edited: false } });
  return phases;
}

async function savePhases(list) {
  const r = validatePhases(list);
  if (!r.ok) return r;
  await setPhases(r.phases);
  const meta = (await chrome.storage.local.get(PHASES_META))[PHASES_META] || {};
  await chrome.storage.local.set({ [PHASES_META]: { ...meta, edited: true } });
  return { ok: true, phases: r.phases };
}

// The new tab paints straight from a cached view. Keep that cache current
// here — whenever anything the graph shows changes, recompute it (debounced)
// into storage, which the page reads in its <head> without waking this
// worker — so a tab opened right after a solve never flashes the old graph.
const HOME_DEPS = ['cards', 'goals', 'activeGoal', 'phases', 'phasesMeta', 'meta', 'catalog'];
let homeTimer = null;
chrome.storage.onChanged?.addListener((changes, area) => {
  if (area !== 'local' || !HOME_DEPS.some(k => k in changes)) return;
  clearTimeout(homeTimer);
  homeTimer = setTimeout(refreshHomeCache, 600);
});
async function refreshHomeCache() {
  try {
    const home = await getHome();
    if (home?.ok) await chrome.storage.local.set({ homeCache: { ...home, at: Date.now() } });
  } catch (e) { /* the page falls back to asking */ }
}

/** Everything the new-tab graph needs, in one round trip: goals + the active goal's view. */
async function getHome() {
  const goals = await getGoalsWithProgress();
  const view = await getGoalView(goals.activeId);
  return { ok: !!view?.ok, goals, view };
}

/** Problems for the radial growth view, oldest first, each tagged with its phase. */
async function getGoalView(id) {
  const [cards, metaAll, nc, phases] = [await getCards(), await richMeta(), await neetcodeIndex(), await loadPhases()];
  backfillSimilar(cards);
  const goal = id ? await goalById(id) : null;
  const all = solvedProblems(cards, metaAll, nc);
  const problems = goal ? all.filter(p => goalMatches(goal, p.slug, p.tags)) : all;
  for (const p of problems) {
    p.phases = phasesFor(phases, p.solveTimes, p.undated);   // every prep it was solved in
    p.phase = p.phases[0];
    delete p.solveTimes;
  }
  const progress = goal ? goalProgress(goal, all) : { done: all.length, target: Math.max(all.length, 1), pct: 1 };
  return { ok: true, goal, progress, problems, phases: phaseSummary(phases, problems), now: Date.now() };
}

async function getRecommendations(id, k = 5, topic = null) {
  ensureCatalog();                                   // refresh in the background if stale
  const { st, attempts, known, cat } = await learnerState();
  const nc = await neetcodeIndex();
  const goal = id ? await goalById(id) : null;
  const catalog = cat.rows.length ? cat.rows : Object.values(known);
  const goalMatch = goal && goal.type !== 'all' ? (it) => goalMatches(goal, it.slug, it.tags || []) : null;
  let modelGoal = goalMatch ? { tags: goal.type === 'tags' ? goal.tags : [], matches: goalMatch } : null;
  // A topic (clicked on the graph) means problems on that arc only: within
  // the active goal when it still has some there, else from anywhere.
  const inTopic = topic ? (it) => primaryTopic(it.tags || []) === topic : null;
  if (topic) modelGoal = { tags: topicTags(topic), matches: goalMatch ? (it) => inTopic(it) && goalMatch(it) : inTopic };
  // Seeded per day + per attempt, so the list is stable until you do something.
  const seed = [...`${todayKey()}:${attempts.length}:${id || ''}:${topic || ''}`].reduce((h, ch) => (Math.imul(h, 31) + ch.charCodeAt(0)) | 0, 7);
  const kk = Math.min(10, k || 5);
  let recs = recommend({ st, catalog, known, rng: mulberry32(seed), goal: modelGoal, k: kk });
  if (topic) {
    recs = recs.filter(r => r.onGoal);
    if (!recs.length && goalMatch) {
      recs = recommend({ st, catalog, known, rng: mulberry32(seed), goal: { tags: topicTags(topic), matches: inTopic }, k: kk }).filter(r => r.onGoal);
    }
  }
  return {
    ok: true,
    recs: recs.map(r => ({
      slug: r.item.slug, title: r.item.title || r.item.slug, difficulty: r.item.difficulty ?? null,
      tags: r.item.tags || [], p: r.p, recall: r.recall, reason: r.reason, variant: r.variant,
      retry: r.retry, onGoal: r.onGoal, url: `https://leetcode.com/problems/${r.item.slug}/`,
      ncUrl: neetcodeUrl(nc.bySlug[r.item.slug]?.n),
      evidence: evidenceFor(r.item, attempts, known, 3),
    })),
    // Weakest among the goal's own topics when it has them — "you're weak at
    // combinatorics" is noise when you're preparing for a Google loop.
    weakest: mastery(st).filter(m => m.confident && (goal?.type !== 'tags' || goal.tags.includes(m.concept))).slice(0, 3),
    calibration: calibration(attempts),
    attempts: attempts.length,
    catalog: {
      size: cat.rows.length, fetchedAt: cat.at > 0 ? cat.at : null,
      refreshing: catalogStatus.refreshing, done: catalogStatus.done, total: catalogStatus.total,
      error: catalogStatus.error,
    },
  };
}

// ---------- LeetCode history import ----------
// The content script pages through your submissions (newest first) and hands
// each page here. Everything is merged by submission id — the same id the
// live verdict detector stores — so imports never double-count, and a re-run
// stops as soon as it reaches a page it has already seen.
const IMPORT_KEY = 'importState';
async function getImportState() { return (await chrome.storage.local.get(IMPORT_KEY))[IMPORT_KEY] || null; }
async function setImportState(st) { await chrome.storage.local.set({ [IMPORT_KEY]: st }); }

async function startImport(perDay = 5) {
  const prev = await getImportState();
  if (prev?.running && Date.now() - (prev.heartbeat || 0) < 60e3) return { ok: false, error: 'an import is already running' };
  let [tab] = await chrome.tabs.query({ url: ['https://leetcode.com/problems/*'] });
  let opened = false;
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://leetcode.com/problems/two-sum/description/', active: false });
    opened = true;
  }
  const st = {
    running: true, startedAt: Date.now(), heartbeat: Date.now(), tabId: tab.id, opened,
    perDay: Math.min(50, Math.max(1, +perDay || 5)), pages: 0, added: 0, newCards: 0,
    completedOnce: !!prev?.completedOnce, error: null, cancelled: false,
  };
  await setImportState(st);
  // The tab may still be loading, or predate an extension reload (no content
  // script yet): retry, reloading it once if it never answers.
  for (let i = 0; i < 20; i++) {
    try {
      const r = await chrome.tabs.sendMessage(tab.id, { kind: 'lc-import-run', cursor: {} });
      if (r?.started) return { ok: true, opened };
    } catch (e) { /* not ready yet */ }
    if (i === 8) chrome.tabs.reload(tab.id).catch(() => {});
    await new Promise(r => setTimeout(r, 750));
  }
  await setImportState({ ...st, running: false, error: 'could not reach a LeetCode tab — open any LeetCode problem and try again' });
  return { ok: false, error: 'could not reach a LeetCode tab' };
}

/** Pure merge, exported for tests via the message router. */
function mergeSubmissions(cards, subs) {
  let added = 0, newCards = 0;
  const touched = new Set();
  for (const x of subs) {
    const slug = x?.titleSlug;
    if (!slug || x.id == null) continue;
    const id = String(x.id);
    let c = cards[slug];
    if (!c) {
      c = newCard(slug, x.title || slugTitle(slug), 'leetcode');
      c.lastUrl = `https://leetcode.com/problems/${slug}/`;
      c.imported = true;
      c.due = Number.MAX_SAFE_INTEGER;     // placeholder: scheduled when the import finishes
      cards[slug] = c;
      newCards += 1;
    }
    c.submissions = c.submissions || [];
    if (c.submissions.some(s => s.id === id)) continue;
    const entry = { t: Number(x.timestamp) * 1000, status: x.statusDisplay || 'Unknown', id, source: 'import' };
    if (x.lang) entry.lang = x.lang;
    if (x.runtime && x.runtime !== 'N/A') entry.runtime = x.runtime;
    if (x.memory && x.memory !== 'N/A') entry.memory = x.memory;
    c.submissions.push(entry);
    touched.add(slug);
    added += 1;
  }
  for (const slug of touched) cards[slug].submissions.sort((a, b) => a.t - b.t);
  return { added, newCards };
}

async function importBatch(subs, cursor) {
  const st = await getImportState();
  if (!st?.running || st.cancelled) return { ok: true, stop: true };
  const cards = await getCards();
  const { added, newCards } = mergeSubmissions(cards, subs);
  await setCards(cards);
  const next = { ...st, pages: st.pages + 1, added: st.added + added, newCards: st.newCards + newCards,
                 cursor, heartbeat: Date.now() };
  // Caught up: a whole page we already had, after at least one full import.
  const caughtUp = added === 0 && st.completedOnce;
  await setImportState(next);
  if (caughtUp) { await finishImport(next); return { ok: true, stop: true }; }
  return { ok: true, stop: false };
}

async function importProgress(msg) {
  const st = (await getImportState()) || {};
  if (msg.finished) { await finishImport(st); return { ok: true }; }
  const error = msg.error === 'not-logged-in'
    ? 'LeetCode says you’re not logged in — sign in at leetcode.com in Chrome, then import again'
    : msg.error;
  // Whatever arrived before the failure still gets a real schedule, so no
  // imported problem is left sitting on its placeholder due date.
  const cards = await getCards();
  const scheduled = scheduleImported(cards, st.perDay || 5);
  if (scheduled) await setCards(cards);
  await setImportState({ ...st, running: false, error });
  if (st.opened && st.tabId) chrome.tabs.remove(st.tabId).catch(() => {});
  return { ok: true };
}

/**
 * Give imported problems a review schedule that trickles in instead of
 * dumping hundreds into "due now": `perDay` a day from tomorrow, the problems
 * you touched longest ago first (most likely forgotten).
 */
function scheduleImported(cards, perDay, now = Date.now()) {
  const pending = Object.values(cards).filter(c => c.imported && c.due === Number.MAX_SAFE_INTEGER);
  const lastTouch = (c) => (c.submissions?.length ? c.submissions[c.submissions.length - 1].t : 0);
  pending.sort((a, b) => lastTouch(a) - lastTouch(b));
  const start = new Date(now);
  start.setHours(9, 0, 0, 0);
  start.setDate(start.getDate() + 1);
  pending.forEach((c, i) => {
    const d = new Date(start);
    d.setDate(d.getDate() + Math.floor(i / perDay));
    c.due = d.getTime() + (i % perDay) * 60e3;
    c.intervalMin = 0;
  });
  return pending.length;
}

async function finishImport(st) {
  const cards = await getCards();
  const scheduled = scheduleImported(cards, st.perDay || 5);
  await setCards(cards);
  await setImportState({ ...st, running: false, completedOnce: true, finishedAt: Date.now(), scheduled, error: null });
  if (st.opened && st.tabId) chrome.tabs.remove(st.tabId).catch(() => {});
}

// ---------- Drill bridge ----------
// The attempt log in Drill's `attempts` table shape (src/embed/engine.py
// SCHEMA), one JSON object per line, items namespaced "lc:<slug>". Committed
// to the tracker repo as drill/attempts.jsonl and downloadable from Options,
// so Drill's analysis (calibration, experiment_report) can run on real
// LeetCode practice.
async function drillAttemptsJsonl() {
  const [metaAll, cat] = [await richMeta(), await catalogIndex()];
  const attempts = cardsToAttempts(await getCards(), metaAll);
  return attempts.map(a => JSON.stringify({
    user: 'leetcode', item: `lc:${a.slug}`, ts: a.ts / 1000, correct: a.correct,
    p_pred: a.pPred, n_pass: null, n_tests: null, verdict: a.verdict, seconds: a.seconds,
    code: '', phase: 'practice', kind: a.kind, concepts: a.tags, factors: a.factors,
    // what the extension's difficulty prior was built from, so Drill's prior
    // check doesn't have to re-fetch today's (drifted) acceptance rates
    difficulty: metaAll[a.slug]?.difficulty ?? cat.bySlug[a.slug]?.difficulty ?? null,
    acRate: metaAll[a.slug]?.acRate ?? cat.bySlug[a.slug]?.acRate ?? null,
  })).join('\n') + (attempts.length ? '\n' : '');
}

// ---------- quant-drills bridge ----------
// The quant-drills static site has no GitHub token; it posts a full card and we
// own the commit. We write ONLY under quant/ (+ quant/README.md dashboard) and
// NEVER the global README.md/log.md/stats.json, so leetcode + quant coexist in
// one repo without clobbering each other.
let quantQueue = Promise.resolve();   // serialize commits: one branch-ref update at a time

// Only accept quant grades from the trusted quant-drills origins. The manifest
// match is port-agnostic, so this is the real gate. Keep in sync with the
// allow-list in content/quant.js. card.id is additionally validated below so a
// crafted id can never escape the quant/ prefix.
const QUANT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
function quantSenderAllowed(sender) {
  try {
    const u = new URL((sender && sender.url) || '');
    if (u.protocol === 'file:') return true;   // user opening the static site off disk
    if (u.origin === 'http://localhost:8765' || u.origin === 'http://127.0.0.1:8765') return true;
    if (u.origin === 'https://cmbenello.github.io' && u.pathname.startsWith('/quant')) return true;
  } catch (e) {}
  return false;
}

function quantFmtDate(ms) { return dayKeyMs(ms); }

function quantMetaJson(card) {
  const sr = card.sr || {};
  const due = (sr.dueTs != null) ? sr.dueTs : Date.now();
  const lapses = (card.history || []).filter(h => h.result === 'incorrect').length;
  return JSON.stringify({
    slug: card.id, title: card.title, site: 'quant', url: card.url,
    difficulty: card.difficulty || null, difficultyNum: card.difficultyNum ?? null,
    tags: Array.isArray(card.tags) ? card.tags : [],
    intervalMin: Math.round((sr.intervalDays || 0) * 1440),
    reps: sr.reps || 0, lapses, ease: sr.ease ?? null,
    due, dueIso: new Date(due).toISOString(), history: card.history || [],
  }, null, 2) + '\n';
}
function quantStatementMd(card) {
  const L = [`# ${card.title}`, '', card.statement || ''];
  if (Array.isArray(card.parts)) card.parts.forEach((pt, i) => { L.push('', pt.prompt || `Part ${i + 1}`); });
  L.push('', '---', `_Source: ${card.source || 'quant-drills'}_`);
  return L.join('\n') + '\n';
}
function quantSolutionMd(card) {
  const L = [`# Solution — ${card.title}`, ''];
  if (Array.isArray(card.parts)) {
    card.parts.forEach((pt, i) => {
      L.push(`## Part ${String.fromCharCode(97 + i)}`);
      if (pt.answer != null) L.push(`**Answer:** \`${pt.answer}\``, '');
      L.push(pt.solution || '_(no solution)_', '');
    });
  } else {
    if (card.answer != null) L.push(`**Answer:** \`${card.answer}\``, '');
    L.push(card.solution || '_(no solution)_', '');
  }
  if (card.hints && card.hints.length) { L.push('## Hints'); card.hints.forEach((h, i) => L.push(`${i + 1}. ${h}`)); }
  return L.join('\n') + '\n';
}
function quantProblemReadme(card) {
  const sr = card.sr || {};
  const due = (sr.dueTs != null) ? sr.dueTs : Date.now();
  const lapses = (card.history || []).filter(h => h.result === 'incorrect').length;
  const L = [`# ${card.title}`, ''];
  L.push(`**Difficulty:** ${card.difficulty || '?'}${card.difficultyNum ? ` (${card.difficultyNum}/5)` : ''}  `);
  if (card.topic) L.push(`**Topic:** ${card.topic}  `);
  if (card.firms && card.firms.length) L.push(`**Firms:** ${card.firms.join(', ')}  `);
  L.push('**Site:** quant-drills', '');
  L.push('## Status');
  L.push(`- **Reps:** ${sr.reps || 0}`);
  L.push(`- **Lapses:** ${lapses}`);
  L.push(`- **Ease:** ${sr.ease ?? '—'}`);
  L.push(`- **Interval:** ${sr.intervalDays ? sr.intervalDays + ' d' : '—'}`);
  L.push(`- **Next due:** ${quantFmtDate(due)}`, '');
  L.push('See [statement.md](./statement.md), [solution.md](./solution.md). [notes.md](./notes.md) is yours — never overwritten.', '');
  L.push('## Review history', '');
  const hist = card.history || [];
  if (!hist.length) L.push('_No reviews yet._');
  else {
    L.push('| When | Result | Confidence |', '| --- | --- | --- |');
    hist.slice().reverse().forEach(h => {
      const when = new Date(h.t).toISOString().replace('T', ' ').slice(0, 16);
      L.push(`| ${when} | ${h.result} | ${h.conf != null ? Math.round(h.conf * 100) + '%' : '—'} |`);
    });
  }
  L.push('', '---', '_Auto-generated by the quant-drills bridge on every grade._');
  return L.join('\n') + '\n';
}
function quantSeedNotes(card) {
  return [`# Notes — ${card.title}`, '', 'This file is yours; the bridge never overwrites it after this seed.', '',
    '## My approach', '', '_…_', '', '## Where I slipped', '', '_…_', ''].join('\n');
}
function quantDashboard(index) {
  const now = Date.now();
  const rows = Object.keys(index).map(id => ({ id, ...index[id] }));
  const due = rows.filter(r => (r.due || 0) <= now).sort((a, b) => (a.due || 0) - (b.due || 0));
  const diff = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  rows.forEach(r => { if (diff[r.difficulty] != null) diff[r.difficulty]++; else diff.Unknown++; });
  const reviews = rows.reduce((s, r) => s + (r.reviews || 0), 0);
  const L = ['# Quant Drills — spaced repetition', ''];
  L.push(`_Auto-generated. ${rows.length} cards · ${reviews} reviews · ${due.length} due now._`, '');
  L.push(`**By difficulty:** Easy ${diff.Easy} · Medium ${diff.Medium} · Hard ${diff.Hard}${diff.Unknown ? ` · Unknown ${diff.Unknown}` : ''}`, '');
  L.push(`## Due now (${due.length})`, '');
  if (!due.length) L.push('_Nothing due. 🎉_');
  else {
    L.push('| Problem | Difficulty | Reps | Due |', '| --- | --- | --- | --- |');
    due.slice(0, 50).forEach(r => L.push(`| [${r.title || r.id}](./${r.id}/) | ${r.difficulty || '—'} | ${r.reps || 0} | ${quantFmtDate(r.due || now)} |`));
  }
  L.push('', `## All cards (${rows.length})`, '');
  L.push('| Problem | Difficulty | Reps | Lapses | Next due |', '| --- | --- | --- | --- | --- |');
  rows.sort((a, b) => (a.due || 0) - (b.due || 0)).forEach(r =>
    L.push(`| [${r.title || r.id}](./${r.id}/) | ${r.difficulty || '—'} | ${r.reps || 0} | ${r.lapses || 0} | ${quantFmtDate(r.due || now)} |`));
  L.push('');
  return L.join('\n') + '\n';
}

async function getQuantIndex() { const o = await chrome.storage.local.get('quantCards'); return o.quantCards || {}; }

// Build the per-card files for ONE card and update its index entry in place.
// Returns null for a bad/crafted id (defense-in-depth: never let '../' escape
// the quant/ prefix and clobber a global file).
function quantCardFiles(card, index) {
  if (!card || !QUANT_ID_RE.test(card.id || '')) return null;
  if (!card.sr) card.sr = {};
  const dueNum = Number(card.sr.dueTs);
  card.sr.dueTs = Number.isFinite(dueNum) ? dueNum : Date.now();
  const dir = `quant/${card.id}`;
  const prev = index[card.id] || {};
  const sr = card.sr;
  const lapses = (card.history || []).filter(h => h.result === 'incorrect').length;
  const files = [
    { path: `${dir}/meta.json`, content: quantMetaJson(card) },
    { path: `${dir}/statement.md`, content: quantStatementMd(card) },
    { path: `${dir}/solution.md`, content: quantSolutionMd(card) },
    { path: `${dir}/README.md`, content: quantProblemReadme(card) },
  ];
  let notesCreated = prev.notesCreated;
  if (!notesCreated) { files.push({ path: `${dir}/notes.md`, content: quantSeedNotes(card) }); notesCreated = true; }
  index[card.id] = {
    title: card.title, difficulty: card.difficulty || '—', due: sr.dueTs,
    url: card.url || null, tags: Array.isArray(card.tags) ? card.tags.slice(0, 4) : [],
    reps: sr.reps || 0, lapses, reviews: (card.history || []).length,
    reviewTs: (card.history || []).map(h => h.t).filter(Boolean).slice(-60),  // per-day review timestamps for the heatmap
    lastTs: Date.now(), notesCreated,
  };
  return files;
}

// Public entries from the message router. Both serialize through quantQueue so
// commits never race the branch ref. A single grade is just a batch of one;
// the backfill sends ~20 at a time so 100 solved problems become ~5 commits.
function syncQuantCard(card) {
  if (!card || !card.id) return Promise.resolve({ ok: false, error: 'no card' });
  return syncQuantBatch([card]);
}
function syncQuantBatch(cards) {
  if (!Array.isArray(cards) || !cards.length) return Promise.resolve({ ok: false, error: 'no cards' });
  const run = () => doSyncQuantBatch(cards);
  quantQueue = quantQueue.then(run, run);   // continue even if a prior commit rejected
  return quantQueue;
}
async function doSyncQuantBatch(cards) {
  const settings = await getSettings();
  if (!settings.syncEnabled || !settings.githubToken || !settings.githubRepo) {
    return { ok: false, error: 'tracker sync is off — enable it (+ token + repo) in the extension options' };
  }
  const index = await getQuantIndex();
  let files = [];
  const syncedIds = [];
  for (const card of cards) {
    const f = quantCardFiles(card, index);   // also mutates index[card.id]
    if (f) { files = files.concat(f); syncedIds.push(card.id); }
  }
  if (!syncedIds.length) return { ok: false, error: 'no valid cards' };

  // Persist the index BEFORE generating dashboards so both quant/README.md and
  // the repo-root README.md include these cards. On a total commit failure the
  // local index is at worst this batch ahead of the repo; the next sync reconciles.
  await chrome.storage.local.set({ quantCards: index });
  files.push({ path: 'quant/README.md', content: quantDashboard(index) });
  files.push({ path: 'README.md', content: await renderReadme() });   // repo homepage carries a Quant section

  const message = syncedIds.length === 1
    ? `quant/${syncedIds[0]}: sync`
    : `quant: sync ${syncedIds.length} problems`;
  const r = await commitWithRetry({ token: settings.githubToken, repo: settings.githubRepo, message, files });
  if (r.ok) return { ok: true, syncedIds };   // index already persisted above
  console.error('[lcanki quant] batch commit failed', r.cause);
  return { ok: false, error: r.error };
}

// ---------- markdown rendering ----------

function asciiBar(values) {
  const max = Math.max(1, ...values);
  const blocks = ' ▁▂▃▄▅▆▇█';
  return values.map(v => blocks[Math.min(8, Math.round((v / max) * 8))]).join('');
}

// Map raw status strings to short categorical buckets.
function categorizeSubmission(status) {
  if (!status) return null;
  const s = String(status).toLowerCase();
  if (/accepted/.test(s))            return 'ac';
  if (/wrong answer/.test(s))        return 'wa';
  if (/time limit/.test(s))          return 'tle';
  if (/memory limit/.test(s))        return 'mle';
  if (/output limit/.test(s))        return 'ole';
  if (/runtime error/.test(s))       return 're';
  if (/compile error/.test(s))       return 'ce';
  return 'other';
}

function fmtSec(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return sec ? `${m}m ${sec}s` : `${m}m`;
}

function renderInitialNotes(card, meta) {
  const lines = [
    `# Notes — ${card.title}`,
    '',
    'This file is yours. The extension will never overwrite it after this initial seed.',
    '',
    '## Approach',
    '',
    '_Describe how you solved it (or how you intend to). Edge cases, complexity, gotchas._',
    '',
    '## Tricks / patterns',
    '',
    '_What technique did this rely on? (e.g. two pointers, monotonic stack, dp on subsets)._',
    '',
    '## Mistakes to avoid next time',
    '',
    '_Whatever bit you on this attempt._',
    '',
  ];
  return lines.join('\n');
}

function renderProblemReadme(card, meta) {
  const site = card.site || 'leetcode';
  const url = problemUrl(site, card.slug);
  const lines = [];
  lines.push(`# ${card.title}`);
  lines.push('');

  const headerBits = [];
  if (meta?.difficulty) headerBits.push(`**Difficulty:** ${meta.difficulty}`);
  if (meta?.tags?.length) headerBits.push(`**Tags:** ${meta.tags.map(t => t.name).join(', ')}`);
  headerBits.push(`**Site:** [${siteLabel(site)}](${url})`);
  lines.push(headerBits.join('  \n'));
  lines.push('');

  lines.push('## Status');
  lines.push('');
  lines.push(`- **Reps:** ${card.reps}`);
  lines.push(`- **Lapses:** ${card.lapses}`);
  lines.push(`- **Current interval:** ${formatDuration(card.intervalMin)}`);
  if (card.due) {
    lines.push(`- **Next due:** ${dayKeyMs(card.due)}`);
  }

  const history = card.history ?? [];
  if (history.length) {
    const totalDur  = history.reduce((s, h) => s + (h.durationMs || 0), 0);
    const totalRead = history.reduce((s, h) => s + (h.readingMs || 0), 0);
    const totalCode = history.reduce((s, h) => s + (h.codingMs  || 0), 0);
    lines.push(`- **Total time spent:** ${fmtSec(totalDur)}  (read ${fmtSec(totalRead)} · code ${fmtSec(totalCode)})`);
    if (history.length > 1) {
      lines.push(`- **Avg per attempt:** ${fmtSec(totalDur / history.length)}`);
    }
    const subs = card.submissions ?? [];
    if (subs.length) {
      const acs = subs.filter(s => /accepted/i.test(s.status)).length;
      lines.push(`- **AC rate:** ${acs}/${subs.length} attempts`);
      const counts = {};
      for (const s of subs) {
        const cat = categorizeSubmission(s.status);
        if (cat) counts[cat] = (counts[cat] || 0) + 1;
      }
      const breakdown = Object.entries(counts)
        .filter(([k]) => k !== 'ac')
        .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
        .join(' · ');
      if (breakdown) lines.push(`- **Failures:** ${breakdown}`);
    }
  }
  lines.push('');

  lines.push('See [notes.md](./notes.md) for your approach + gotchas — that file is never overwritten by the extension.');
  lines.push('');

  lines.push('## Review history');
  lines.push('');
  if (!history.length) {
    lines.push('_No reviews yet._');
  } else {
    lines.push('| When | Grade | Result | Total | Read | Code | Lang |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of history.slice().reverse()) {
      const when = new Date(h.t).toISOString().replace('T', ' ').slice(0, 16);
      const grade = buttonLabelFor(h.q);
      const result = h.submission?.status || '—';
      lines.push(`| ${when} | ${grade} | ${result} | ${fmtSec(h.durationMs)} | ${fmtSec(h.readingMs)} | ${fmtSec(h.codingMs)} | ${h.lang || '—'} |`);
    }
  }
  lines.push('');
  lines.push('---');
  lines.push('_This page is auto-generated by the LeetCode Anki extension on every grade._');
  return lines.join('\n') + '\n';
}

async function renderSiteReadme(site) {
  const cards = await getCards();
  const meta = await getAllMeta();
  const now = Date.now();

  const all = Object.values(cards).filter(c => (c.site || 'leetcode') === site);
  const dueNow = all.filter(c => (c.due ?? 0) <= now).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  const diff = { Easy: 0, Medium: 0, Hard: 0, Unknown: 0 };
  for (const c of all) {
    const d = meta[c.slug]?.difficulty;
    if (d && diff[d] != null) diff[d] += 1;
    else diff.Unknown += 1;
  }

  const totalReviews = all.reduce((s, c) => s + (c.history?.length ?? 0), 0);
  const totalLapses  = all.reduce((s, c) => s + (c.lapses ?? 0), 0);

  // Per-tag aggregation: walk submission history, bucket by tag.
  // tagStats[tag] = { ac, wa, tle, re, mle, ce, ole, other, total }
  const tagStats = {};
  for (const c of all) {
    const tags = meta[c.slug]?.tags ?? [];
    if (!tags.length) continue;
    for (const h of c.history ?? []) {
      const cat = categorizeSubmission(h.submission?.status);
      if (!cat) continue;
      for (const t of tags) {
        const key = t.name;
        const entry = (tagStats[key] ??= { ac: 0, wa: 0, tle: 0, mle: 0, re: 0, ce: 0, ole: 0, other: 0, total: 0 });
        entry[cat] = (entry[cat] || 0) + 1;
        entry.total += 1;
      }
    }
  }
  const tagRows = Object.entries(tagStats)
    .filter(([, v]) => v.total >= 2)
    .map(([name, v]) => ({ name, ...v, acRate: v.ac / v.total }))
    .sort((a, b) => a.acRate - b.acRate);  // weakest first

  // 30-day activity for THIS site
  const byDay = {};
  for (const c of all) {
    for (const h of c.history ?? []) {
      const d = dayKeyMs(h.t);
      byDay[d] = (byDay[d] || 0) + 1;
    }
  }
  const days = lastNDayKeys(30).map(d => ({ d, n: byDay[d] ?? 0 }));
  const totalRecent = days.reduce((s, x) => s + x.n, 0);

  const lines = [];
  lines.push(`# ${siteLabel(site)} — Tracker`);
  lines.push('');
  lines.push(`- **Tracked:** ${all.length} (Easy ${diff.Easy} · Medium ${diff.Medium} · Hard ${diff.Hard}${diff.Unknown ? ` · ? ${diff.Unknown}` : ''})`);
  lines.push(`- **Total reviews:** ${totalReviews}`);
  lines.push(`- **Lapses:** ${totalLapses}`);
  lines.push(`- **Due now:** ${dueNow.length}`);
  lines.push('');
  lines.push('## Last 30 days');
  lines.push('');
  lines.push('```');
  lines.push(asciiBar(days.map(x => x.n)) + `  (${totalRecent} reviews)`);
  lines.push('```');
  lines.push('');

  if (tagRows.length) {
    lines.push('## Trouble tags');
    lines.push('');
    lines.push('Tags ranked by accept-rate (weakest first). Only tags with ≥2 submissions.');
    lines.push('');
    lines.push('| Tag | AC | WA | TLE | RE | Other | AC rate |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const t of tagRows.slice(0, 15)) {
      const other = t.mle + t.ce + t.ole + t.other;
      const pct = (t.acRate * 100).toFixed(0) + '%';
      lines.push(`| ${t.name} | ${t.ac} | ${t.wa} | ${t.tle} | ${t.re} | ${other} | ${pct} |`);
    }
    lines.push('');
  }

  lines.push('## Due now');
  lines.push('');
  if (!dueNow.length) {
    lines.push('_Nothing due._');
  } else {
    lines.push('| Problem | Difficulty | Reps | Lapses | Last reviewed |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of dueNow.slice(0, 100)) {
      const d = meta[c.slug]?.difficulty ?? '—';
      const last = c.history?.length
        ? dayKeyMs(c.history.at(-1).t)
        : '—';
      lines.push(`| [${c.title}](./${c.slug}/) | ${d} | ${c.reps} | ${c.lapses} | ${last} |`);
    }
  }
  lines.push('');

  lines.push('## All tracked');
  lines.push('');
  if (!all.length) {
    lines.push('_None yet._');
  } else {
    const sorted = all.slice().sort((a, b) => (b.history?.length ?? 0) - (a.history?.length ?? 0));
    lines.push('| Problem | Difficulty | Reps | Lapses | Next due |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const c of sorted) {
      const d = meta[c.slug]?.difficulty ?? '—';
      const due = c.due && inReview(c) ? dayKeyMs(c.due) : '—';
      lines.push(`| [${c.title}](./${c.slug}/) | ${d} | ${c.reps} | ${c.lapses} | ${due} |`);
    }
  }
  return lines.join('\n') + '\n';
}

async function renderLog() {
  const cards = await getCards();
  const meta = await getAllMeta();
  const rows = [];
  for (const c of Object.values(cards)) {
    const site = c.site || 'leetcode';
    for (const h of c.history ?? []) {
      rows.push({
        t: h.t, slug: c.slug, title: c.title, site, q: h.q,
        durationMs: h.durationMs, readingMs: h.readingMs, codingMs: h.codingMs,
        submission: h.submission,
      });
    }
  }
  rows.sort((a, b) => b.t - a.t);

  const lines = [
    '# Review Log',
    '',
    '| When | Site | Problem | Difficulty | Grade | Result | Total | Read | Code |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const r of rows.slice(0, 1000)) {
    const when = new Date(r.t).toISOString().replace('T', ' ').slice(0, 16);
    const grade = buttonLabelFor(r.q);
    const diff = meta[r.slug]?.difficulty ?? '—';
    const result = r.submission?.status || '—';
    lines.push(`| ${when} | ${siteLabel(r.site)} | [${r.title}](./${r.site}/${r.slug}/) | ${diff} | ${grade} | ${result} | ${fmtSec(r.durationMs)} | ${fmtSec(r.readingMs)} | ${fmtSec(r.codingMs)} |`);
  }
  return lines.join('\n') + '\n';
}

async function renderReadme() {
  const cards = await getCards();
  const stats = await getStats();
  const now = Date.now();
  const quantCards = Object.values(await getQuantIndex());
  const quantDue = quantCards.filter(c => (c.due ?? 0) <= now).length;
  const quantReviews = quantCards.reduce((s, c) => s + (c.reviews || 0), 0);

  const all = Object.values(cards);
  const bySite = { leetcode: [], neetcode: [] };
  for (const c of all) (bySite[c.site || 'leetcode'] ??= []).push(c);

  const dueNow = all.filter(c => (c.due ?? 0) <= now);
  const today = todayKey();
  const days = lastNDayKeys(30).map(d => ({ d, n: stats.byDay?.[d] ?? 0 }));

  const lines = [
    '# DSA Spaced Repetition Tracker',
    '',
    'Auto-generated by the [LeetCode Anki](https://github.com/) extension.',
    '',
    `- **Total tracked:** ${all.length} (LeetCode ${bySite.leetcode.length} · NeetCode ${bySite.neetcode.length}) · Quant ${quantCards.length}`,
    `- **Total reviews:** ${stats.totalReviews ?? 0}${quantReviews ? ` (+${quantReviews} quant)` : ''}`,
    `- **Lapses:** ${stats.lapses ?? 0}`,
    `- **Reviewed today:** ${stats.byDay?.[today] ?? 0}`,
    `- **Due now:** ${dueNow.length}`,
    '',
    '## Sites',
    '',
    `- [LeetCode](./leetcode/) — ${bySite.leetcode.length} tracked`,
    `- [NeetCode](./neetcode/) — ${bySite.neetcode.length} tracked`,
    `- [Quant Drills](./quant/) — ${quantCards.length} tracked · ${quantDue} due`,
    '',
    '## Last 30 days (all sites)',
    '',
    '```',
    asciiBar(days.map(x => x.n)) + `  (${days.reduce((s, x) => s + x.n, 0)} reviews)`,
    '```',
    '',
  ];

  return lines.join('\n') + '\n';
}

// ---------- popup data ----------
async function getDueList() {
  const cards = await getCards();
  const meta = await getAllMeta();
  const session = await getSession();
  // Cards already passed in the active session (graded or skipped) should
  // not clutter the displayed due list — that's what makes the list look
  // unchanged after pressing × on a session problem.
  const passed = new Set(
    session ? session.queue.slice(0, session.index).map(q => q.slug) : []
  );
  const now = Date.now();
  const due = [], upcoming = [];
  for (const c of Object.values(cards)) {
    if (passed.has(c.slug) || !inReview(c)) continue;
    const enriched = { ...c, meta: meta[c.slug] ?? null };
    if ((c.due ?? 0) <= now) due.push(enriched); else upcoming.push(enriched);
  }
  due.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  upcoming.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  return {
    ok: true,
    due,
    upcoming: upcoming.slice(0, 30),
    stats: await getStats(),
    total: Object.keys(cards).length,
    session,
  };
}

async function getCardStats(slug) {
  const card = await getCard(slug);
  if (!card) return { ok: false, error: 'no card' };
  const meta = await getMeta(slug);
  const history = card.history ?? [];

  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  let totalDur = 0, totalRead = 0, totalCode = 0, durSamples = 0;
  for (const h of history) {
    const id = h.button ?? buttonIdFor(h.q);
    if (counts[id] != null) counts[id] += 1;
    if (h.durationMs) { totalDur += h.durationMs; durSamples += 1; }
    if (h.readingMs) totalRead += h.readingMs;
    if (h.codingMs)  totalCode += h.codingMs;
  }
  const avgDurMs = durSamples ? totalDur / durSamples : 0;

  // Submission counts come from the per-card submissions array (every attempt),
  // not just the per-grade snapshots — so WA/TLE/RE attempts that never led
  // to a grade still show up.
  const subCounts = { ac: 0, wa: 0, tle: 0, mle: 0, re: 0, ce: 0, ole: 0, other: 0 };
  let submissions = 0, accepts = 0;
  for (const s of (card.submissions ?? [])) {
    const cat = categorizeSubmission(s.status);
    if (!cat) continue;
    subCounts[cat] += 1;
    submissions += 1;
    if (cat === 'ac') accepts += 1;
  }

  return {
    ok: true,
    card,
    meta,
    summary: {
      reviews: history.length,
      counts,
      subCounts,
      lapses: card.lapses,
      reps: card.reps,
      avgDurMs,
      totalReadMs: totalRead,
      totalCodeMs: totalCode,
      firstReviewAt: history[0]?.t ?? null,
      lastReviewAt: history.at(-1)?.t ?? null,
      due: card.due,
      intervalMin: card.intervalMin,
      submissions,
      accepts,
    },
    history,
  };
}

// ---------- retry queue ----------
// Queue items carry the payload needed to rebuild the commit
// ({ slug, code, language, url, message }). The old flush pushed only the
// dashboards and then cleared the queue — silently discarding every failed
// solution commit while reporting "flushed N".
async function flushSyncQueue() {
  const q = await getSyncQueue();
  if (!q.length) return { ok: true, flushed: 0 };

  const settings = await getSettings();
  if (!settings.syncEnabled || !settings.githubToken || !settings.githubRepo) {
    return { ok: false, error: 'sync disabled or unconfigured' };
  }

  // Coalesce: newest payload per slug wins (it has the freshest code/state).
  const latest = new Map();
  for (const item of q) latest.set(item.slug, item);

  const files = [];
  const cards = await getCards();
  for (const item of latest.values()) {
    const card = cards[item.slug];
    if (!card) continue;                       // card deleted since it queued
    files.push(...await problemFiles(card, item.code ?? null, item.language ?? null, item.url, settings));
  }
  const sites = new Set([...latest.values()].map(i => cards[i.slug]?.site).filter(Boolean));
  for (const site of sites) files.push({ path: `${site}/README.md`, content: await renderSiteReadme(site) });
  files.push({ path: 'log.md',     content: await renderLog() });
  files.push({ path: 'stats.json', content: JSON.stringify(await getStats(), null, 2) + '\n' });
  files.push({ path: 'README.md',  content: await renderReadme() });

  const slugs = [...latest.keys()];
  const message = slugs.length === 1
    ? (latest.get(slugs[0]).message || `${cards[slugs[0]]?.site || 'leetcode'}/${slugs[0]}: retry`)
    : `sync: retry ${slugs.length} queued problems`;

  const r = await commitWithRetry({ token: settings.githubToken, repo: settings.githubRepo, message, files });
  if (!r.ok) return { ok: false, error: r.error };
  await setSyncQueue([]);
  return { ok: true, flushed: slugs.length };
}

// Accepted but never graded (you closed the modal): commit the stashed code
// once it's been sitting for a while, so a solved problem always lands in the
// repo. Runs on the hourly alarm.
const PENDING_GRACE_MS = 30 * 60_000;
async function sweepUngradedAccepts() {
  const settings = await getSettings();
  if (!settings.syncEnabled || !settings.githubToken || !settings.githubRepo) return;
  const cards = await getCards();
  const now = Date.now();
  let queued = 0;
  for (const c of Object.values(cards)) {
    if (c.pendingCode == null || now - (c.pendingAt ?? now) < PENDING_GRACE_MS) continue;
    await pushSyncQueue({
      slug: c.slug, t: now, reason: 'ungraded accept',
      code: c.pendingCode, language: c.pendingLang ?? null, url: c.lastUrl,
      message: `${c.site || 'leetcode'}/${c.slug}: AC (ungraded)`,
    });
    delete c.pendingCode; delete c.pendingLang; delete c.pendingAt; delete c.pendingStatus;
    queued += 1;
  }
  if (!queued) return;
  await setCards(cards);
  await flushSyncQueue();
}

// ---------- daily reminder ----------
const REMINDER_ALARM = 'lcanki-daily-reminder';
const RETRY_ALARM = 'lcanki-retry';

function nextOccurrenceMs(hhmm) {
  const [h, m] = hhmm.split(':').map(n => parseInt(n, 10));
  const now = new Date();
  const target = new Date();
  target.setHours(h ?? 9, m ?? 0, 0, 0);
  if (target.getTime() <= now.getTime()) {
    target.setDate(target.getDate() + 1);
  }
  return target.getTime();
}

async function scheduleDailyReminder() {
  const settings = await getSettings();
  await chrome.alarms.clear(REMINDER_ALARM);
  if (!settings.dailyReminderEnabled) return;
  const when = nextOccurrenceMs(settings.dailyReminderTime || '09:00');
  await chrome.alarms.create(REMINDER_ALARM, { when, periodInMinutes: 1440 });
}

async function fireDailyReminder() {
  const cards = await getCards();
  const meta = await getAllMeta();
  const now = Date.now();
  const due = Object.values(cards)
    .filter(c => (c.due ?? 0) <= now)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  if (!due.length) return;

  // 'basic', not 'list': macOS/Windows native notifications drop list items,
  // which left the body EMPTY whenever 5 or fewer problems were due.
  const names = due.slice(0, 3).map(c => {
    const d = meta[c.slug]?.difficulty;
    return `${c.title || c.slug}${d ? ` (${d})` : ''}`;
  });
  const more = due.length > 3 ? ` +${due.length - 3} more` : '';

  chrome.notifications.create('lcanki-daily', {
    type: 'basic',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${due.length} problem${due.length === 1 ? '' : 's'} due today`,
    message: names.join(' · ') + more,
    priority: 1,
  });
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id === 'lcanki-daily') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    chrome.notifications.clear(id);
  }
});

const SWEEP_ALARM = 'lcanki-sweep';
const CATALOG_ALARM = 'lcanki-catalog';

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REMINDER_ALARM) fireDailyReminder().catch(() => {});
  if (a.name === SWEEP_ALARM) sweepUngradedAccepts().catch(() => {});
  if (a.name === CATALOG_ALARM) ensureCatalog();
  // RETRY_ALARM was deliberately removed — sync now happens only on AC and
  // we never auto-flush. If a commit fails, retry manually via the popup.
});

// One-shot migration: re-normalize every stored lastUrl. Older versions of
// the extension saved URLs with /history, /solution, /description, etc.
// suffixes that caused session navigation to land on the wrong view.
async function normalizeAllStoredUrls() {
  const cards = await getCards();
  let changed = 0;
  for (const card of Object.values(cards)) {
    if (!card.lastUrl) continue;
    const fixed = normalizeProblemUrl(card.lastUrl);
    if (fixed !== card.lastUrl) {
      card.lastUrl = fixed;
      changed += 1;
    }
  }
  if (changed) {
    await setCards(cards);
    console.log(`[lcanki] normalized ${changed} card URL(s)`);
  }
}

// ---------- one-shot migrations ----------
// v1: rebuild stats from card history with LOCAL day keys. byDay used to be
// written with UTC keys, so every past evening review is filed under the wrong
// day. History timestamps are exact epoch-ms, so we can recompute precisely
// instead of guessing an offset. totalReviews/lapses are recomputed too so the
// counters can't drift from the cards they summarise.
async function rebuildStatsFromHistory() {
  const cards = await getCards();
  const prev = await getStats();
  const byDay = {};
  let totalReviews = 0, lapses = 0, lastReviewAt = 0;
  for (const c of Object.values(cards)) {
    for (const h of c.history ?? []) {
      if (!h?.t) continue;
      const k = dayKeyMs(h.t);
      byDay[k] = (byDay[k] || 0) + 1;
      totalReviews += 1;
      if ((h.q ?? 4) < 3) lapses += 1;
      if (h.t > lastReviewAt) lastReviewAt = h.t;
    }
  }
  await setStats({ ...prev, totalReviews, lapses, lastReviewAt, byDay });
  return { totalReviews, days: Object.keys(byDay).length };
}

// Clean submissions recorded by the old DOM scraper. Two patterns are
// provably bogus:
//   1. a burst — several verdicts within BURST_MS of each other. A human can't
//      submit twice in a few seconds; that's one submission plus stale history
//      re-renders. Keep only the LAST in the burst (the live verdict).
//   2. exact duplicates — same status within DUP_MS.
// Entries with a network submission id are authoritative and never touched.
const BURST_MS = 10_000;
async function cleanSubmissions({ dryRun = false } = {}) {
  const cards = await getCards();
  let removed = 0, flippedAc = 0, touchedCards = 0;
  for (const c of Object.values(cards)) {
    const subs = (c.submissions ?? []).slice().sort((a, b) => a.t - b.t);
    if (subs.length < 2) continue;
    const keep = [];
    for (let i = 0; i < subs.length; i++) {
      const cur = subs[i];
      if (cur.id) { keep.push(cur); continue; }          // authoritative
      const next = subs[i + 1];
      if (next && !next.id && next.t - cur.t < BURST_MS) {
        // cur is superseded by a later verdict in the same burst
        removed += 1;
        if (/accepted/i.test(cur.status) && !/accepted/i.test(next.status)) flippedAc += 1;
        continue;
      }
      keep.push(cur);
    }
    if (keep.length !== subs.length) {
      touchedCards += 1;
      if (!dryRun) c.submissions = keep;
    }
  }
  // Titles copied from the previous problem: the same title on two different
  // slugs means one of them is a stale copy. Fix any card whose title doesn't
  // match its slug, using LeetCode metadata when we have it.
  const meta = await getAllMeta();
  const byTitle = {};
  for (const c of Object.values(cards)) (byTitle[c.title] ??= []).push(c);
  let titlesFixed = 0;
  for (const c of Object.values(cards)) {
    const shared = (byTitle[c.title]?.length ?? 0) > 1;
    const m = meta[c.slug];
    let fixed = c.title;
    if (m?.title && (m.slug === c.slug || titleMatchesSlug(m.title, c.slug))) fixed = m.title;
    else if (shared && !titleMatchesSlug(c.title, c.slug)) fixed = slugTitle(c.slug);
    if (fixed !== c.title) { titlesFixed += 1; if (!dryRun) c.title = fixed; }
  }

  if (!dryRun && (touchedCards || titlesFixed)) await setCards(cards);
  return { ok: true, removed, phantomAccepts: flippedAc, cards: touchedCards, titlesFixed, dryRun };
}

// v3: persist the normalisation that getCards() applies on every read
// (lib/cards.js), so stored data is clean too.
const SCHEMA_VERSION = 3;
async function runMigrations() {
  const v = await getSchemaVersion();
  if (v < 3) {
    const raw = (await chrome.storage.local.get('cards')).cards || {};
    const fixed = sanitizeCards(raw);
    if (fixed) await setCards(raw);
    console.log('[lcanki] migration v3: normalised card records', { fixed });
  }
  if (v < 1) {
    const r = await rebuildStatsFromHistory();
    console.log('[lcanki] migration v1: rebuilt stats with local day keys', r);
  }
  if (v < 2) {
    const r = await cleanSubmissions();
    console.log('[lcanki] migration v2: cleaned mis-detected submissions + titles', r);
  }
  if (v < SCHEMA_VERSION) await setSchemaVersion(SCHEMA_VERSION);
}

function bootstrap() {
  // Clear any RETRY_ALARM lingering from a previous version — Chrome alarms
  // are persistent across extension reloads and would otherwise keep firing
  // dashboard-refresh commits.
  chrome.alarms.clear(RETRY_ALARM).catch(() => {});
  scheduleDailyReminder().catch(() => {});
  normalizeAllStoredUrls().catch(() => {});
  runMigrations().catch((e) => console.warn('[lcanki] migration failed', e));
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 60 });
  chrome.alarms.create(CATALOG_ALARM, { periodInMinutes: 24 * 60 });
  ensureCatalog();
}
chrome.runtime.onInstalled.addListener(bootstrap);
chrome.runtime.onStartup?.addListener(bootstrap);
