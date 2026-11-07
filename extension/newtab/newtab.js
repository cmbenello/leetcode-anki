import { getCards } from '../lib/storage.js';
import { dayKey, dayKeyMs, computeStreak } from '../lib/dates.js';
import { mountGrowth } from './growth.js';

const growth = mountGrowth(document.getElementById('growth'), {
  onOpen: (p) => { location.href = p.url; },
});


const $ = (s) => document.querySelector(s);

function send(kind, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

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
  // Greeting
  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 5 ? 'Late night'
                 : hour < 12 ? 'Good morning'
                 : hour < 18 ? 'Good afternoon'
                 :             'Good evening';
  $('#greeting').textContent = greeting;
  $('#date').textContent = now.toLocaleDateString(undefined, {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const r = await send('getDueList');
  if (!r?.ok) return;

  // Quant drills are synced via the bridge into a separate store; pull them in
  // so they show alongside LeetCode cards in the counts and the Due-now list.
  let quantRows = [];
  const mergedByDay = Object.assign({}, r.stats?.byDay || {});   // LeetCode reviews + quant reviews
  try {
    const qr = await send('quant-cards');
    if (qr?.ok) {
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
      // fold quant review timestamps into the day-by-day map (heatmap / streak / today)
      for (const qc of (qr.cards || [])) {
        for (const ts of (qc.reviewTs || [])) {
          const k = dayKey(new Date(ts));
          mergedByDay[k] = (mergedByDay[k] || 0) + 1;
        }
      }
    }
  } catch (e) {}
  const quantDue = quantRows.filter(c => (c.due ?? 0) <= Date.now()).sort((a, b) => (a.due ?? 0) - (b.due ?? 0));

  $('#stat-due').textContent = r.due.length + quantDue.length;
  $('#stat-tracked').textContent = r.total + quantRows.length;
  const todayCount = mergedByDay[dayKey(new Date())] ?? 0;
  const streak = computeStreak(mergedByDay);
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


  renderRecent(cards);
  loadGoals();

  const allDue = [...r.due, ...quantDue].sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  $('#due-summary').textContent = allDue.length
    ? `${allDue.length} problem${allDue.length === 1 ? '' : 's'} ready`
    : '';
  renderList('#due-list', allDue.slice(0, 15), 'Nothing due — pick a new problem.');
  const quantUpcoming = quantRows.filter(c => (c.due ?? 0) > Date.now());
  const allUpcoming = [...(r.upcoming || []), ...quantUpcoming].sort((a, b) => (a.due ?? 0) - (b.due ?? 0));
  renderList('#upcoming-list', allUpcoming.slice(0, 10), '—');

  // Start session button
  const isActive = !!r.session;
  $('#start-session').disabled = r.due.length === 0 && !isActive;
  $('#start-session').textContent = isActive
    ? 'Session running'
    : (r.due.length > 0 ? `Start session (${r.due.length})` : 'Start session');
  $('#session-controls').classList.toggle('has-session', isActive);
  $('#end-session-home').classList.toggle('hidden', !isActive);
}

// ---------------------------------------------------------------- goals ----
let goalState = { goals: [], activeId: null, presets: { interviewTags: [] } };
let editingId = null;
let formType = 'tags';

const humanTag = (t) => ({
  'hash-table': 'hashing', 'dynamic-programming': 'DP', 'heap-priority-queue': 'heap',
  'breadth-first-search': 'BFS', 'depth-first-search': 'DFS',
}[t] || t.replace(/-/g, ' '));

// Refreshes can overlap (a pill click and a tab-focus reload); only the
// newest one may draw, or the grow-in animation restarts mid-way.
let goalsSeq = 0;
async function loadGoals() {
  const my = ++goalsSeq;
  const r = await send('getGoals');
  if (!r?.ok || my !== goalsSeq) return;
  goalState = r;
  renderPills();
  const view = await send('getGoalView', { id: r.activeId });
  if (my !== goalsSeq) return;
  if (view?.ok) growth.update(view);
  loadNext(my);
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
  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'pill pill-add';
  add.textContent = goalState.goals.length ? '+ goal' : '+ set a goal';
  add.addEventListener('click', () => openForm(null));
  wrap.appendChild(add);
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
    if (b.dataset.type === 'blind75' && !$('#goal-name').value) $('#goal-name').value = 'Blind 75';
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
  if (formType === 'blind75') goal.preset = 'blind75';
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

// -------------------------------------------------------------- next up ----
let nextRetry = 0;
async function loadNext(my = goalsSeq) {
  const r = await send('getRecommendations', { id: goalState.activeId, k: 5 });
  if (!r?.ok || my !== goalsSeq) return;
  const active = goalState.goals.find(g => g.id === goalState.activeId);
  $('#next-sub').textContent = active ? `for ${active.name}` : 'picked for you';
  const ul = $('#next-list');
  ul.textContent = '';
  if (!r.recs.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = r.catalog.loading || !r.catalog.size
      ? 'Fetching LeetCode’s problem list…'
      : 'Nothing to suggest right now — your due reviews come first.';
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
  $('#next-foot').textContent = foot.join(' ');

  // The catalog downloads on first run; check back once it lands.
  clearTimeout(nextRetry);
  if (r.catalog.loading || !r.catalog.size) nextRetry = setTimeout(() => loadNext(), 8000);
}

function nextRow(rec) {
  const li = document.createElement('li');
  li.className = 'row next-row';
  const top = document.createElement('div');
  top.className = 'row-top';
  const title = document.createElement('div');
  title.className = 'row-title';
  const a = document.createElement('a');
  a.href = rec.url;
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

$('#start-session').addEventListener('click', async () => {
  const r = await send('startSession');
  if (r?.error === 'no due problems') alert('Nothing due — go pick a new problem.');
  // No need to close — startSession navigates the current tab to the first problem.
});

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

$('#end-session-home').addEventListener('click', async () => {
  await send('stopSession');
  load();
});

$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

load();
