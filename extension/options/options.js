import { getSettings, setSettings, getCards, setCards, getStats, DEFAULT_SETTINGS } from '../lib/storage.js';
import { verifyAccess } from '../lib/github.js';
import { parseDuration, formatDuration, DEFAULT_INTERVALS_MIN, DEFAULT_GROWTH } from '../lib/sm2.js';

const $ = (s) => document.querySelector(s);

function send(kind, payload = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
      if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
      else resolve(resp);
    });
  });
}

const F = {
  intAgain: $('#int-again'),
  intHard:  $('#int-hard'),
  intGood:  $('#int-good'),
  intEasy:  $('#int-easy'),
  growHard: $('#grow-hard'),
  growGood: $('#grow-good'),
  growEasy: $('#grow-easy'),
  easeEnabled: $('#ease-enabled'),

  reminderEnabled: $('#reminder-enabled'),
  reminderTime:    $('#reminder-time'),

  repo:        $('#github-repo'),
  token:       $('#github-token'),
  syncEnabled: $('#sync-enabled'),
  defaultLang: $('#default-lang'),
};

function setStatus(el, text, level) {
  el.textContent = text || '';
  el.classList.toggle('ok', level === 'ok');
  el.classList.toggle('err', level === 'err');
}

async function load() {
  const s = await getSettings();
  F.intAgain.value = formatDuration(s.intervals.again);
  F.intHard.value  = formatDuration(s.intervals.hard);
  F.intGood.value  = formatDuration(s.intervals.good);
  F.intEasy.value  = formatDuration(s.intervals.easy);
  F.growHard.value = s.growth.hard;
  F.growGood.value = s.growth.good;
  F.growEasy.value = s.growth.easy;
  F.easeEnabled.checked = s.easeEnabled !== false;

  F.reminderEnabled.checked = !!s.dailyReminderEnabled;
  F.reminderTime.value      = s.dailyReminderTime || '09:00';

  F.repo.value        = s.githubRepo || '';
  F.token.value       = s.githubToken || '';
  F.syncEnabled.checked = !!s.syncEnabled;
  F.defaultLang.value = s.defaultLang || 'python3';
}

function readForm() {
  const intAgain = parseDuration(F.intAgain.value) ?? DEFAULT_INTERVALS_MIN.again;
  const intHard  = parseDuration(F.intHard.value)  ?? DEFAULT_INTERVALS_MIN.hard;
  const intGood  = parseDuration(F.intGood.value)  ?? DEFAULT_INTERVALS_MIN.good;
  const intEasy  = parseDuration(F.intEasy.value)  ?? DEFAULT_INTERVALS_MIN.easy;
  const growHard = parseFloat(F.growHard.value) || DEFAULT_GROWTH.hard;
  const growGood = parseFloat(F.growGood.value) || DEFAULT_GROWTH.good;
  const growEasy = parseFloat(F.growEasy.value) || DEFAULT_GROWTH.easy;
  return {
    intervals: { again: intAgain, hard: intHard, good: intGood, easy: intEasy },
    growth:    { again: 1.0,      hard: growHard, good: growGood, easy: growEasy },
    easeEnabled: F.easeEnabled.checked,
    dailyReminderEnabled: F.reminderEnabled.checked,
    dailyReminderTime:    F.reminderTime.value || '09:00',
    githubRepo:  F.repo.value.trim(),
    githubToken: F.token.value.trim(),
    syncEnabled: F.syncEnabled.checked,
    defaultLang: F.defaultLang.value,
  };
}

$('#save').addEventListener('click', async () => {
  await setSettings(readForm());
  await send('updateDailyReminder');
  setStatus($('#status'), 'saved.', 'ok');
});

$('#reset-intervals').addEventListener('click', () => {
  F.intAgain.value = formatDuration(DEFAULT_INTERVALS_MIN.again);
  F.intHard.value  = formatDuration(DEFAULT_INTERVALS_MIN.hard);
  F.intGood.value  = formatDuration(DEFAULT_INTERVALS_MIN.good);
  F.intEasy.value  = formatDuration(DEFAULT_INTERVALS_MIN.easy);
  F.growHard.value = DEFAULT_GROWTH.hard;
  F.growGood.value = DEFAULT_GROWTH.good;
  F.growEasy.value = DEFAULT_GROWTH.easy;
  setStatus($('#status'), 'reset (click Save to apply).', 'ok');
});

$('#test-reminder').addEventListener('click', async () => {
  await send('fireReminderNow');
});

$('#verify').addEventListener('click', async () => {
  setStatus($('#verify-status'), 'checking…');
  try {
    const info = await verifyAccess({
      token: F.token.value.trim(),
      repo:  F.repo.value.trim(),
    });
    setStatus($('#verify-status'), `ok — ${info.fullName} (default: ${info.defaultBranch})`, 'ok');
  } catch (e) {
    setStatus($('#verify-status'), e.message, 'err');
  }
});

async function runClean(dryRun) {
  const el = $('#clean-status');
  setStatus(el, dryRun ? 'scanning…' : 'repairing…');
  const r = await send('cleanSubmissions', { dryRun });
  if (!r?.ok) { setStatus(el, r?.error || 'failed', 'err'); return; }
  const parts = [
    `${r.removed} bogus verdict${r.removed === 1 ? '' : 's'}`,
    `${r.phantomAccepts} phantom AC${r.phantomAccepts === 1 ? '' : 's'}`,
    `${r.titlesFixed} wrong title${r.titlesFixed === 1 ? '' : 's'}`,
  ];
  setStatus(el, `${dryRun ? 'would fix' : 'fixed'}: ${parts.join(' · ')}`, 'ok');
}
$('#clean-preview').addEventListener('click', () => runClean(true));
$('#clean-run').addEventListener('click', () => runClean(false));

$('#repair-urls').addEventListener('click', async () => {
  if (!confirm('Scan all cards without stored URLs and probe LeetCode to detect their site?')) return;
  const status = $('#repair-status');
  status.textContent = 'scanning…';
  status.className = '';
  const r = await send('repairCardUrls');
  if (r?.ok) {
    status.textContent = `repaired ${r.repaired}/${r.total} (${r.lc} LC · ${r.nc} NC) · skipped ${r.skipped}${r.errors ? ` · ${r.errors} errors` : ''}`;
    status.className = 'ok';
  } else {
    status.textContent = r?.error || 'failed';
    status.className = 'err';
  }
});

$('#export').addEventListener('click', async () => {
  const data = {
    cards: await getCards(),
    stats: await getStats(),
    settings: await getSettings(),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `leetcode-anki-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$('#export-drill').addEventListener('click', async () => {
  const r = await send('exportDrill');
  if (!r?.ok) { setStatus($('#drill-status'), r?.error || 'failed', 'err'); return; }
  const n = r.jsonl ? r.jsonl.trim().split('\n').filter(Boolean).length : 0;
  const url = URL.createObjectURL(new Blob([r.jsonl], { type: 'application/x-ndjson' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `leetcode-attempts-${new Date().toISOString().slice(0, 10)}.jsonl`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus($('#drill-status'), `${n} attempts exported`, 'ok');
});

// ---------- LeetCode history import ----------
let importPoll = 0;
function renderImport(st) {
  const el = $('#import-status');
  const running = !!st?.running;
  $('#import-lc').disabled = running;
  $('#import-cancel').hidden = !running;
  if (!st) { setStatus(el, ''); return; }
  if (running) {
    setStatus(el, `importing… ${st.pages} page${st.pages === 1 ? '' : 's'} · ${st.added} submissions · ${st.newCards} new problems`);
  } else if (st.error) {
    setStatus(el, st.error, 'err');
  } else if (st.finishedAt) {
    const when = new Date(st.finishedAt).toLocaleString();
    setStatus(el, `done ${when}: ${st.added} submissions, ${st.newCards} new problems` +
      (st.scheduled ? `, ${st.scheduled} added to reviews at ${st.perDay}/day` : ''), 'ok');
  }
  clearTimeout(importPoll);
  if (running) importPoll = setTimeout(refreshImport, 1000);
}
async function refreshImport() {
  const r = await send('getImportState');
  renderImport(r?.state);
}
$('#import-lc').addEventListener('click', async () => {
  setStatus($('#import-status'), 'starting…');
  const r = await send('startImport', { perDay: +$('#import-per-day').value || 5 });
  if (!r?.ok) setStatus($('#import-status'), r?.error || 'could not start', 'err');
  refreshImport();
});
$('#import-cancel').addEventListener('click', async () => {
  await send('cancelImport');
  refreshImport();
});
refreshImport();

// ---------- NeetCode ----------
(async () => {
  const st = await getSettings();
  $('#open-on').value = st.openOn || 'leetcode';
  $('#open-on').addEventListener('change', async () => {
    await setSettings({ openOn: $('#open-on').value });
    setStatus($('#status'), 'saved.', 'ok');
  });
  const { neetcodeSync } = await chrome.storage.local.get('neetcodeSync');
  $('#nc-status').textContent = neetcodeSync
    ? `Last synced ${new Date(neetcodeSync.at).toLocaleString()}: ${neetcodeSync.count} completed problem${neetcodeSync.count === 1 ? '' : 's'} on NeetCode${neetcodeSync.account ? '' : ' (logged-out progress only, so log in and open a practice list to sync your account)'}.`
    : 'Not synced yet. Open neetcode.io and visit a practice list.';
})();

$('#import').addEventListener('click', () => $('#import-file').click());
$('#import-file').addEventListener('change', async (ev) => {
  const file = ev.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (!data.cards) throw new Error('missing "cards" key');
    if (!confirm(`Replace local data with ${Object.keys(data.cards).length} cards?`)) return;
    await setCards(data.cards);
    setStatus($('#status'), 'imported.', 'ok');
  } catch (e) {
    setStatus($('#status'), `import failed: ${e.message}`, 'err');
  }
});

load();
