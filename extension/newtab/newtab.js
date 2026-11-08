import { getCards, getSettings } from '../lib/storage.js';
import { dayKey, dayKeyMs, computeStreak } from '../lib/dates.js';
import { mountGrowth } from './growth.js';

// Where problem links go: LeetCode, or NeetCode's page when one exists.
let openOn = 'leetcode';
getSettings().then(st => { openOn = st.openOn || 'leetcode'; }).catch(() => {});
const ncPage = (nc) => (nc ? `https://neetcode.io/problems/${nc}` : null);
const problemHref = (lcUrl, ncUrl) => (openOn === 'neetcode' && ncUrl ? ncUrl : lcUrl);

const growth = mountGrowth(document.getElementById('growth'), {
  onOpen: (p) => { location.href = problemHref(p.url, ncPage(p.nc)); },
  // a topic label was clicked: suggestions on that arc, for the active goal
  onTopic: async (topic) => {
    const r = await send('getRecommendations', { id: goalState.activeId, topic, k: 5 });
    return r?.ok ? r.recs.map(x => ({ ...x, href: problemHref(x.url, x.ncUrl) })) : [];
  },
  onOpenSuggestion: (rec) => { location.href = problemHref(rec.url, rec.ncUrl); },
});


const $ = (s) => document.querySelector(s);

// Every call to the background resolves — with { ok: false, error } on
// failure, a thrown sendMessage (tab outlived an extension reload), or no
// answer within 20s. A promise that never settles is how one failed request
// used to freeze the goal view, the count and "Next up" all at once.
function send(kind, payload = {}, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: `no answer to "${kind}" after ${timeoutMs / 1000}s` }), timeoutMs);
    const done = (v) => {
      clearTimeout(timer);
      const out = v ?? { ok: false, error: `empty answer to "${kind}"` };
      if (!out.ok && /unknown kind/i.test(out.error || '')) showStaleBackground();
      resolve(out);
    };
    try {
      chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
        if (chrome.runtime.lastError) done({ ok: false, error: chrome.runtime.lastError.message });
        else done(resp);
      });
    } catch (e) {
      const msg = e?.message || String(e);
      if (/context invalidated/i.test(msg)) showBanner('The extension was updated — reload this tab.');
      done({ ok: false, error: msg });
    }
  });
}

// Anything unexpected shows up on the page instead of failing silently.
function showBanner(text) {
  if (staleShown) return;                 // the stale-worker banner explains it already
  let el = document.getElementById('page-error');
  if (!el) {
    el = document.createElement('div');
    el.id = 'page-error';
    el.className = 'page-error';
    el.addEventListener('click', () => el.remove());
    document.body.prepend(el);
  }
  el.textContent = `${text}  (click to dismiss)`;
}
// Chrome reads extension PAGES fresh from disk on every new tab, but keeps
// running the background worker it loaded at the last extension reload. After
// the files change, the new page asks the old worker for things it has never
// heard of ("unknown kind: getGoals"). That's proof of a stale worker, and the
// fix is a reload — so offer it right there.
let staleShown = false;
function showStaleBackground() {
  if (staleShown) return;
  staleShown = true;
  document.getElementById('page-error')?.remove();
  const el = document.createElement('div');
  el.id = 'stale-banner';
  el.className = 'page-error stale-banner';
  const text = document.createElement('span');
  text.textContent = 'The extension was updated, but Chrome is still running the old version in the background. Reload it here, or with ↻ on chrome://extensions.';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'primary';
  btn.textContent = 'Reload extension';
  btn.addEventListener('click', () => {
    text.textContent = 'Reloading… open a new tab in a moment.';
    btn.remove();
    setTimeout(() => chrome.runtime.reload(), 150);
  });
  el.append(text, btn);
  document.body.prepend(el);
}
window.addEventListener('error', (e) => showBanner(`Something broke: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => showBanner(`Something broke: ${e.reason?.message || e.reason}`));
async function safely(label, fn) {
  try { await fn(); } catch (e) { console.error(`[lcanki] ${label}`, e); showBanner(`${label} failed: ${e?.message || e}`); }
}

// -------------------------------------------------------- daily tracker ----
// One cell per local day, counting DISTINCT problems you touched — graded,
// submitted or imported. Streak and "today" read the same map, so the three
// can never disagree.
function activityByDay(cards, quantCards = []) {
  const perDay = {};
  const add = (t, slug) => {
    if (!t) return;
    const k = dayKey(new Date(t));
    (perDay[k] ??= new Set()).add(slug);
  };
  for (const c of Object.values(cards)) {
    for (const h of c.history ?? []) add(h.t, c.slug);
    // NeetCode completions carry no date (t is just when we synced them);
    // counting them would paint a fake burst on the sync day.
    for (const x of c.submissions ?? []) if (!x.undated) add(x.t, c.slug);
  }
  for (const q of quantCards) for (const t of q.reviewTs || []) add(t, `quant:${q.id}`);
  return Object.fromEntries(Object.entries(perDay).map(([k, set]) => [k, set.size]));
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];
const heatLevel = (n) => (!n ? 0 : n <= 1 ? 1 : n <= 3 ? 2 : n <= 6 ? 3 : 4);

function renderHeatmap(byDay) {
  const grid = $('#heatmap'), monthRow = $('#heatmap-months'), dayCol = $('#heatmap-days');
  grid.textContent = ''; monthRow.textContent = '';
  dayCol.innerHTML = DAY_LABELS.map(d => `<span>${d || '&nbsp;'}</span>`).join('');
  const today = new Date(); today.setHours(12, 0, 0, 0);
  // 53 Monday-aligned columns ending with the week that contains today.
  const cur = new Date(today);
  cur.setDate(cur.getDate() - 364);
  cur.setDate(cur.getDate() - ((cur.getDay() + 6) % 7));
  let total = 0, active = 0, prevMonth = -1;
  while (cur <= today) {
    const col = document.createElement('div');
    col.className = 'hm-col';
    const label = document.createElement('span');
    for (let d = 0; d < 7; d++) {
      const key = dayKey(cur);
      const n = byDay[key] || 0;
      const future = cur > today;
      const cell = document.createElement('div');
      cell.className = 'hm-cell' + (future ? ' hm-future' : '');
      cell.dataset.level = String(heatLevel(n));
      cell.title = `${key} — ${n} problem${n === 1 ? '' : 's'}`;
      col.appendChild(cell);
      if (!future) { total += n; if (n) active += 1; }
      if (cur.getDate() <= 7 && cur.getMonth() !== prevMonth && !label.textContent) {
        label.textContent = MONTHS[cur.getMonth()];
        prevMonth = cur.getMonth();
      }
      cur.setDate(cur.getDate() + 1);
    }
    monthRow.appendChild(label);
    grid.appendChild(col);
  }
  $('#heatmap-summary').textContent = `${active} active day${active === 1 ? '' : 's'} in the last year`;
}

// ---------------------------------------------------------------- theme ----
// One look (Glass); the picker is gone. Earlier builds could save another
// theme, so pin it here and in theme-init.js.
document.documentElement.dataset.theme = 'glass';

function makeRow(card) {
  const li = document.createElement('li');
  li.className = 'row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const title = document.createElement('div');
  title.className = 'row-title';
  // Click on the title starts a session beginning with this problem.
  const a = document.createElement('a');
  a.href = card.lastUrl
    || (card.site === 'quant' ? '#'
        : card.site === 'neetcode'
        ? `https://neetcode.io/problems/${card.slug}`
        : `https://leetcode.com/problems/${card.slug}/`);
  a.textContent = card.title || card.slug;
  if (card.site === 'quant') {
    a.target = '_blank';   // open the drill problem in a new tab; LeetCode session/delete don't apply
  } else {
    a.addEventListener('click', async (e) => {
      e.preventDefault();
      await send('startSessionAt', { slug: card.slug });
    });
  }
  title.appendChild(a);
  const when = document.createElement('span');
  when.className = 'row-when';
  if ((card.due ?? 0) <= Date.now()) when.textContent = 'due now';
  else when.textContent = fmtDue(card.due);
  top.appendChild(title);
  top.appendChild(when);
  if (card.site !== 'quant') {
    const del = document.createElement('button');
    del.className = 'row-delete';
    del.title = 'Delete card';
    del.textContent = '×';
    del.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      const resp = await send('deleteCard', { slug: card.slug });
      if (resp?.ok) { li.remove(); load(); }
    });
    top.appendChild(del);
  }
  li.appendChild(top);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  if (card.meta?.difficulty) {
    const d = document.createElement('span');
    d.className = `diff ${card.meta.difficulty}`;
    d.textContent = card.meta.difficulty;
    meta.appendChild(d);
  }
  for (const t of (card.meta?.tags ?? []).slice(0, 3)) {
    const el = document.createElement('span');
    el.className = 'tag';
    el.textContent = t.name;
    meta.appendChild(el);
  }
  if (card.reps) {
    const reps = document.createElement('span');
    reps.style.marginLeft = 'auto';
    reps.textContent = `${card.reps} rep${card.reps === 1 ? '' : 's'}${card.lapses ? ` · ${card.lapses}L` : ''}`;
    meta.appendChild(reps);
  }
  li.appendChild(meta);
  return li;
}

function fmtDue(ms) {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min <= 0) return 'now';
  if (min < 60) return `${min}m`;
  if (min < 1440) return `${Math.round(min / 60)}h`;
  if (min < 43200) return `${Math.round(min / 1440)}d`;
  return `${Math.round(min / 1440 / 30)}mo`;
}

function renderList(sel, items, emptyMsg) {
  const ul = $(sel);
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = emptyMsg;
    ul.appendChild(li);
    return;
  }
  for (const c of items) ul.appendChild(makeRow(c));
}

async function load() {
  safely('Goal view', loadGoals);      // independent of everything below
  safely('Dashboard', loadDashboard);
}

async function loadDashboard() {
  const r = await send('getDueList');
  if (!r?.ok) return;

  // Quant drills are synced via the bridge into a separate store; pull them in
  // so they show alongside LeetCode cards in the counts and the Due-now list.
  let quantRows = [];
  let qrCards = [];
  try {
    const qr = await send('quant-cards');
    if (qr?.ok) {
      qrCards = qr.cards || [];
      const nowMs = Date.now();
      quantRows = (qr.cards || []).map(qc => ({
        slug: qc.id, site: 'quant', title: qc.title || qc.id,
        due: qc.due ?? nowMs, reps: qc.reps || 0, lapses: qc.lapses || 0,
        lastUrl: qc.url || null,
        meta: {
          difficulty: (qc.difficulty && qc.difficulty !== '—') ? qc.difficulty : null,
          tags: ['Quant'].concat(qc.tags || []).slice(0, 3).map(t => ({ name: t })),
        },
      }));
    }
  } catch (e) {}
  const quantDue = quantRows.filter(c => (c.due ?? 0) <= Date.now()).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  $('#stat-due').textContent = r.due.length + quantDue.length;
  $('#stat-tracked').textContent = r.total + quantRows.length;
  const activity = activityByDay(await getCards(), qrCards);
  const todayCount = activity[dayKey(new Date())] ?? 0;
  const streak = computeStreak(activity);
  $('#stat-today').textContent = todayCount;
  $('#stat-streak').textContent = streak;

  // Aggregate over BOTH the per-card submissions array (new) and per-grade
  // history submissions (older cards). A card counts as solved if it has any
  // Accepted submission anywhere OR has been graded with reps > 0.
  const cards = await getCards();
  let ac = 0, total = 0, solved = 0;
  for (const c of Object.values(cards)) {
    const subs = [
      ...(c.submissions ?? []),
      ...(c.history ?? []).map(h => h.submission).filter(Boolean),
    ];
    let acdHere = false;
    for (const s of subs) {
      total += 1;
      if (/accepted/i.test(s?.status || '')) { ac += 1; acdHere = true; }
    }
    if (acdHere || (c.reps ?? 0) > 0) solved += 1;
  }
  $('#stat-ac').textContent = total ? `${Math.round((ac / total) * 100)}%` : '—';
  const solvedAll = solved + quantRows.length;                  // quant cards are solved-by-definition
  $('#hero-solved').textContent = solvedAll;


  await safely('Recent activity', () => renderRecent(cards));
  await safely('Daily activity', () => renderHeatmap(activity));

  const allDue = [...r.due, ...quantDue].sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  $('#due-summary').textContent = allDue.length
    ? `${allDue.length} problem${allDue.length === 1 ? '' : 's'} ready`
    : '';
  renderList('#due-list', allDue.slice(0, 15), 'Nothing due — pick a new problem.');
  const quantUpcoming = quantRows.filter(c => (c.due ?? 0) > Date.now());
  const allUpcoming = [...(r.upcoming || []), ...quantUpcoming].sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  renderList('#upcoming-list', allUpcoming.slice(0, 10), '—');
}

// ---------------------------------------------------------------- goals ----
let goalState = { goals: [], activeId: null, presets: { interviewTags: [] } };
let editingId = null;
let formType = 'tags';

const humanTag = (t) => ({
  'hash-table': 'hashing', 'dynamic-programming': 'DP', 'heap-priority-queue': 'heap',
  'breadth-first-search': 'BFS', 'depth-first-search': 'DFS',
}[t] || t.replace(/-/g, ' '));

// The graph must be there the moment a tab opens. Waking the background
// worker and reading storage takes 100ms+ (more with a big history), so the
// last answer is kept in localStorage and drawn straight away; the fresh one
// replaces it only if something actually changed.
const HOME_CACHE = 'lcanki.home';
const viewKey = (v) => JSON.stringify({ ...v, now: 0 });     // the clock alone isn't a change
let shownKey = null;
function writeHomeCache(home) {
  try { localStorage.setItem(HOME_CACHE, JSON.stringify(home)); } catch (e) { /* full or blocked: just slower next time */ }
}
function paintHome(c) {
  goalState = c.goals;
  renderPills();
  c.view.now = Date.now();                  // "recent" / "today" relative to now
  growth.update(c.view);
  shownKey = viewKey(c.view);
}
// 1. This page's last copy, synchronously, so the graph is in the very first
//    frame. Nothing here waits: every millisecond before the first frame is
//    a millisecond of Chrome's own blank tab showing.
try {
  const c = JSON.parse(localStorage.getItem(HOME_CACHE) || 'null');
  if (c?.goals?.ok && c?.view?.ok) paintHome(c);
} catch (e) { /* no copy yet: the graph fills in when the worker answers */ }
document.documentElement.classList.add('lcanki-ready');
// 2. The background's copy, kept current on every change: replaces it only
//    if something changed since this page last ran (e.g. a solve).
window.__lcankiHome?.then((c) => {
  if (!c?.goals?.ok || !c?.view?.ok || viewKey(c.view) === shownKey) return;
  paintHome(c);
  writeHomeCache({ goals: c.goals, view: c.view });
});

// Refreshes can overlap (a pill click and a tab-focus reload); only the
// newest one may draw.
let goalsSeq = 0;
async function loadGoals() {
  const my = ++goalsSeq;
  let home = await send('getHome');
  if (my !== goalsSeq) return;
  if (!home?.ok && /unknown kind/i.test(home?.error || '')) {
    // a worker from before getHome existed: the old two requests
    const r = await send('getGoals');
    const view = r?.ok ? await send('getGoalView', { id: r.activeId }) : null;
    home = { ok: !!view?.ok, goals: r, view, error: view?.error || r?.error };
    if (my !== goalsSeq) return;
  }
  if (home?.goals?.ok) { goalState = home.goals; renderPills(); }
  else showBanner(`Couldn’t load goals: ${home?.goals?.error || home?.error}`);
  loadNext(my);
  if (home?.view?.ok) {
    const key = viewKey(home.view);
    if (key !== shownKey) { growth.update(home.view); shownKey = key; }
    writeHomeCache({ goals: home.goals, view: home.view });
  } else if (shownKey == null) {
    growth.fail(home?.view?.error || home?.error || 'no answer from the extension');
  } else {
    showBanner(`Couldn’t refresh the graph: ${home?.view?.error || home?.error || 'no answer'}`);
  }
}

function renderPills() {
  const wrap = $('#goal-pills');
  wrap.textContent = '';
  for (const g of goalState.goals) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pill' + (g.id === goalState.activeId ? ' on' : '');
    const name = document.createElement('span'); name.textContent = g.name;
    const cnt = document.createElement('span'); cnt.className = 'pill-count';
    cnt.textContent = `${g.progress.done}/${g.progress.target}`;
    b.append(name, cnt);
    b.title = g.id === goalState.activeId ? 'Click to edit' : 'Show this goal';
    b.addEventListener('click', async () => {
      if (g.id === goalState.activeId) { openForm(g); return; }
      await send('setActiveGoal', { id: g.id });
      loadGoals();
    });
    wrap.appendChild(b);
  }
  // No "+ set a goal" pill: the graph shows all your practice. Goals made
  // earlier still show here and can be edited or deleted from their pill.
}

function setFormType(t) {
  formType = t;
  for (const b of document.querySelectorAll('#goal-type button')) b.classList.toggle('on', b.dataset.type === t);
  for (const row of document.querySelectorAll('#goal-form [data-for]')) {
    row.hidden = !row.dataset.for.split(' ').includes(t);
  }
}

function openForm(goal) {
  editingId = goal?.id ?? null;
  const f = $('#goal-form');
  f.hidden = false;
  $('#goal-error').textContent = '';
  $('#goal-name').value = goal?.name ?? '';
  $('#goal-target').value = goal?.type === 'list' ? 100 : (goal?.target ?? 100);
  $('#goal-deadline').value = goal?.deadline ?? '';
  $('#goal-slugs').value = goal?.type === 'list' ? (goal.slugs || []).join('\n') : '';
  const chosen = new Set(goal?.type === 'tags' ? goal.tags : goalState.presets.interviewTags);
  const chips = $('#goal-tags');
  chips.textContent = '';
  for (const t of goalState.presets.interviewTags) {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = 'chip' + (chosen.has(t) ? ' on' : '');
    c.dataset.tag = t;
    c.textContent = humanTag(t);
    c.addEventListener('click', () => c.classList.toggle('on'));
    chips.appendChild(c);
  }
  setFormType(goal ? goal.type : 'tags');
  $('#goal-delete').hidden = !goal;
  $('#goal-name').focus();
}

for (const b of document.querySelectorAll('#goal-type button')) {
  b.addEventListener('click', () => {
    setFormType(b.dataset.type);
    const presetName = { blind75: 'Blind 75', nc150: 'NeetCode 150', nc250: 'NeetCode 250' }[b.dataset.type];
    if (presetName && (!$('#goal-name').value || Object.values({ a: 'Blind 75', b: 'NeetCode 150', c: 'NeetCode 250' }).includes($('#goal-name').value))) {
      $('#goal-name').value = presetName;
    }
  });
}
$('#goal-cancel').addEventListener('click', () => { $('#goal-form').hidden = true; });
$('#goal-delete').addEventListener('click', async () => {
  if (!editingId || !confirm('Delete this goal? Your solved problems are not affected.')) return;
  await send('deleteGoal', { id: editingId });
  $('#goal-form').hidden = true;
  loadGoals();
});
$('#goal-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const goal = {
    id: editingId || undefined,
    name: $('#goal-name').value.trim() || 'My goal',
    deadline: $('#goal-deadline').value || null,
    target: +$('#goal-target').value || 100,
  };
  if (formType === 'blind75' || formType === 'nc150' || formType === 'nc250') goal.preset = formType;
  else if (formType === 'list') { goal.type = 'list'; goal.slugsText = $('#goal-slugs').value; }
  else if (formType === 'tags') {
    goal.type = 'tags';
    goal.tags = [...document.querySelectorAll('#goal-tags .chip.on')].map(c => c.dataset.tag);
  } else goal.type = 'all';
  const r = await send('saveGoal', { goal });
  if (!r?.ok) { $('#goal-error').textContent = r?.error || 'could not save'; return; }
  $('#goal-form').hidden = true;
  if (!editingId) await send('setActiveGoal', { id: r.goal.id });
  loadGoals();
});

// ------------------------------------------------------- history import ----
// Until you've imported once, offer it right under the goals: the growth view
// only knows the problems this extension has seen, not your whole history.
let importTimer = 0;
async function refreshImportCta() {
  const r = await send('getImportState');
  const st = r?.ok ? r.state : null;
  const cta = $('#import-cta'), btn = $('#import-btn'), msg = $('#import-msg');
  if (st?.completedOnce && !st.running) { cta.hidden = true; return; }
  cta.hidden = false;
  clearTimeout(importTimer);
  if (st?.running) {
    btn.disabled = true;
    btn.textContent = 'Importing your LeetCode history…';
    msg.textContent = `${st.added} submissions · ${st.newCards} new problems`;
    importTimer = setTimeout(async () => {
      await refreshImportCta();
      const again = await send('getImportState');
      if (again?.state && !again.state.running) { loadGoals(); loadDashboard(); }
    }, 1500);
  } else {
    btn.disabled = false;
    btn.textContent = '↓ Grow it from your LeetCode history';
    msg.textContent = st?.error ? st.error : '';
  }
}
$('#import-btn').addEventListener('click', async () => {
  $('#import-msg').textContent = 'opening LeetCode in the background…';
  const r = await send('startImport', { perDay: 5 }, 45000);
  if (!r?.ok) $('#import-msg').textContent = r?.error || 'could not start';
  refreshImportCta();
});
refreshImportCta();

// -------------------------------------------------------------- next up ----
let nextRetry = 0;
async function loadNext(my = goalsSeq) {
  const r = await send('getRecommendations', { id: goalState.activeId, k: 5 });
  if (my !== goalsSeq) return;
  if (!r?.ok) {
    // Never leave "Ranking…" up forever: say what went wrong and offer a retry.
    const ul = $('#next-list');
    ul.textContent = '';
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = `Couldn’t rank problems: ${r?.error || 'no response from the extension'}. `;
    const retry = document.createElement('a');
    retry.href = '#';
    retry.textContent = 'Try again';
    retry.addEventListener('click', (e) => { e.preventDefault(); loadNext(); });
    li.appendChild(retry);
    ul.appendChild(li);
    return;
  }
  const active = goalState.goals.find(g => g.id === goalState.activeId);
  $('#next-sub').textContent = active ? `for ${active.name}` : 'picked for you';
  const ul = $('#next-list');
  ul.textContent = '';
  if (!r.recs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = !r.catalog.size
      ? 'Loading LeetCode’s problem list…'
      : 'Nothing new to suggest right now — your due reviews come first.';
    ul.appendChild(li);
  }
  for (const rec of r.recs) ul.appendChild(nextRow(rec));

  const foot = [];
  const c = r.calibration;
  if (c?.n >= 5) {
    foot.push(`So far the model said ${Math.round(c.predicted * 100)}% and you solved ${Math.round(c.actual * 100)}% (${c.n} attempts).`);
  } else {
    foot.push('Predictions start personalising after a few graded attempts.');
  }
  if (r.weakest?.length) foot.push(`Weakest: ${r.weakest.map(w => humanTag(w.concept)).join(', ')}.`);
  if (r.catalog.refreshing && r.catalog.total) {
    foot.push(`Updating LeetCode’s problem list (${r.catalog.done.toLocaleString()} / ${r.catalog.total.toLocaleString()})…`);
  }
  $('#next-foot').textContent = foot.join(' ');

  clearTimeout(nextRetry);
  if (r.catalog.refreshing || !r.catalog.size) nextRetry = setTimeout(() => loadNext(), 3000);
}

function nextRow(rec) {
  const li = document.createElement('li');
  li.className = 'row next-row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const title = document.createElement('div');
  title.className = 'row-title';
  const a = document.createElement('a');
  a.href = problemHref(rec.url, rec.ncUrl);
  a.textContent = rec.title;
  title.appendChild(a);
  const p = document.createElement('span');
  p.className = 'pred';
  p.title = 'Predicted chance you solve it without help';
  const bar = document.createElement('span'); bar.className = 'pmeter';
  const fill = document.createElement('i'); fill.style.width = `${Math.round(rec.p * 100)}%`;
  bar.appendChild(fill);
  p.append(bar, `${Math.round(rec.p * 100)}%`);
  top.append(title, p);

  const meta = document.createElement('div');
  meta.className = 'row-meta';
  if (rec.difficulty) {
    const d = document.createElement('span');
    d.className = `diff ${rec.difficulty}`;
    d.textContent = rec.difficulty;
    meta.appendChild(d);
  }
  for (const t of rec.tags.slice(0, 2)) {
    const el = document.createElement('span'); el.className = 'tag'; el.textContent = humanTag(t);
    meta.appendChild(el);
  }
  const other = openOn === 'neetcode' ? { href: rec.url, text: 'LeetCode' } : rec.ncUrl ? { href: rec.ncUrl, text: 'NeetCode' } : null;
  if (other) {
    const l = document.createElement('a');
    l.className = 'alt-link';
    l.href = other.href;
    l.textContent = `${other.text} ↗`;
    meta.appendChild(l);
  }
  const why = document.createElement('div');
  why.className = 'why';
  why.textContent = rec.reason;
  if (rec.evidence?.length) {
    const ev = document.createElement('span');
    ev.className = 'evidence';
    ev.textContent = ` · like ${rec.evidence.map(e => `${e.title} ${e.correct ? '✓' : '✗'}`).join(', ')}`;
    why.appendChild(ev);
  }
  li.append(top, meta, why);
  return li;
}


function buttonLabel(q) {
  return q === 0 ? 'Again' : q === 3 ? 'Hard' : q === 5 ? 'Easy' : 'Good';
}
function fmtRelative(t) {
  const d = Date.now() - t;
  if (d < 60_000)         return 'just now';
  if (d < 3_600_000)      return `${Math.round(d / 60_000)}m ago`;
  if (d < 86_400_000)     return `${Math.round(d / 3_600_000)}h ago`;
  if (d < 7 * 86_400_000) return `${Math.round(d / 86_400_000)}d ago`;
  return dayKeyMs(t);
}

function renderRecent(cards) {
  const events = [];
  for (const c of Object.values(cards)) {
    const base = {
      slug: c.slug,
      site: c.site || 'leetcode',
      title: c.title || c.slug,
      url: c.lastUrl,
    };
    // Grade events
    for (const h of (c.history ?? [])) {
      events.push({
        ...base,
        t: h.t,
        kind: 'grade',
        grade: buttonLabel(h.q),
        status: h.submission?.status,
      });
    }
    // Submission events (every detected outcome, AC or otherwise). These
    // surface immediately on AC even before the user grades.
    for (const s of (c.submissions ?? [])) {
      if (s.undated) continue;               // synced from NeetCode: no real date
      events.push({
        ...base,
        t: s.t,
        kind: 'submission',
        status: s.status,
      });
    }
  }
  events.sort((a, b) => b.t - a.t);
  const top = events.slice(0, 25);

  const ul = $('#recent-list');
  ul.innerHTML = '';
  if (!top.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No activity yet.';
    ul.appendChild(li);
    return;
  }
  for (const r of top) {
    const li = document.createElement('li');
    li.className = 'row';

    const top2 = document.createElement('div');
    top2.className = 'row-top';
    const title = document.createElement('div');
    title.className = 'row-title';
    const a = document.createElement('a');
    a.href = r.url
      || (r.site === 'neetcode'
          ? `https://neetcode.io/problems/${r.slug}`
          : `https://leetcode.com/problems/${r.slug}/`);
    a.textContent = r.title;
    title.appendChild(a);
    const when = document.createElement('span');
    when.className = 'row-when';
    when.textContent = fmtRelative(r.t);
    top2.appendChild(title);
    top2.appendChild(when);
    li.appendChild(top2);

    const meta = document.createElement('div');
    meta.className = 'row-meta';
    if (r.kind === 'grade') {
      const grade = document.createElement('span');
      grade.className = `h-grade ${r.grade.toLowerCase()}`;
      grade.textContent = `graded ${r.grade}`;
      meta.appendChild(grade);
      if (r.status) {
        const status = document.createElement('span');
        status.className = 'tag';
        status.textContent = r.status;
        meta.appendChild(status);
      }
    } else {
      const status = document.createElement('span');
      const ok = /accepted/i.test(r.status || '');
      status.className = `h-grade ${ok ? 'good' : 'again'}`;
      status.textContent = r.status || 'submitted';
      meta.appendChild(status);
    }
    li.appendChild(meta);
    ul.appendChild(li);
  }
}

// Refresh only when the user actually returns to the dashboard tab. No
// listener on chrome.storage — that was thrashing the page mid-view.
let lastReloadAt = Date.now();
function maybeReload() {
  // 2-second floor so rapid focus/blur cycles don't refire.
  const now = Date.now();
  if (now - lastReloadAt < 2000) return;
  lastReloadAt = now;
  load();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') maybeReload();
});
window.addEventListener('focus', maybeReload);


$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
