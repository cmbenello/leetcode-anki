import { formatDuration } from '../lib/sm2.js';

const $ = (s) => document.querySelector(s);

function send(kind, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

function fmtDue(ms) {
  const min = Math.round((ms - Date.now()) / 60000);
  if (min <= 0) return 'now';
  return formatDuration(min);
}

function fmtMs(ms) {
  if (ms == null) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${(s % 60).toString().padStart(2, '0')}s`;
}

function fmtAgo(t) {
  if (!t) return '—';
  const d = Date.now() - t;
  if (d < 3600000)    return `${Math.round(d / 60000)}m ago`;
  if (d < 86400000)   return `${Math.round(d / 3600000)}h ago`;
  if (d < 86400000*30) return `${Math.round(d / 86400000)}d ago`;
  return new Date(t).toISOString().slice(0, 10);
}

function makeRow(card, isDue) {
  const li = document.createElement('li');
  li.className = 'row';
  li.dataset.slug = card.slug;

  const top = document.createElement('div');
  top.className = 'row-top';
  const title = document.createElement('div');
  title.className = 'row-title';
  const a = document.createElement('a');
  a.href = `https://leetcode.com/problems/${card.slug}/`;
  a.target = '_blank';
  a.textContent = card.title || card.slug;
  a.addEventListener('click', (e) => e.stopPropagation()); // don't toggle on link click
  title.appendChild(a);

  const when = document.createElement('span');
  when.className = 'row-when';
  when.textContent = isDue ? 'due now' : fmtDue(card.due);

  top.appendChild(title);
  top.appendChild(when);
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
  const reps = document.createElement('span');
  reps.className = 'reps';
  reps.textContent = card.reps ? `${card.reps} rep${card.reps === 1 ? '' : 's'}${card.lapses ? ` · ${card.lapses}L` : ''}` : 'new';
  meta.appendChild(reps);
  li.appendChild(meta);

  // expand on click — only useful for cards with reps > 0
  li.addEventListener('click', () => toggleExpand(li, card));

  return li;
}

async function toggleExpand(li, card) {
  if (li.classList.contains('expanded')) {
    li.classList.remove('expanded');
    li.querySelector('.expand')?.remove();
    return;
  }
  li.classList.add('expanded');

  const panel = document.createElement('div');
  panel.className = 'expand';
  panel.textContent = 'Loading…';
  li.appendChild(panel);

  if (!card.reps) {
    panel.textContent = 'No reviews yet — solve it and grade to start tracking.';
    return;
  }

  const r = await send('getCardStats', { slug: card.slug });
  if (!r?.ok) { panel.textContent = r?.error || 'failed to load'; return; }

  const s = r.summary;
  panel.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'stat-grid';
  const acText = s.submissions ? `${s.accepts}/${s.submissions}` : '—';
  grid.innerHTML = `
    <span>Reviews</span><b>${s.reviews}</b>
    <span>Lapses</span><b>${s.lapses}</b>
    <span>AC rate</span><b>${acText}</b>
    <span>Avg time</span><b>${fmtMs(s.avgDurMs)}</b>
    <span>Read total</span><b>${fmtMs(s.totalReadMs)}</b>
    <span>Code total</span><b>${fmtMs(s.totalCodeMs)}</b>
    <span>First</span><b>${fmtAgo(s.firstReviewAt)}</b>
    <span>Last</span><b>${fmtAgo(s.lastReviewAt)}</b>
    <span>Next due</span><b>${fmtDue(s.due)}</b>
  `;
  panel.appendChild(grid);

  const counts = document.createElement('div');
  counts.className = 'grade-counts';
  counts.innerHTML = `
    <span>Again <b>${s.counts.again}</b></span>
    <span>Hard <b>${s.counts.hard}</b></span>
    <span>Good <b>${s.counts.good}</b></span>
    <span>Easy <b>${s.counts.easy}</b></span>
  `;
  panel.appendChild(counts);

  if (s.subCounts && s.submissions) {
    const sub = document.createElement('div');
    sub.className = 'grade-counts sub-counts';
    const cells = [];
    if (s.subCounts.ac)  cells.push(`<span>AC <b>${s.subCounts.ac}</b></span>`);
    if (s.subCounts.wa)  cells.push(`<span>WA <b>${s.subCounts.wa}</b></span>`);
    if (s.subCounts.tle) cells.push(`<span>TLE <b>${s.subCounts.tle}</b></span>`);
    if (s.subCounts.mle) cells.push(`<span>MLE <b>${s.subCounts.mle}</b></span>`);
    if (s.subCounts.re)  cells.push(`<span>RE <b>${s.subCounts.re}</b></span>`);
    if (s.subCounts.ce)  cells.push(`<span>CE <b>${s.subCounts.ce}</b></span>`);
    sub.innerHTML = cells.join('');
    panel.appendChild(sub);
  }

  // last 8 entries
  const hist = document.createElement('div');
  hist.className = 'history';
  for (const h of (r.history ?? []).slice(-8).reverse()) {
    const row = document.createElement('div');
    row.className = 'h-row';
    const button = h.button || (h.q === 0 ? 'again' : h.q === 3 ? 'hard' : h.q === 5 ? 'easy' : 'good');
    row.innerHTML = `
      <span>${fmtAgo(h.t)}</span>
      <span class="h-grade ${button}">${button}</span>
      <span>${fmtMs(h.durationMs)}</span>
    `;
    hist.appendChild(row);
  }
  panel.appendChild(hist);
}

function renderList(ulSel, items, isDue) {
  const ul = $(ulSel);
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = isDue ? 'Nothing due — pick a new problem.' : '—';
    ul.appendChild(li);
    return;
  }
  for (const c of items) ul.appendChild(makeRow(c, isDue));
}

async function refreshSession() {
  const r = await send('getSession');
  const active = r?.session;
  if (active) {
    $('#start-session').classList.add('hidden');
    $('#session-active').classList.remove('hidden');
    $('#session-progress').textContent = `${active.completed} / ${active.queue.length}`;
  } else {
    $('#start-session').classList.remove('hidden');
    $('#session-active').classList.add('hidden');
  }
}

async function refresh() {
  const r = await send('getDueList');
  if (!r?.ok) return;
  $('#stat-due').textContent = r.due.length;
  $('#stat-total').textContent = r.total;
  const today = new Date().toISOString().slice(0, 10);
  $('#stat-today').textContent = r.stats?.byDay?.[today] ?? 0;
  renderList('#due-list', r.due, true);
  renderList('#upcoming-list', r.upcoming, false);
  // Reflect due count in button label, but keep button enabled so click
  // can still surface a "nothing due" message.
  $('#start-session').textContent = r.due.length > 0
    ? `Start session (${r.due.length})`
    : 'Start session';
  await refreshSession();
}

$('#start-session').addEventListener('click', async () => {
  const r = await send('startSession');
  if (r?.ok) {
    setTimeout(() => window.close(), 30);
  } else if (r?.error === 'no due problems') {
    alert('Nothing due — go pick a new problem.');
  } else if (r?.error) {
    alert(`Could not start session: ${r.error}`);
  }
});

$('#stop-session').addEventListener('click', async () => {
  await send('stopSession');
  await refreshSession();
});

$('#open-options').addEventListener('click', (e) => {
  e.preventDefault();
  chrome.runtime.openOptionsPage();
});

$('#flush').addEventListener('click', async () => {
  $('#flush-status').textContent = 'pushing…';
  const r = await send('flushSyncQueue');
  $('#flush-status').textContent = r?.ok ? `flushed ${r.flushed}` : (r?.error || 'failed');
});

refresh();
