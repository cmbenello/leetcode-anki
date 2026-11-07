// NeetCode progress sync (content script on every neetcode.io page).
//
// NeetCode keeps your completed problems in this site's localStorage:
//   "synced-progress-cache"  { completed: { [pattern]: ["two-sum/", ...] }, starred }
//                            — your ACCOUNT's progress, refreshed whenever you
//                              open a practice list while logged in
//   "completed-problem-list" { [pattern]: ["two-sum/", ...] }
//                            — progress made while logged out
// The entries are LeetCode slugs, so they map straight onto the problems the
// extension already tracks. We read both, and send the union to the
// background only when it changes. Read-only: nothing on NeetCode is touched.
(() => {
  if (window.__lcankiNeetcodeSync) return;
  window.__lcankiNeetcodeSync = true;

  const KEYS = ['synced-progress-cache', 'completed-problem-list'];
  let lastSent = null;

  function readCompleted() {
    const slugs = new Set();
    let account = false;
    for (const key of KEYS) {
      let raw = null;
      try { raw = JSON.parse(localStorage.getItem(key) || 'null'); } catch { raw = null; }
      if (!raw) continue;
      const lists = key === 'synced-progress-cache' ? raw.completed : raw;
      if (!lists || typeof lists !== 'object') continue;
      if (key === 'synced-progress-cache') account = true;
      for (const arr of Object.values(lists)) {
        if (!Array.isArray(arr)) continue;
        for (const link of arr) {
          const s = String(link || '').replace(/^.*\/problems\//, '').replace(/\/+$/, '').toLowerCase();
          if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(s)) slugs.add(s);
        }
      }
    }
    return { slugs: [...slugs].sort(), account };
  }

  function sync() {
    if (!chrome.runtime?.id) return;                 // extension reloaded; this script is orphaned
    const { slugs, account } = readCompleted();
    const sig = slugs.join(',');
    if (sig === lastSent) return;
    try {
      chrome.runtime.sendMessage({ kind: 'neetcodeProgress', slugs, account }, (r) => {
        if (chrome.runtime.lastError || !r?.ok) return;   // retry on the next tick
        lastSent = sig;
      });
    } catch { /* orphaned */ }
  }

  sync();
  // NeetCode updates these keys in place as you tick problems off or as a
  // practice list loads your account's progress, so check periodically.
  setInterval(() => { if (document.visibilityState === 'visible') sync(); }, 4000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') sync(); });
})();
