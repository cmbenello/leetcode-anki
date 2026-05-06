// Runs in PAGE context (not the content-script isolated world).
// Two responsibilities:
//   1. On request, read code from the Monaco editor and post it back.
//   2. Detect "user has started coding" — first keydown inside the Monaco
//      editor — and post a one-shot message so the content script can split
//      time into reading vs coding.

(function () {
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

  window.addEventListener('message', (ev) => {
    if (ev.source !== window) return;
    const msg = ev.data;
    if (!msg || msg.tag !== TAG) return;
    if (msg.kind === 'request') {
      const result = readCode();
      window.postMessage({ tag: TAG, kind: 'response', requestId: msg.requestId, ...result }, '*');
    } else if (msg.kind === 'reset') {
      resetCodingStarted();
    }
  });

  attachMonacoListener();
})();
