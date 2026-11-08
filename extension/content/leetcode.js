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
  // One live copy per tab. After an extension update the copy already running
  // here is cut off from the extension ("Extension context invalidated") and
  // the background injects a fresh one (background.js reattachContentScripts):
  // let it in, and the cut-off copy goes quiet (see retire below).
  if (window.__lcanki_loaded && window.__lcanki_alive?.()) return;
  window.__lcanki_loaded = true;
  window.__lcanki_alive = () => { try { return !!chrome.runtime?.id; } catch (e) { return false; } };
  // Stamp the page so a cut-off older copy knows a live one is here.
  const MY_START = Date.now();
  document.documentElement.setAttribute('data-lcanki-live', String(MY_START));

  // Esc closes the modal. Attached once at script load, on window with
  // capture so Monaco/LeetCode handlers can't swallow it.
  // 1–4 rate difficulty (1 = easy … 4 = very hard) while the bar is open —
  // never while you're typing in the editor or a text field.
  const KEY_TO_Q = { '1': 5, '2': 4, '3': 3, '4': 0 };
  const Q_TO_KEY = { 5: '1', 4: '2', 3: '3', 0: '4' };
  // The number you pressed flashes up mid-screen for a moment, so you know
  // it landed without looking for the bar.
  function flashKey(label) {
    if (!label || !document.body) return;
    document.querySelectorAll('.lcanki-flash').forEach(el => el.remove());
    const el = document.createElement('div');
    el.className = 'lcanki-flash';
    el.textContent = label;
    el.setAttribute('aria-hidden', 'true');
    document.body.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
    setTimeout(() => el.remove(), 1500);
  }
  function typingInto(t) {
    if (!t) return false;
    if (t.closest?.('.monaco-editor, .cm-editor')) return true;
    const tag = (t.tagName || '').toLowerCase();
    return tag === 'input' || tag === 'textarea' || t.isContentEditable;
  }
  // After an extension update, the copy of this script already running in an
  // open tab is cut off from the extension. It must not keep showing its old
  // popup or grabbing keys: it removes itself, and the refreshed tab has the new one.
  const orphaned = () => { try { return !chrome.runtime?.id; } catch (e) { return true; } };
  // A cut-off copy stops doing anything: no popup, no keys, no failed saves.
  let retired = false;
  function retire() {
    if (retired) return true;
    if (!orphaned()) return false;
    retired = true;
    try { root?.remove(); } catch (e) {}
    try { clearInterval(timerHandle); } catch (e) {}
    try { submitObserver?.disconnect(); } catch (e) {}
    return true;
  }
  // ...unless it's the only copy left when you get Accepted: then say so,
  // rather than losing the solve silently.
  function showUpdateNotice() {
    const live = Number(document.documentElement.getAttribute('data-lcanki-live')) || 0;
    if (live > MY_START || document.getElementById('lcanki-update')) return;   // a fresh copy has it
    const el = document.createElement('div');
    el.id = 'lcanki-update';
    el.setAttribute('style', 'position:fixed;left:50%;top:45%;transform:translate(-50%,-50%);z-index:2147483647;'
      + 'display:flex;align-items:center;gap:14px;padding:14px 16px 14px 20px;border-radius:14px;'
      + 'background:#1c1d20;border:1px solid rgba(206,210,217,.16);box-shadow:0 18px 50px rgba(0,0,0,.5);'
      + 'font:500 14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:rgba(236,239,244,.95)');
    const msg = document.createElement('span');
    msg.textContent = 'LeetCode Anki was updated. Refresh to record this solve.';
    const btn = document.createElement('button');
    btn.textContent = 'Refresh';
    btn.setAttribute('style', 'font:inherit;padding:6px 14px;border-radius:9px;border:0;cursor:pointer;background:rgba(236,239,244,.92);color:#17181b');
    btn.addEventListener('click', () => location.reload());
    el.append(msg, btn);
    document.body.appendChild(el);
  }
  window.addEventListener('keydown', (e) => {
    if (retire()) return;
    if (!root || root.classList.contains('lcanki-hidden')) return;
    if (e.key === 'Escape' || e.key === 'Esc') {
      e.preventDefault();
      e.stopPropagation();
      dismissPanel();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || typingInto(e.target)) return;
    if (e.key === 's' || e.key === 'S') { e.preventDefault(); e.stopPropagation(); toggleStar(); return; }
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
    if (document.documentElement.hasAttribute('data-lcanki-inject')) return;   // the manifest already loaded it
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
    if (retire()) {
      if (/accepted/i.test(status) && (!slug || slug === currentSlug())) showUpdateNotice();
      return;
    }
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
      const delay = source === 'network' ? 60 : 1800;
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

  // LeetCode shows the difficulty on the page; reading it there is instant.
  // Class names have changed over the years (text-difficulty-*, text-sd-*,
  // the old olive/yellow/pink), and after a submit the description panel can
  // be gone entirely; then the background's catalog answers instead.
  function pageDifficulty() {
    // Only the problem's own badge: the "similar questions" list on the same
    // page marks ITS difficulties with text-olive/text-yellow, which would
    // otherwise be picked up when the description isn't showing.
    const els = document.querySelectorAll(
      '[class*="text-difficulty-"], [class*="text-sd-easy"], [class*="text-sd-medium"], [class*="text-sd-hard"]');
    for (const el of els) {
      const m = (el.textContent || '').trim().match(/^(Easy|Medium|Hard)$/i);
      if (m) return m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    }
    return null;
  }
  // After a submit LeetCode swaps the description for the submission view, so
  // the badge may be gone when the card appears: remember it from when the
  // problem loaded (checked every second until found).
  let knownDifficulty = { slug: null, d: null };
  function rememberDifficulty() {
    const slug = currentSlug();
    if (knownDifficulty.slug === slug && knownDifficulty.d) return;
    const d = pageDifficulty();
    knownDifficulty = { slug, d: d || null };
  }
  function difficultyNow() {
    return pageDifficulty() || (knownDifficulty.slug === currentSlug() ? knownDifficulty.d : null);
  }
  function showDifficulty(d) {
    const el = root?.querySelector('.lcanki-diff');
    if (!el || (!d && !el.hidden)) return;
    el.textContent = d || '';
    el.hidden = !d;
    el.dataset.level = (d || '').toLowerCase();
  }
  function showPanel() {
    if (retire()) return;
    if (!root) ensureRoot();
    setTitle(currentTitle());
    showDifficulty(difficultyNow());
    root.classList.remove('lcanki-hidden');
    refreshFromState();
    // and its own lookup, so nothing else in refreshFromState can cost it
    const slug = currentSlug();
    send('getDifficulty', { slug }).then((r) => { if (r?.difficulty && slug === currentSlug()) showDifficulty(difficultyNow() || r.difficulty); });
  }
  function hidePanel() {
    root?.classList.add('lcanki-hidden');
  }
  // Dismiss without grading. In session-mode this advances to the next
  // problem; outside a session, it's a plain close.
  function dismissPanel() {
    hidePanel();
    // closing without rating: keep the solve, but schedule no review
    send('dismissRating', { slug: currentSlug() });
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

  // You rate how hard it was; the scheduler maps that to its own terms, so
  // there's no "Again" button and no intervals to look at:
  //   1 easy -> easy, 2 -> good, 3 -> hard, 4 very hard -> again
  const BUTTON_SPECS = [
    { id: 'easy',  label: '1', hint: 'easy',      q: 5 },
    { id: 'good',  label: '2', hint: 'ok',        q: 4 },
    { id: 'hard',  label: '3', hint: 'hard',      q: 3 },
    { id: 'again', label: '4', hint: 'very hard', q: 0 },
  ];

  function ensureRoot() {
    if (root && document.body.contains(root)) return;
    root = document.createElement('div');
    root.id = 'lcanki-root';
    root.classList.add('lcanki-hidden');
    // A small bar in the corner, not a modal: no backdrop, doesn't take focus,
    // the page stays usable behind it.
    // Just the problem and its difficulty. You rate with the keys — 1 easy …
    // 4 very hard, S stars it — and the number you press flashes up. Esc (or
    // the × that shows on hover) closes it: the solve is kept, no review.
    root.innerHTML = `
      <div class="lcanki-panel lcanki-bar" role="group" aria-label="How hard was it? Press 1 (easy) to 4 (very hard)">
        <span class="lcanki-title"></span>
        <span class="lcanki-diff" hidden></span>
        <button class="lcanki-star" type="button" aria-pressed="false" title="Come back to this (S)" aria-label="Star: come back to this">☆</button>
        <button class="lcanki-close" title="Close: keep the solve, no review (Esc)" aria-label="Close">×</button>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('.lcanki-close').addEventListener('click', dismissPanel);
    root.querySelector('.lcanki-star').addEventListener('click', toggleStar);
  }

  // ★ "come back to this": saved straight away, kept whether you rate or close.
  let starred = false;
  function showStar(on) {
    starred = !!on;
    const b = root?.querySelector('.lcanki-star');
    if (!b) return;
    b.textContent = starred ? '★' : '☆';
    b.setAttribute('aria-pressed', String(starred));
    b.classList.toggle('on', starred);
  }
  async function toggleStar() {
    const slug = currentSlug();
    if (!slug) return;
    const want = !starred;
    showStar(want);
    const r = await send('setStar', { slug, starred: want });
    if (!r?.ok) showStar(!want);
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
    showStar(resp.starred ?? resp.card?.starred);
    showDifficulty(difficultyNow() || resp.difficulty);
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
    flashKey(Q_TO_KEY[quality]);
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
    rememberDifficulty();
    timerHandle = setInterval(() => {
      try { tickElapsed(); } catch (e) { console.warn('[lcanki] tick error', e); }
      try { rememberDifficulty(); } catch (e) {}
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

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.kind === 'spa-navigated') setTimeout(() => { init(); notePath(); }, 300);
    if (msg?.kind === 'lc-import-run') {
      sendResponse({ ok: true, started: true });
      runHistoryImport(msg.cursor || {}).catch((e) => send('importProgress', { error: e?.message || String(e) }));
    }
  });

  // ---------- history import ----------
  // Runs INSIDE a leetcode.com tab so the request carries your login and
  // LeetCode's own CSRF token, exactly as the site's submissions page does.
  // (The REST /api/submissions endpoint sits behind a bot check that scripted
  // requests can't pass; GraphQL doesn't.) Newest first, 20 per page.
  const SUBMISSIONS_Q = `
    query submissionList($offset: Int!, $limit: Int!, $lastKey: String) {
      submissionList(offset: $offset, limit: $limit, lastKey: $lastKey) {
        lastKey hasNext
        submissions { id title titleSlug statusDisplay lang runtime memory timestamp }
      }
    }`;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  async function runHistoryImport({ offset = 0, lastKey = null }) {
    const csrf = (document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/) || [])[1] || '';
    let pages = 0;
    for (;;) {
      let res = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        res = await fetch('/graphql/', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'x-csrftoken': csrf },
          body: JSON.stringify({ query: SUBMISSIONS_Q, variables: { offset, limit: 20, lastKey } }),
        });
        if (res.status !== 429 && res.status < 500) break;
        await sleep(2500 * (attempt + 1));          // rate limited / flaky: back off
      }
      if (!res.ok) { await send('importProgress', { error: `LeetCode answered ${res.status}` }); return; }
      const list = (await res.json())?.data?.submissionList;
      if (!list?.submissions) {
        await send('importProgress', pages ? { finished: true } : { error: 'not-logged-in' });
        return;
      }
      pages += 1;
      offset += list.submissions.length;
      lastKey = list.lastKey ?? null;
      const r = await send('importBatch', { submissions: list.submissions, cursor: { offset, lastKey } });
      if (!r?.ok || r.stop) return;                 // cancelled, or caught up with what we already have
      if (!list.hasNext || !list.submissions.length) { await send('importProgress', { finished: true }); return; }
      await sleep(700);
    }
  }
  window.addEventListener('popstate', () => setTimeout(notePath, 50));

  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });
})();
