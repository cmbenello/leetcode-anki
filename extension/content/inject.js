// Runs in PAGE context (not the content-script isolated world).
// Three responsibilities:
//   1. On request, read code from the Monaco editor and post it back.
//   2. Detect "user has started coding" — first edit inside the Monaco
//      editor — and post a one-shot message so the content script can split
//      time into reading vs coding.
//   3. Watch LeetCode's judge endpoint and report the AUTHORITATIVE verdict.
//
// (3) exists because scraping the verdict out of the DOM is unreliable in
// both directions: LeetCode re-renders your past submissions while the new
// result loads (so a stale "Accepted" gets picked up), and a slow judge can
// return after any reasonable "did they just hit submit?" gate has closed (so
// a real Accepted is dropped). The page itself polls
//   /submissions/detail/<id>/check/
// until `state === "SUCCESS"`, and that JSON carries `status_msg`
// ("Accepted" / "Wrong Answer" / …) plus the submission id. Reading it is
// exact, needs no submit-intent heuristic, and cannot be confused by history.

(function () {
  // Loaded by the manifest at document_start in the page's own world, so the
  // fetch/XHR hooks are in place before LeetCode's code keeps references to
  // them. The content script's <script>-tag injection is only a fallback; run
  // once either way.
  if (window.__lcankiInjected) return;
  window.__lcankiInjected = true;
  document.documentElement?.setAttribute('data-lcanki-inject', '1');
  const TAG = 'LCANKI_CODE';

  function getCurrentEditor() {
    const monaco = window.monaco;
    if (!monaco?.editor) return null;
    const models = monaco.editor.getModels?.() ?? [];
    if (!models.length) return null;
    let best = models[0];
    for (const m of models) {
      if ((m.getValueLength?.() ?? 0) > (best.getValueLength?.() ?? 0)) best = m;
    }
    return best;
  }

  function readCode() {
    const m = getCurrentEditor();
    if (!m) return { ok: false, reason: 'no-monaco-model' };
    return { ok: true, code: m.getValue(), language: m.getLanguageId?.() || 'plaintext' };
  }

  let codingStarted = false;
  let monacoDisposable = null;

  function fireCodingStarted() {
    if (codingStarted) return;
    codingStarted = true;
    window.postMessage({ tag: TAG, kind: 'coding-started' }, '*');
    monacoDisposable?.dispose?.();
    monacoDisposable = null;
    document.removeEventListener('keydown', onKeyDown, true);
  }

  function resetCodingStarted() {
    codingStarted = false;
    monacoDisposable?.dispose?.();
    monacoDisposable = null;
    document.addEventListener('keydown', onKeyDown, true);
    attachMonacoListener();
  }

  // Primary signal: Monaco's onDidChangeContent. Most reliable — fires on
  // any edit, regardless of input source. Re-attaches on SPA nav via reset.
  function attachMonacoListener(retries = 30) {
    if (codingStarted) return;
    const m = getCurrentEditor();
    if (!m) {
      if (retries > 0) setTimeout(() => attachMonacoListener(retries - 1), 400);
      return;
    }
    const initial = m.getValue();
    monacoDisposable = m.onDidChangeContent(() => {
      if (m.getValue() !== initial) fireCodingStarted();
    });
  }

  // Fallback signal: keydown anywhere inside .monaco-editor.
  // Listener is detached once coding starts (see fireCodingStarted).
  function onKeyDown(e) {
    if (codingStarted) return;
    const t = e.target;
    if (!t || !t.closest) return;
    if (!t.closest('.monaco-editor')) return;
    fireCodingStarted();
  }
  document.addEventListener('keydown', onKeyDown, true);

  function clearEditor() {
    const m = getCurrentEditor();
    if (!m) return false;
    try { m.setValue(''); return true; } catch { return false; }
  }

  // ---------- authoritative submission verdicts ----------
  //
  // Submit flow on LeetCode:
  //   POST /problems/<slug>/submit/          -> { submission_id: 1234567 }
  //   GET  /submissions/detail/1234567/check/ (polled until state=SUCCESS)
  //
  // "Run" (test against the sample cases only) is a DIFFERENT flow:
  //   POST /problems/<slug>/interpret_solution/ -> { interpret_id: "runcode_…" }
  //   GET  /submissions/detail/runcode_…/check/
  // Its result also says "Accepted" when the samples pass, which is how a Run
  // used to get recorded as a full pass. Three independent guards keep it out:
  //   1. the check URL id must be all digits (run ids are "runcode_…");
  //   2. task_name must not be the RunCode task;
  //   3. run responses carry `code_answer`, submit responses never do.
  const CHECK_RE  = /\/submissions\/detail\/(\d+)\/check\/?(?:\?|$)/;
  const SUBMIT_RE = /\/problems\/([^/?#]+)\/submit\/?(?:\?|$)/;

  // submission id -> slug, captured from the submit request itself. The verdict
  // can land after you've already navigated to the next problem; tagging it
  // with the slug that SUBMITTED it (not whatever page is open when it lands)
  // is what stops problem A's result being filed under problem B, or the
  // reverse.
  const submitSlugById = new Map();
  const seenSubmissionIds = new Set();

  function isRunResult(json) {
    if (/runcode/i.test(String(json.task_name || ''))) return true;
    if (json.code_answer !== undefined) return true;
    if (/^runcode/i.test(String(json.submission_id ?? ''))) return true;
    return false;
  }

  function noteSubmit(slug, json) {
    try {
      const id = json && (json.submission_id ?? json.submissionId);
      if (id != null && slug) submitSlugById.set(String(id), decodeURIComponent(slug));
    } catch (e) {}
  }

  function reportVerdict(json, urlId) {
    try {
      if (!json || typeof json !== 'object') return;
      // Only final states carry a verdict; PENDING/STARTED mean still judging.
      if (json.state && json.state !== 'SUCCESS') return;
      if (isRunResult(json)) return;
      const status = json.status_msg || json.statusMsg;
      if (!status) return;

      const id = String(json.submission_id ?? json.submissionId ?? urlId ?? '');
      if (!/^\d+$/.test(id)) return;
      // The page polls the same URL repeatedly; only the first final
      // response for a given submission id is an event.
      if (seenSubmissionIds.has(id)) return;
      seenSubmissionIds.add(id);

      window.postMessage({
        tag: TAG,
        kind: 'submission',
        source: 'network',
        submissionId: id,
        slug: submitSlugById.get(id) || null,
        status,
        statusCode: json.status_code ?? null,
        runtime: json.status_runtime || json.runtime || null,
        memory: json.status_memory || null,
        totalCorrect: json.total_correct ?? null,
        totalTestcases: json.total_testcases ?? null,
        lang: json.pretty_lang || json.lang || null,
        questionId: json.question_id ?? null,
      }, '*');
    } catch (e) {
      /* never let our observation break the page */
    }
  }

  function routeResponse(url, json) {
    const c = url.match(CHECK_RE);
    if (c) { reportVerdict(json, c[1]); return; }
    const sm = url.match(SUBMIT_RE);
    if (sm) noteSubmit(sm[1], json);
  }
  function interesting(url) {
    return CHECK_RE.test(url) || SUBMIT_RE.test(url);
  }

  // --- fetch ---
  // Read-only: we clone the response so the page's own consumption of the
  // body is untouched, and we always hand back the original promise.
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const p = origFetch.apply(this, args);
      try {
        const input = args[0];
        const url = String(typeof input === 'string' ? input : (input && input.url) || '');
        if (interesting(url)) {
          p.then((res) => {
            try { res.clone().json().then((j) => routeResponse(url, j)).catch(() => {}); } catch (e) {}
          }).catch(() => {});
        }
      } catch (e) {}
      return p;
    };
  }

  // --- XMLHttpRequest ---
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype) {
    const origOpen = XHR.prototype.open;
    const origSend = XHR.prototype.send;
    XHR.prototype.open = function (method, url, ...rest) {
      try {
        const u = String(url || '');
        if (interesting(u)) this.__lcankiUrl = u;
      } catch (e) {}
      return origOpen.call(this, method, url, ...rest);
    };
    XHR.prototype.send = function (...args) {
      try {
        if (this.__lcankiUrl) {
          const u = this.__lcankiUrl;
          this.addEventListener('load', () => {
            try {
              const body = (this.responseType === '' || this.responseType === 'text')
                ? this.responseText
                : (this.response && typeof this.response === 'object' ? this.response : null);
              const j = typeof body === 'string' ? JSON.parse(body) : body;
              routeResponse(u, j);
            } catch (e) {}
          });
        }
      } catch (e) {}
      return origSend.apply(this, args);
    };
  }

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.tag !== TAG) return;
    if (msg.kind === 'request') {
      const result = readCode();
      window.postMessage({ tag: TAG, kind: 'response', requestId: msg.requestId, ...result }, '*');
    } else if (msg.kind === 'reset') {
      resetCodingStarted();
    } else if (msg.kind === 'clear-editor') {
      clearEditor();
    }
  });

  attachMonacoListener();
})();
