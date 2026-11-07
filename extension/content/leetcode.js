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

  // Esc closes the modal. Attached once at script load, on window with
  // capture so Monaco/LeetCode handlers can't swallow it.
  // 1/2/3/4 grade Again/Hard/Good/Easy while the panel is open — but never
  // while you're typing in the editor or a text field.
  const KEY_TO_Q = { '1': 0, '2': 3, '3': 4, '4': 5 };
  function typingInto(t) {
    if (!t) return false;
    if (t.closest?.('.monaco-editor, .cm-editor')) return true;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable;
  }
  window.addEventListener('keydown', (e) => {
    if (!root || root.classList.contains('lcanki-hidden')) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      dismissPanel();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typingInto(e.target)) return;
    const q = KEY_TO_Q[e.key];
    if (q === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    onGrade(q);
  }, true);

  // ---------- site adapters ----------
  // Single path regex matches both `/problems/<slug>` (LeetCode + NeetCode)
  // and `/problem/<slug>` just in case. Hostname is intentionally not
  // restricted — manifest already gates which sites we run on.
  const PATH_RE = /^\/(?:problems?|practice|solutions?)\/([^/?#]+)/;

  function currentSlug() {
    const m = location.pathname.match(PATH_RE);
    return m ? m[1] : null;
  }
  // LeetCode is a SPA: on navigation the URL changes first and document.title
  // catches up a moment later. Reading the title during that gap gave problem
  // B the title of problem A — the "it says I did the first one again" bug.
  // So a title is only trusted if it matches the slug, or at least isn't the
  // title we already attributed to the PREVIOUS slug.
  const alnum = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const slugTitle = (slug) => slug ? slug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) : '';
  let prevSlugTitle = null;              // { slug, title } of the last problem

  function rawDocTitle() {
    const t = (document.title || '').replace(/ [\|\-–—] (LeetCode|NeetCode).*$/i, '').trim();
    return t && !/^(LeetCode|NeetCode)$/i.test(t) ? t.replace(/^\d+\.\s*/, '') : '';
  }
  function titleLooksRight(slug, t) {
    if (!t) return false;
    if (alnum(t).includes(alnum(slug))) return true;               // LeetCode: slug derives from title
    if (prevSlugTitle && prevSlugTitle.slug !== slug && prevSlugTitle.title === t) return false;  // stale
    return null;                                                   // unknown (NeetCode slugs differ)
  }
  function currentTitle() {
    const slug = currentSlug();
    const t = rawDocTitle();
    return titleLooksRight(slug, t) === false || !t ? slugTitle(slug) : t;
  }
  // Wait (briefly) for document.title to catch up with the URL, then settle.
  function settleTitle(slug, tries = 15) {
    const t = rawDocTitle();
    const ok = titleLooksRight(slug, t);
    if (ok === true || (ok === null && t) || tries <= 0) {
      const final = currentTitle();
      if (slug === currentSlug()) {
        setTitle(final);
        prevSlugTitle = { slug, title: final };
      }
      return;
    }
    setTimeout(() => settleTitle(slug, tries - 1), 200);
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
    if (m?.tag !== 'LCANKI_CODE') return;
    if (m.kind === 'coding-started' && !codingStartedReceived) {
      codingStartedReceived = true;
      markCodingStarted();
    } else if (m.kind === 'submission') {
      onNetworkVerdict(m);
    }
  });

  // ---------- submission detection ----------
  //
  // PRIMARY (authoritative): inject.js watches LeetCode's own judge endpoint
  // (/submissions/detail/<id>/check/) and posts the exact `status_msg` plus the
  // submission id. No DOM text matching, no "did they just hit submit?" gate,
  // deduped by submission id. This replaced a DOM scraper that misidentified
  // verdicts three ways:
  //   - false ACs: LeetCode re-renders your past submissions while the new
  //     result loads, and the old scraper matched the first status found in a
  //     container's concatenated textContent — so a stale "Accepted" won;
  //   - dropped real ACs: a 60s submit gate threw away verdicts from a slow
  //     judge, so the problem was never recorded and the modal never popped;
  //   - wrong status: same ordering problem picked whichever status appeared
  //     first in the DOM rather than the current one.
  //
  // FALLBACK: a MutationObserver, for sites with no observable judge call
  // (NeetCode runs its own). Deliberately conservative — see pickDomStatus.
  const STATUS_RE = /\b(Accepted|Wrong Answer|Time Limit Exceeded|Memory Limit Exceeded|Runtime Error|Compile Error|Output Limit Exceeded|Internal Error)\b/i;
  const STATUS_BAD = /Wrong|Error|Limit/i;
  // The DOM fallback still needs *some* guard against LeetCode rendering
  // submission history on page load. 5 minutes (not 60s) so a slow judge
  // can't age out a real verdict.
  const SUBMIT_GATE_MS = 5 * 60_000;
  // Collect DOM candidates for this long, then commit the last one — the real
  // verdict renders after any stale history rows.
  // On LeetCode the judge endpoint is authoritative, so the DOM fallback waits
  // long enough for the network verdict to win the race and only fills in if
  // the endpoint ever changes shape.
  const IS_LEETCODE = /(^|\.)leetcode\.com$/.test(location.hostname);
  const SETTLE_MS = IS_LEETCODE ? 8000 : 1500;

  let lastSubmission = null;            // { status, at, id, source }
  let lastSubmitClickAt = 0;
  let lastRunClickAt = 0;               // "Run" tests samples only — never a pass
  let submitSlug = null;                // slug on the page when Submit was pressed
  let submitObserver = null;
  let submitListenersWired = false;
  let acModalTimer = null;
  let sawNetworkVerdict = false;        // per problem; set by the inject.js bridge
  let domSettle = null;                 // { timer, candidates: [] }

  function wireSubmitListeners() {
    if (submitListenersWired) return;
    submitListenersWired = true;
    document.addEventListener('click', (e) => {
      const btn = e.target?.closest?.('button, [role="button"]');
      if (!btn) return;
      const text = (btn.textContent || '').trim();
      if (text.length >= 30) return;
      if (/submit/i.test(text)) {
        lastSubmitClickAt = Date.now();
        submitSlug = currentSlug();
      } else if (/^run(\s+(code|tests?))?$/i.test(text)) {
        lastRunClickAt = Date.now();
      }
    }, true);
    document.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // LeetCode: Cmd/Ctrl+Enter submits, Cmd/Ctrl+' runs the samples.
      if (e.key === 'Enter') { lastSubmitClickAt = Date.now(); submitSlug = currentSlug(); }
      else if (e.key === "'") { lastRunClickAt = Date.now(); }
    }, true);
  }

  // ---- authoritative path ----
  function onNetworkVerdict(msg) {
    sawNetworkVerdict = true;
    // A judge response always beats whatever the DOM fallback staged.
    if (domSettle) { clearTimeout(domSettle.timer); domSettle = null; }
    commitSubmission({
      status: msg.status,
      id: msg.submissionId,
      // Slug that SUBMITTED, captured from the submit request by inject.js.
      slug: msg.slug || submitSlug || currentSlug(),
      source: 'network',
      detail: {
        statusCode: msg.statusCode ?? null,
        runtime: msg.runtime ?? null,
        memory: msg.memory ?? null,
        totalCorrect: msg.totalCorrect ?? null,
        totalTestcases: msg.totalTestcases ?? null,
        lang: msg.lang ?? null,
      },
    });
  }

  // ---- fallback path ----
  function startSubmissionObserver() {
    if (submitObserver) return;
    submitObserver = new MutationObserver((mutations) => {
      try {
        // Once the judge endpoint has spoken for this problem, the DOM is
        // just decoration — stand down so it can never contradict the truth.
        if (sawNetworkVerdict) return;
        if (!lastSubmitClickAt || Date.now() - lastSubmitClickAt > SUBMIT_GATE_MS) return;
        if (lastRunClickAt > lastSubmitClickAt) return;   // a Run result, not a submission
        for (const m of mutations) {
          for (const n of m.addedNodes) {
            if (n.nodeType !== 1) continue;
            const found = pickDomStatus(n);
            if (found) stageDomStatus(found);
          }
        }
      } catch (e) {
        console.warn('[lcanki] observer error', e);
      }
    });
    submitObserver.observe(document.body, { childList: true, subtree: true });
  }

  // An element qualifies only if its OWN text is essentially just the verdict.
  // The old version accepted any container whose concatenated textContent held
  // a status anywhere (up to 200 chars), which is what let an unrelated or
  // historical "Accepted" be reported as the current result.
  function pickDomStatus(el, depth = 0) {
    if (!el || el.nodeType !== 1 || depth > 6) return null;
    // Prefer the most specific match: descend before judging this node.
    if (el.children) {
      for (const c of el.children) {
        const f = pickDomStatus(c, depth + 1);
        if (f) return f;
      }
    }
    const text = (el.textContent || '').trim();
    if (!text || text.length > 60) return null;        // containers are out
    const idx = text.search(STATUS_RE);
    if (idx < 0 || idx > 2) return null;               // must lead the text
    return text.match(STATUS_RE)[1];
  }

  function stageDomStatus(status) {
    if (!domSettle) {
      domSettle = { candidates: [], timer: null };
      domSettle.timer = setTimeout(() => {
        const cands = domSettle?.candidates ?? [];
        domSettle = null;
        if (!cands.length || sawNetworkVerdict) return;
        // Commit the LAST candidate: LeetCode paints the live result after any
        // history rows it re-rendered while the judge was running.
        if (lastRunClickAt > lastSubmitClickAt) return;   // user hit Run meanwhile
        commitSubmission({ status: cands[cands.length - 1], id: null, slug: submitSlug || currentSlug(), source: 'dom' });
      }, SETTLE_MS);
    }
    domSettle.candidates.push(status);
  }

  // ---- shared commit ----
  function commitSubmission({ status, id, slug, source, detail }) {
    if (!status) return;
    // Snapshot everything NOW. The old code read currentSlug()/currentTitle()
    // after an await, so a quick navigation re-filed the verdict under the
    // next problem.
    const pageSlug = currentSlug();
    slug = slug || pageSlug;
    if (!slug) return;
    const onSamePage = slug === pageSlug;
    const title = onSamePage ? currentTitle() : slugTitle(slug);
    const url = onSamePage ? location.href : null;
    // Dedupe by submission id when we have one (exact), else by status+time.
    if (id && lastSubmission?.id === id) return;
    if (!id && lastSubmission
        && lastSubmission.status.toLowerCase() === status.toLowerCase()
        && Date.now() - lastSubmission.at < 5000) return;

    // A verdict for a problem you've already left: record it under ITS slug,
    // but don't touch this page's badge/modal/editor — the editor now holds a
    // different problem's code, and grading here would grade the wrong card.
    if (onSamePage) {
      lastSubmission = { status, at: Date.now(), id: id ?? null, source };
      setSubmissionBadge(status);
      noteVerdict(status);
    }

    (async () => {
      const codeData = (onSamePage && /accepted/i.test(status)) ? await getCodeFromPage() : null;
      const r = await send('recordSubmission', {
        slug,
        title,
        url,
        status,
        submissionId: id ?? null,
        source,
        detail: detail ?? null,
        code: codeData?.code ?? null,
        language: codeData?.language ?? null,
      });
      if (!r?.ok) console.warn('[lcanki] recordSubmission failed:', r?.error);
      else console.log('[lcanki] recorded submission:', status, `(${source})`, 'for', slug);
    })();
    if (!onSamePage) return;

    // Only auto-pop the grade modal on Accepted. Other outcomes are tracked
    // silently — the user keeps iterating without interruption.
    clearTimeout(acModalTimer);
    if (/accepted/i.test(status)) {
      // A network verdict is final, so there is nothing to wait for. A DOM
      // verdict gets a beat in case a worse (real) status lands after it.
      const delay = source === 'network' ? 250 : 1800;
      acModalTimer = setTimeout(() => {
        if (lastSubmission && /accepted/i.test(lastSubmission.status)) {
          stopTimer();   // freeze time at the moment of acceptance
          showPanel();
          pulseWidget();
        }
      }, delay);
    }
  }

  function clearSubmission() {
    lastSubmission = null;
    sawNetworkVerdict = false;
    if (domSettle) { clearTimeout(domSettle.timer); domSettle = null; }
    clearTimeout(acModalTimer);
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
  // Dismiss without grading. In session-mode this advances to the next
  // problem; outside a session, it's a plain close.
  function dismissPanel() {
    hidePanel();
    send('skipInSession');
  }

  // ---------- attempt factors ----------
  // What separates "solved it" from "solved it after reading the editorial".
  // These feed the learner model: a peek turns an AC into a miss for ability
  // purposes, because the evidence is about the editorial, not about you.
  let attempt = null;
  function newAttempt() {
    attempt = { peeked: false, hints: new Set(), fails: 0, acAtMs: null, firstTryAc: null, startedAt: Date.now() };
  }
  newAttempt();
  const PEEK_PATH = /\/(editorial|solutions?)(\/|$)/i;
  function notePath() {
    if (attempt && attempt.acAtMs == null && PEEK_PATH.test(location.pathname)) attempt.peeked = true;
  }
  document.addEventListener('click', (e) => {
    if (!attempt) return;
    const el = e.target?.closest?.('button, a, [role="tab"], [role="button"], div');
    const text = (el?.textContent || '').trim();
    if (!text || text.length > 24) return;
    if (/^hint\s*\d+$/i.test(text)) attempt.hints.add(text.toLowerCase());
    else if (attempt.acAtMs == null && /^(editorial|solutions?|video solution)$/i.test(text)) attempt.peeked = true;
  }, true);
  function noteVerdict(status) {
    if (!attempt || attempt.acAtMs != null) return;      // only count up to the first AC
    if (/accepted/i.test(status)) {
      attempt.acAtMs = totalActiveMs();
      attempt.firstTryAc = attempt.fails === 0;
    } else {
      attempt.fails += 1;
    }
  }
  function attemptFactors() {
    return {
      peeked: !!attempt?.peeked,
      hints: attempt?.hints.size ?? 0,
      failsBeforeAc: attempt?.fails ?? 0,
      timeToAcMs: attempt?.acAtMs ?? null,
      firstTryAc: attempt?.firstTryAc ?? null,
      startedAt: attempt?.startedAt ?? null,   // the model predicts as of this moment
    };
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
    // Dismiss: × button, a grade button, or Esc. Backdrop click does NOT close.
    // × and Esc skip-advance the session if one is active.
    root.querySelector('.lcanki-close').addEventListener('click', dismissPanel);
    const btnRow = root.querySelector('.lcanki-buttons');
    for (const spec of BUTTON_SPECS) {
      const b = document.createElement('button');
      b.className = 'lcanki-btn';
      b.dataset.q = spec.q;
      b.dataset.id = spec.id;
      b.innerHTML = `<kbd class="lcanki-kbd">${BUTTON_SPECS.indexOf(spec) + 1}</kbd>${spec.label}<span class="lcanki-interval">—</span>`;
      b.title = `${spec.label} (press ${BUTTON_SPECS.indexOf(spec) + 1})`;
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
      try {
        chrome.runtime.sendMessage({ kind, ...payload }, (resp) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(resp);
          }
        });
      } catch (e) {
        // Common when the extension was reloaded while this tab kept its old
        // content script — "Extension context invalidated."
        resolve({ ok: false, error: e?.message || String(e) });
      }
    });
  }

  // Silence the "Extension context invalidated" unhandled rejection that
  // shows up in DevTools after an extension reload.
  window.addEventListener('unhandledrejection', (e) => {
    const msg = e?.reason?.message || '';
    if (/Extension context invalidated/i.test(msg)) {
      e.preventDefault();
    }
  });

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
      factors: attemptFactors(),
    });
    newAttempt();

    if (!resp?.ok) {
      console.warn('[lcanki] grade failed:', resp?.error);
    } else if (resp.syncError) {
      console.warn('[lcanki] sync failed:', resp.syncError);
    }
    refreshFromState();
    maybeShowNextButton();
  }

  // ---------- "Next problem" button (session control) ----------
  function ensureNextButton() {
    if (document.getElementById('lcanki-next')) return;
    const el = document.createElement('div');
    el.id = 'lcanki-next';
    el.classList.add('lcanki-hidden');
    el.innerHTML = `
      <button class="lcanki-next-btn"></button>
      <button class="lcanki-next-close" title="Dismiss" aria-label="Dismiss">×</button>
    `;
    document.body.appendChild(el);
    el.querySelector('.lcanki-next-btn').addEventListener('click', async () => {
      el.classList.add('lcanki-hidden');
      await send('skipInSession');   // advances + navigates if session active
    });
    el.querySelector('.lcanki-next-close').addEventListener('click', () => {
      el.classList.add('lcanki-hidden');
    });
  }
  function hideNextButton() {
    document.getElementById('lcanki-next')?.classList.add('lcanki-hidden');
  }
  async function maybeShowNextButton() {
    const r = await send('getSession');
    const sess = r?.session;
    if (!sess) return;
    ensureNextButton();
    const root = document.getElementById('lcanki-next');
    const btn = root.querySelector('.lcanki-next-btn');
    const last = sess.index >= sess.queue.length - 1;
    btn.textContent = last ? 'Finish session ✓' : 'Next problem →';
    root.classList.remove('lcanki-hidden');
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
    newAttempt();

    injectPageScript();
    wireSubmitListeners();
    ensureRoot();          // panel is created hidden
    setTitle(slugTitle(slug));
    settleTitle(slug);
    submitSlug = null; lastSubmitClickAt = 0; lastRunClickAt = 0;
    clearSubmission();
    hidePanel();
    resetTimer();
    refreshFromState();
    startSubmissionObserver();
    if (timerHandle) clearInterval(timerHandle);
    timerHandle = setInterval(() => {
      try { tickElapsed(); } catch (e) { console.warn('[lcanki] tick error', e); }
    }, 1000);

    // If this navigation was driven by an active session pointing at this
    // slug, click the page's Reset button to wipe leftover code. Give the
    // editor a beat to render first.
    maybeResetForSession(slug);
    hideNextButton();   // clear any leftover prompt from the previous problem
  }

  async function maybeResetForSession(slug) {
    const r = await send('getSession');
    if (!r?.session) return;
    const step = r.session.queue[r.session.index];
    if (!step || step.slug !== slug) return;
    setTimeout(pressResetAndConfirm, 1800);
  }

  function buttonLabels(b) {
    return [b.textContent, b.getAttribute?.('aria-label'), b.getAttribute?.('title')]
      .map(s => (s || '').trim())
      .filter(s => s && s.length < 30);
  }
  function isResetButton(b) {
    return buttonLabels(b).some(s => /^reset(\s+(code|to\s+default))?$/i.test(s));
  }
  function isConfirmButton(b) {
    return buttonLabels(b).some(s => /^(reset|confirm|yes|ok|continue|restore)$/i.test(s));
  }

  function pressResetAndConfirm(attempt = 0) {
    // The Monaco editor sits INSIDE its container, but the Reset button is
    // typically in a toolbar that's a SIBLING of the editor, not a child.
    // So searching the whole document is necessary.
    const all = Array.from(document.querySelectorAll('button, [role="button"]'));
    const visible = all.filter(b => b.offsetParent !== null);
    const matches = visible.filter(isResetButton);
    console.log('[lcanki] reset candidates:', matches.map(b => ({
      text: (b.textContent || '').trim(),
      aria: b.getAttribute?.('aria-label'),
      title: b.getAttribute?.('title'),
    })));
    if (!matches.length) {
      if (attempt < 15) setTimeout(() => pressResetAndConfirm(attempt + 1), 1000);
      return;
    }
    // Prefer the last visible match — nav/header rarely has Reset, toolbar
    // sits later in the DOM.
    const reset = matches[matches.length - 1];
    console.log('[lcanki] clicking reset:', reset);
    reset.click();
    // Confirm dialog can render slowly. Retry a few times BUT stop after the
    // first successful click — clicking "OK" again on a follow-up dialog
    // (e.g. NeetCode's save-before-reset prompt) can undo what we just did.
    let confirmed = false;
    const tryConfirm = () => {
      if (confirmed) return;
      if (clickConfirmInDialog(reset)) confirmed = true;
    };
    setTimeout(tryConfirm, 400);
    setTimeout(tryConfirm, 1200);
    setTimeout(tryConfirm, 2500);
  }

  function clickConfirmInDialog(skipBtn) {
    const dialogs = Array.from(document.querySelectorAll(
      '[role="dialog"], [aria-modal="true"], [role="alertdialog"], [class*="modal" i], [class*="Modal" i]'
    )).filter(d => d.offsetParent !== null);

    // Pass 1: prefer the specific destructive label ("Reset" / "Confirm").
    // Pass 2: fall back to generic affirmatives ("OK" / "Yes" / "Continue" / "Restore").
    // This prevents accidentally clicking an unrelated OK in some other modal.
    const passes = [/^(reset|confirm)$/i, /^(ok|yes|continue|restore)$/i];
    for (const pat of passes) {
      for (const d of dialogs) {
        const btn = Array.from(d.querySelectorAll('button, [role="button"]'))
          .find(b => b !== skipBtn && b.offsetParent !== null &&
                buttonLabels(b).some(s => pat.test(s)));
        if (btn) {
          console.log('[lcanki] clicking confirm:', btn);
          btn.click();
          return true;
        }
      }
    }
    return false;
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.kind === 'spa-navigated') setTimeout(() => { init(); notePath(); }, 300);
  });
  window.addEventListener('popstate', () => setTimeout(notePath, 50));

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
