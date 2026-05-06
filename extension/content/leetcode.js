// Content script: injected on LeetCode + NeetCode problem pages.
//
// Responsibilities:
//   1. Detect site adapter (leetcode.com vs neetcode.io) — slug + title
//   2. Inject + manage the floating grading widget
//   3. Track active time, split into reading vs coding (first keydown in editor)
//   4. Pull current code from the page (via inject.js bridge)
//   5. Handle SPA navigation (background pings us via re-init message)
//   6. Send grade events to the background worker

(() => {
  if (window.__lcanki_loaded) return;
  window.__lcanki_loaded = true;

  // ---------- site adapters ----------
  // Single path regex matches both `/problems/<slug>` (LeetCode + NeetCode)
  // and `/problem/<slug>` just in case. Hostname is intentionally not
  // restricted — manifest already gates which sites we run on.
  const PATH_RE = /^\/(?:problems?|practice|solutions?)\/([^/?#]+)/;

  function currentSlug() {
    const m = location.pathname.match(PATH_RE);
    return m ? m[1] : null;
  }
  function currentTitle() {
    const t = (document.title || '')
      .replace(/ [\|\-–—] (LeetCode|NeetCode).*$/i, '')
      .trim();
    if (t && !/^(LeetCode|NeetCode)$/i.test(t)) return t;
    const slug = currentSlug();
    return slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  }

  // ---------- inject.js bridge ----------
  const injectUrl = chrome.runtime.getURL('content/inject.js');
  function injectPageScript() {
    if (document.querySelector(`script[src="${injectUrl}"]`)) return;
    const s = document.createElement('script');
    s.src = injectUrl;
    s.async = false;
    (document.head || document.documentElement).appendChild(s);
  }

  function getCodeFromPage(timeoutMs = 1500) {
    return new Promise((resolve) => {
      const requestId = `r${Date.now()}-${Math.random()}`;
      const onMsg = (ev) => {
        if (ev.source !== window) return;
        const m = ev.data;
        if (!m || m.tag !== 'LCANKI_CODE' || m.kind !== 'response' || m.requestId !== requestId) return;
        window.removeEventListener('message', onMsg);
        resolve(m.ok ? { code: m.code, language: m.language } : null);
      };
      window.addEventListener('message', onMsg);
      window.postMessage({ tag: 'LCANKI_CODE', kind: 'request', requestId }, '*');
      setTimeout(() => { window.removeEventListener('message', onMsg); resolve(null); }, timeoutMs);
    });
  }

  // listen for the inject script's "coding-started" event (first keydown in editor)
  let codingStartedReceived = false;
  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const m = ev.data;
    if (m?.tag === 'LCANKI_CODE' && m.kind === 'coding-started' && !codingStartedReceived) {
      codingStartedReceived = true;
      markCodingStarted();
    }
  });

  // ---------- submission detection ----------
  // Two layers:
  //   A. Submit-intent gate: we only treat detected status as a real submission
  //      if the user clicked a Submit button (or hit Cmd/Ctrl+Enter) within
  //      the last 60s. Without this, LeetCode rendering past submission
  //      history on page load triggers spurious detections.
  //   B. MutationObserver: watches for status text appearing in newly added
  //      DOM nodes after the gate is open.
  // Match status anywhere in element text — LeetCode shows "Accepted" alongside
  // runtime/memory text, so partial matches need to work.
  const STATUS_RE = /\b(Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Compile Error|Output Limit Exceeded)\b/i;
  const STATUS_BAD = /Wrong|Error|Limit/i;
  const SUBMIT_GATE_MS = 60_000;
  let lastSubmission = null;            // { status, at }
  let lastSubmitClickAt = 0;
  let submitObserver = null;
  let submitListenersWired = false;

  function wireSubmitListeners() {
    if (submitListenersWired) return;
    submitListenersWired = true;
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button, [role="button"]');
      if (!btn) return;
      const text = (btn.textContent || '').trim();
      if (text.length < 30 && /submit/i.test(text)) {
        lastSubmitClickAt = Date.now();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        lastSubmitClickAt = Date.now();
      }
    }, true);
  }

  function startSubmissionObserver() {
    if (submitObserver) return;
    submitObserver = new MutationObserver((mutations) => {
      try {
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const found = findStatusIn(n, 0);
            if (found) { recordSubmission(found); return; }
          }
        }
      } catch (e) {
        console.warn('[lcanki] observer error', e);
      }
    });
    submitObserver.observe(document.body, { childList: true, subtree: true });
  }
  function findStatusIn(el, depth) {
    if (!el || depth > 6) return null;
    const text = (el.textContent || '').trim();
    if (text && text.length < 200) {
      const m = text.match(STATUS_RE);
      if (m) return m[1];
    }
    if (!el.children) return null;
    for (const c of el.children) {
      const f = findStatusIn(c, depth + 1);
      if (f) return f;
    }
    return null;
  }
  function recordSubmission(status) {
    // Gate: only treat as a real submission if the user clicked Submit
    // (or pressed Cmd/Ctrl+Enter) recently. Without this, LeetCode's past
    // submission summary rendering on page load fires false positives.
    if (!lastSubmitClickAt || Date.now() - lastSubmitClickAt > SUBMIT_GATE_MS) return;
    // Debounce: same status within 5s is the same submission
    if (lastSubmission && lastSubmission.status.toLowerCase() === status.toLowerCase()
        && Date.now() - lastSubmission.at < 5000) return;
    lastSubmission = { status, at: Date.now() };
    setSubmissionBadge(status);
    showPanel();
    pulseWidget();
  }
  function clearSubmission() {
    lastSubmission = null;
    if (root) setSubmissionBadge(null);
  }

  function showPanel() {
    if (!root) ensureRoot();
    root.classList.remove('lcanki-hidden');
    refreshFromState();
  }
  function hidePanel() {
    root?.classList.add('lcanki-hidden');
  }

  // ---------- time tracking (reading vs coding) ----------
  let activeMs = 0;            // total active time (visible)
  let codingMs = 0;            // active time AFTER first keydown
  let lastActiveStart = null;
  let lastCodingStart = null;
  let codingStarted = false;

  function startTimer() {
    if (document.visibilityState !== 'visible') return;
    if (lastActiveStart == null) lastActiveStart = Date.now();
    if (codingStarted && lastCodingStart == null) lastCodingStart = Date.now();
  }
  function stopTimer() {
    const now = Date.now();
    if (lastActiveStart != null) { activeMs += now - lastActiveStart; lastActiveStart = null; }
    if (lastCodingStart != null) { codingMs += now - lastCodingStart; lastCodingStart = null; }
  }
  function resetTimer() {
    activeMs = 0; codingMs = 0;
    lastActiveStart = null; lastCodingStart = null;
    codingStarted = false; codingStartedReceived = false;
    // tell inject.js to clear its codingStarted flag and re-attach the
    // Monaco listener for the new (or re-attempted) problem
    window.postMessage({ tag: 'LCANKI_CODE', kind: 'reset' }, '*');
    startTimer();
  }
  function markCodingStarted() {
    if (codingStarted) return;
    codingStarted = true;
    if (document.visibilityState === 'visible') lastCodingStart = Date.now();
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') startTimer();
    else stopTimer();
  });
  window.addEventListener('beforeunload', stopTimer);

  function totalActiveMs() {
    return activeMs + (lastActiveStart ? Date.now() - lastActiveStart : 0);
  }
  function totalCodingMs() {
    return codingMs + (lastCodingStart ? Date.now() - lastCodingStart : 0);
  }
  function totalReadingMs() {
    return Math.max(0, totalActiveMs() - totalCodingMs());
  }

  function fmtMs(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(s / 60);
    return `${m}m ${(s % 60).toString().padStart(2, '0')}s`;
  }
  function fmtInterval(min) {
    if (min == null) return '—';
    if (min < 60) return `${Math.round(min)}m`;
    if (min < 1440) {
      const h = min / 60;
      return Number.isInteger(h) ? `${h}h` : `${h.toFixed(1)}h`;
    }
    if (min < 1440 * 30) {
      const d = min / 1440;
      return Number.isInteger(d) ? `${d}d` : `${d.toFixed(1)}d`;
    }
    return `${Math.round(min / 1440 / 30)}mo`;
  }

  // ---------- widget DOM ----------
  // Default state: hidden. Auto-shows when a submission outcome is detected.
  // User can dismiss via the close button without grading.
  let root = null;
  let timerHandle = null;

  const BUTTON_SPECS = [
    { id: 'again', label: 'Again', q: 0 },
    { id: 'hard',  label: 'Hard',  q: 3 },
    { id: 'good',  label: 'Good',  q: 4 },
    { id: 'easy',  label: 'Easy',  q: 5 },
  ];

  function ensureRoot() {
    if (root && document.body.contains(root)) return;
    root = document.createElement('div');
    root.id = 'lcanki-root';
    root.classList.add('lcanki-hidden');
    root.innerHTML = `
      <div class="lcanki-panel">
        <div class="lcanki-title-row">
          <div class="lcanki-title"></div>
          <span class="lcanki-badge"></span>
          <button class="lcanki-close" title="Close" aria-label="Close">×</button>
        </div>
        <div class="lcanki-meta">
          <span class="lcanki-elapsed">0m 00s</span>
          <span class="lcanki-streak"></span>
        </div>
        <div class="lcanki-split"><span class="lcanki-read">read 0s</span> · <span class="lcanki-code">code 0s</span></div>
        <div class="lcanki-buttons"></div>
      </div>
    `;
    document.body.appendChild(root);
    // Only the × button or a grade button dismisses the modal.
    // Backdrop click and Esc do NOT close — the user wants the prompt sticky.
    root.querySelector('.lcanki-close').addEventListener('click', hidePanel);
    const btnRow = root.querySelector('.lcanki-buttons');
    for (const spec of BUTTON_SPECS) {
      const b = document.createElement('button');
      b.className = 'lcanki-btn';
      b.dataset.q = spec.q;
      b.dataset.id = spec.id;
      b.innerHTML = `${spec.label}<span class="lcanki-interval">—</span>`;
      b.addEventListener('click', () => onGrade(spec.q));
      btnRow.appendChild(b);
    }
  }

  function setTitle(s) {
    const el = root?.querySelector('.lcanki-title');
    if (el) el.textContent = s;
  }
  function setIntervals(predictions) {
    for (const spec of BUTTON_SPECS) {
      const el = root.querySelector(`.lcanki-btn[data-id="${spec.id}"] .lcanki-interval`);
      if (!el) continue;
      el.textContent = fmtInterval(predictions?.[spec.id]);
    }
  }
  function setStreak(text) {
    const el = root.querySelector('.lcanki-streak');
    if (el) el.textContent = text || '';
  }
  function setSubmissionBadge(status) {
    const el = root?.querySelector('.lcanki-badge');
    if (!el) return;
    el.textContent = status || '';
    el.className = 'lcanki-badge';
    if (!status) return;
    if (/accepted/i.test(status)) el.classList.add('lcanki-badge-ok');
    else if (STATUS_BAD.test(status)) el.classList.add('lcanki-badge-err');
  }
  function pulseWidget() {
    if (!root) return;
    root.classList.remove('lcanki-pulse');
    // force reflow so the animation re-triggers
    void root.offsetWidth;
    root.classList.add('lcanki-pulse');
    setTimeout(() => root?.classList.remove('lcanki-pulse'), 3200);
  }
  function tickElapsed() {
    if (!root) return;
    const el = root.querySelector('.lcanki-elapsed');
    const r  = root.querySelector('.lcanki-read');
    const c  = root.querySelector('.lcanki-code');
    if (el) el.textContent = fmtMs(totalActiveMs());
    if (r)  r.textContent  = `read ${fmtMs(totalReadingMs())}`;
    if (c)  c.textContent  = `code ${fmtMs(totalCodingMs())}`;
  }
  function showToast(message, isError = false) {
    if (!root) return;
    const panel = root.querySelector('.lcanki-panel');
    if (!panel) return;
    let toast = root.querySelector('.lcanki-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.className = 'lcanki-toast';
      panel.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.toggle('lcanki-error', isError);
    clearTimeout(toast._lcAnkiTimer);
    toast._lcAnkiTimer = setTimeout(() => toast.remove(), 4000);
  }

  // ---------- background bridge ----------
  function send(kind, payload = {}) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp);
      });
    });
  }

  async function refreshFromState() {
    const slug = currentSlug();
    if (!slug) return;
    const resp = await send('getCardWithPredictions', { slug, title: currentTitle() });
    if (!resp?.ok) return;
    setIntervals(resp.predictions);
    const c = resp.card;
    if (!c || (!c.reps && !c.lapses))      setStreak('new');
    else if (!c.reps)                      setStreak(`lapsed · ${c.lapses}L`);
    else                                   setStreak(`reps ${c.reps}${c.lapses ? ` · ${c.lapses}L` : ''}`);
    scheduleMetaFetch();
  }

  // NeetCode pages link to the LeetCode equivalent — find that link and
  // extract the LC slug, since LeetCode's GraphQL is keyed by LC slug.
  function findLeetCodeSlug() {
    const a = document.querySelector('a[href*="leetcode.com/problems/"]');
    if (!a) return null;
    const m = a.href.match(/leetcode\.com\/problems\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  function scheduleMetaFetch() {
    const slug = currentSlug();
    if (!slug) return;
    const isNeetCode = location.hostname.includes('neetcode');
    if (!isNeetCode) {
      send('ensureMeta', { slug });
      return;
    }
    // NeetCode: try to find the LC slug from the page DOM. Their problem
    // viewers always link out to LeetCode somewhere. Poll a few times because
    // the link may load async.
    let attempts = 0;
    const tryFetch = () => {
      const lcSlug = findLeetCodeSlug();
      if (lcSlug) {
        send('ensureMeta', { slug, lcSlug });
        return;
      }
      attempts++;
      if (attempts < 12) setTimeout(tryFetch, 1000);
      else send('ensureMeta', { slug }); // fallback: try with NC slug
    };
    tryFetch();
  }

  async function onGrade(quality) {
    const slug = currentSlug();
    if (!slug) return;

    // Snapshot timing before we tear anything down.
    stopTimer();
    const totalMs = totalActiveMs();
    const codeMs  = totalCodingMs();
    const readMs  = Math.max(0, totalMs - codeMs);

    // Brief highlight flash so the user sees their click registered, then
    // close. Sync runs in the background; the user does not wait for it.
    const clickedBtn = root?.querySelector(`.lcanki-btn[data-q="${quality}"]`);
    clickedBtn?.classList.add('lcanki-btn-active');
    setTimeout(() => {
      hidePanel();
      clickedBtn?.classList.remove('lcanki-btn-active');
    }, 120);
    resetTimer();

    const codeData = await getCodeFromPage();
    const resp = await send('grade', {
      slug,
      title: currentTitle(),
      quality,
      durationMs: totalMs,
      readingMs: readMs,
      codingMs: codeMs,
      code: codeData?.code ?? null,
      language: codeData?.language ?? null,
      url: location.href,
      submission: lastSubmission ? { status: lastSubmission.status, at: lastSubmission.at } : null,
    });

    if (!resp?.ok) {
      console.warn('[lcanki] grade failed:', resp?.error);
    } else if (resp.syncError) {
      console.warn('[lcanki] sync failed:', resp.syncError);
    }
    refreshFromState();
  }

  // ---------- lifecycle ----------
  let currentInitSlug = null;

  function init() {
    const slug = currentSlug();
    console.log('[lcanki] init', { href: location.href, slug, prev: currentInitSlug });
    if (!slug) {
      // navigated off a problem page — drop state so a future return runs full init
      currentInitSlug = null;
      hidePanel();
      return;
    }
    if (slug === currentInitSlug) {
      // same problem; SPA likely changed a query/fragment. Don't tear down
      // the panel or reset timers — that's what was causing the flash.
      return;
    }
    currentInitSlug = slug;

    injectPageScript();
    wireSubmitListeners();
    ensureRoot();          // panel is created hidden
    setTitle(currentTitle());
    clearSubmission();
    hidePanel();
    resetTimer();
    refreshFromState();
    startSubmissionObserver();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      try { tickElapsed(); } catch (e) { console.warn('[lcanki] tick error', e); }
    }, 1000);
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'spa-navigated') setTimeout(init, 300);
  });

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
