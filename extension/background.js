// Service worker. Owns SR computation, storage writes, GitHub sync,
// LeetCode metadata fetching, and the daily reminder notification.

import { newCard, grade as applyGrade, BUTTONS, formatDuration } from './lib/sm2.js';
import {
  getCard, upsertCard, getSettings, bumpStats, getStats, getCards,
  pushSyncQueue, getSyncQueue, setSyncQueue,
  getMeta, getAllMeta, upsertMeta,
} from './lib/storage.js';
import { commitFiles } from './lib/github.js';
import { fetchQuestionMeta } from './lib/leetcode-api.js';

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
          sendResponse({ ok: true, card, predictions });
          break;
        }
        case 'grade': {
          const result = await handleGrade(msg);
          sendResponse(result);
          // If a session is active, navigate the same tab to the next problem.
          // Sync runs in background so this is snappy.
          const tabId = sender.tab?.id;
          if (tabId && result?.ok) advanceSession(tabId).catch(() => {});
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
          sendResponse(await startSession());
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
        case 'repairCardUrls': {
          sendResponse(await repairCardUrls());
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

async function handleGrade({ slug, title, quality, durationMs, readingMs, codingMs, code, language, url, submission }) {
  const settings = await getSettings();
  const site = siteFromUrl(url);
  const existing = (await getCard(slug)) ?? newCard(slug, title, site);
  if (title && !existing.title) existing.title = title;
  // Always overwrite — heals old cards whose site was defaulted incorrectly,
  // and updates lastUrl so session-mode can navigate back to the exact page.
  existing.site = site;
  if (url) existing.lastUrl = url;

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
  });
  await upsertCard(card);
  await bumpStats({ isLapse: quality < 3 });

  // best-effort metadata fetch
  ensureMeta(slug).catch(() => {});

  // Fire GitHub sync in the background — do NOT block the grade response.
  // Caller (content script + session advance) needs to react fast.
  if (settings.syncEnabled && settings.githubToken && settings.githubRepo) {
    (async () => {
      try {
        const { notesNewlyCreated } = await syncToGitHub({
          card, prevIntervalMin, quality, durationMs, code, language, url, settings,
        });
        if (notesNewlyCreated) {
          const fresh = await getCard(card.slug);
          if (fresh) { fresh.notesCreated = true; await upsertCard(fresh); }
        }
      } catch (e) {
        console.warn('[lcanki] sync failed:', e.message);
        await pushSyncQueue({ slug: card.slug, t: Date.now(), reason: e.message });
      }
    })();
  }

  return { ok: true, prevIntervalMin, nextIntervalMin };
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

async function startSession() {
  const cards = await getCards();
  const now = Date.now();
  const due = Object.values(cards)
    .filter(c => (c.due ?? 0) <= now)
    .sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  if (!due.length) return { ok: false, error: 'no due problems' };

  const queue = due.map(c => ({
    slug: c.slug,
    site: c.site || 'leetcode',
    title: c.title,
    // Prefer the exact URL the user last graded on. Slugs differ between
    // LeetCode and NeetCode for the same problem; only the captured URL is
    // a reliable "go back to where you were" identifier.
    url: c.lastUrl || problemUrl(c.site || 'leetcode', c.slug),
  }));
  const session = { queue, index: 0, completed: 0, startedAt: Date.now() };
  await setSession(session);

  // Navigate in the background. We do NOT await the tab API here because
  // the popup awaits this message response and chrome.tabs.update can
  // block while the popup is up, leaving the popup hung.
  openProblem(queue[0].url);

  return { ok: true, session };
}

function openProblem(url) {
  (async () => {
    try {
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
  const url = next.url || problemUrl(next.site, next.slug);
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
      return meta;
    }
  } catch (e) {
    console.warn('[lcanki] meta fetch failed', slug, e.message);
  }
  return existing;
}

// ---------- GitHub sync ----------
async function syncToGitHub({ card, prevIntervalMin, quality, durationMs, code, language, url, settings }) {
  const ext = extFor(language, settings.defaultLang);
  const button = buttonLabelFor(quality);
  const slug = card.slug;
  const site = card.site || siteFromUrl(url);
  const dir = `${site}/${slug}`;
  const meta = await getMeta(slug);

  const files = [];

  if (code != null) {
    files.push({ path: `${dir}/solution.${ext}`, content: code });
  }

  files.push({
    path: `${dir}/meta.json`,
    content: JSON.stringify({
      slug,
      title: card.title,
      site,
      url,
      difficulty: meta?.difficulty ?? null,
      tags: meta?.tags ?? [],
      intervalMin: card.intervalMin,
      reps: card.reps,
      lapses: card.lapses,
      due: card.due,
      dueIso: new Date(card.due).toISOString(),
      history: card.history,
    }, null, 2) + '\n',
  });

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

  const dur = durationMs ? ` · ${Math.round(durationMs / 1000)}s` : '';
  const message = `${site}/${slug}: ${button} (${formatDuration(prevIntervalMin)} → ${formatDuration(card.intervalMin)})${dur}`;

  await commitFiles({
    token: settings.githubToken,
    repo: settings.githubRepo,
    message,
    files,
  });

  return { notesNewlyCreated };
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
    lines.push(`- **Next due:** ${new Date(card.due).toISOString().slice(0, 10)}`);
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
    const subs = history.filter(h => h.submission?.status);
    if (subs.length) {
      const acs = subs.filter(h => /accepted/i.test(h.submission.status)).length;
      lines.push(`- **AC rate:** ${acs}/${subs.length}`);
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
      const d = new Date(h.t).toISOString().slice(0, 10);
      byDay[d] = (byDay[d] || 0) + 1;
    }
  }
  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    days.push({ d, n: byDay[d] ?? 0 });
  }
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
        ? new Date(c.history.at(-1).t).toISOString().slice(0, 10)
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
      const due = c.due ? new Date(c.due).toISOString().slice(0, 10) : '—';
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

  const all = Object.values(cards);
  const bySite = { leetcode: [], neetcode: [] };
  for (const c of all) (bySite[c.site || 'leetcode'] ??= []).push(c);

  const dueNow = all.filter(c => (c.due ?? 0) <= now);
  const today = new Date().toISOString().slice(0, 10);

  const days = [];
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now - i * 86400000).toISOString().slice(0, 10);
    days.push({ d, n: stats.byDay?.[d] ?? 0 });
  }

  const lines = [
    '# DSA Spaced Repetition Tracker',
    '',
    'Auto-generated by the [LeetCode Anki](https://github.com/) extension.',
    '',
    `- **Total tracked:** ${all.length} (LeetCode ${bySite.leetcode.length} · NeetCode ${bySite.neetcode.length})`,
    `- **Total reviews:** ${stats.totalReviews ?? 0}`,
    `- **Lapses:** ${stats.lapses ?? 0}`,
    `- **Reviewed today:** ${stats.byDay?.[today] ?? 0}`,
    `- **Due now:** ${dueNow.length}`,
    '',
    '## Sites',
    '',
    `- [LeetCode](./leetcode/) — ${bySite.leetcode.length} tracked`,
    `- [NeetCode](./neetcode/) — ${bySite.neetcode.length} tracked`,
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
  const now = Date.now();
  const due = [], upcoming = [];
  for (const c of Object.values(cards)) {
    const enriched = { ...c, meta: meta[c.slug] ?? null };
    if ((c.due ?? 0) <= now) due.push(enriched); else upcoming.push(enriched);
  }
  due.sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  upcoming.sort((a, b) => a.due - b.due);
  return {
    ok: true,
    due,
    upcoming: upcoming.slice(0, 30),
    stats: await getStats(),
    total: Object.keys(cards).length,
  };
}

async function getCardStats(slug) {
  const card = await getCard(slug);
  if (!card) return { ok: false, error: 'no card' };
  const meta = await getMeta(slug);
  const history = card.history ?? [];

  const counts = { again: 0, hard: 0, good: 0, easy: 0 };
  const subCounts = { ac: 0, wa: 0, tle: 0, mle: 0, re: 0, ce: 0, ole: 0, other: 0 };
  let totalDur = 0, totalRead = 0, totalCode = 0, durSamples = 0;
  let submissions = 0, accepts = 0;
  for (const h of history) {
    const id = h.button ?? buttonIdFor(h.q);
    if (counts[id] != null) counts[id] += 1;
    if (h.durationMs) { totalDur += h.durationMs; durSamples += 1; }
    if (h.readingMs) totalRead += h.readingMs;
    if (h.codingMs)  totalCode += h.codingMs;
    const cat = categorizeSubmission(h.submission?.status);
    if (cat) {
      subCounts[cat] += 1;
      submissions += 1;
      if (cat === 'ac') accepts += 1;
    }
  }
  const avgDurMs = durSamples ? totalDur / durSamples : 0;

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
async function flushSyncQueue() {
  const q = await getSyncQueue();
  const settings = await getSettings();
  if (!settings.syncEnabled || !settings.githubToken || !settings.githubRepo) {
    return { ok: false, error: 'sync disabled or unconfigured' };
  }
  try {
    await commitFiles({
      token: settings.githubToken,
      repo: settings.githubRepo,
      message: q.length ? `sync: flush ${q.length} queued events` : 'sync: refresh dashboard',
      files: [
        { path: 'log.md',     content: await renderLog() },
        { path: 'stats.json', content: JSON.stringify(await getStats(), null, 2) + '\n' },
        { path: 'README.md',  content: await renderReadme() },
      ],
    });
    await setSyncQueue([]);
    return { ok: true, flushed: q.length };
  } catch (e) {
    return { ok: false, error: e.message };
  }
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

  const items = due.slice(0, 5).map(c => {
    const d = meta[c.slug]?.difficulty;
    return {
      title: c.title || c.slug,
      message: d ? `${d} · reps ${c.reps}${c.lapses ? ` · ${c.lapses}L` : ''}` : `reps ${c.reps}`,
    };
  });

  chrome.notifications.create('lcanki-daily', {
    type: 'list',
    iconUrl: chrome.runtime.getURL('icons/icon128.png'),
    title: `${due.length} problem${due.length === 1 ? '' : 's'} due today`,
    message: due.length > 5 ? `…and ${due.length - 5} more` : '',
    items,
    priority: 1,
  });
}

chrome.notifications?.onClicked.addListener((id) => {
  if (id === 'lcanki-daily') {
    chrome.tabs.create({ url: chrome.runtime.getURL('popup/popup.html') });
    chrome.notifications.clear(id);
  }
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === REMINDER_ALARM) fireDailyReminder().catch(() => {});
  if (a.name === RETRY_ALARM)    flushSyncQueue().catch(() => {});
});

// startup wiring
chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 60 });
  scheduleDailyReminder().catch(() => {});
});
chrome.runtime.onStartup?.addListener(() => {
  chrome.alarms.create(RETRY_ALARM, { periodInMinutes: 60 });
  scheduleDailyReminder().catch(() => {});
});
