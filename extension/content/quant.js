// Quant-drills bridge (content script).
//
// The quant-drills static site posts window messages tagged 'QUANTDRILLS'. We
// relay graded cards to the background service worker (which commits them to the
// tracker repo under quant/<id>/...), and answer 'ping' so the page can show a
// "connected" status.
//
// SECURITY: MV3 match patterns ignore ports, so this script is injected on EVERY
// localhost/127.0.0.1 page (any dev server). We therefore (a) only act on a
// hard-coded allow-list of trusted origins, and (b) validate card.id so a
// crafted id can't escape the quant/ prefix. The background re-checks both.
// If you serve the quant site on a different port, update QUANT_ORIGINS here
// (and the matching list in background.js).
(function () {
  'use strict';
  var TAG = 'QUANTDRILLS';
  var ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
  // Same-window only; '*' works on file:// (opaque origin) where a targeted
  // postMessage throws. ev.source===window already proves it came from this page.
  var RESP = '*';

  // chrome.runtime is gone once this content script is orphaned by an extension
  // reload; accessing it then throws "reading 'sendMessage' of undefined".
  function alive() { try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; } }

  // Trusted origins only. localhost is pinned to the dev-server port because the
  // manifest match can't be (match patterns are port-agnostic). file:// is the
  // user opening the static site directly off disk.
  function trustedOrigin() {
    if (location.protocol === 'file:') return true;
    var o = location.origin, p = location.pathname || '';
    if (o === 'http://localhost:8765' || o === 'http://127.0.0.1:8765') return true;
    if (o === 'https://cmbenello.github.io' && p.indexOf('/quant') === 0) return true;
    return false;
  }

  if (!trustedOrigin()) return;   // inert on every other (localhost/file) page

  window.addEventListener('message', function (ev) {
    if (ev.source !== window) return;                 // same-window only
    if (location.protocol !== 'file:' && ev.origin !== location.origin) return;   // belt-and-suspenders (file:// origin is opaque)
    var m = ev.data;
    if (!m || m.tag !== TAG) return;

    // After an extension reload, content scripts already running in open tabs are
    // ORPHANED — chrome.runtime is gone and every sendMessage throws. Detect that
    // and tell the page to reload instead of failing with a cryptic error. We also
    // stop answering ping, so the page shows "not detected" (a reload cue).
    if (!alive()) {
      if (m.kind === 'grade' || m.kind === 'grade-batch') {
        var oids = (m.kind === 'grade-batch' && Array.isArray(m.cards))
          ? m.cards.map(function (c) { return c && c.id; }).filter(Boolean)
          : [(m.card && m.card.id) || null];
        window.postMessage({ tag: TAG, kind: 'ack', ids: oids, ok: false, error: 'extension was updated — reload this page (⌘R)' }, RESP);
      }
      return;
    }

    if (m.kind === 'ping') {
      window.postMessage({ tag: TAG, kind: 'pong' }, RESP);
      return;
    }

    if (m.kind === 'list-req') {   // distinct from the 'list-res' we post back, so we don't re-trigger ourselves
      try {
        chrome.runtime.sendMessage({ kind: 'quant-list' }, function (resp) {
          window.postMessage({ tag: TAG, kind: 'list-res', ids: (resp && resp.ids) || [] }, RESP);
        });
      } catch (e) { window.postMessage({ tag: TAG, kind: 'list-res', ids: [] }, RESP); }
      return;
    }

    if (m.kind === 'grade-batch' && Array.isArray(m.cards)) {
      var valid = m.cards.filter(function (c) { return c && ID_RE.test(c.id); });
      var ids = valid.map(function (c) { return c.id; });
      try {
        chrome.runtime.sendMessage({ kind: 'quant-grade-batch', cards: valid }, function (resp) {
          var lastErr = chrome.runtime.lastError;
          window.postMessage({
            tag: TAG, kind: 'ack', ids: (resp && resp.syncedIds) || ids,
            ok: !!(resp && resp.ok), error: lastErr ? lastErr.message : (resp && resp.error)
          }, RESP);
        });
      } catch (e) {
        window.postMessage({ tag: TAG, kind: 'ack', ids: ids, ok: false, error: String(e && e.message || e) }, RESP);
      }
      return;
    }

    if (m.kind === 'grade' && m.card && ID_RE.test(m.card.id)) {
      try {
        chrome.runtime.sendMessage({ kind: 'quant-grade', card: m.card }, function (resp) {
          var lastErr = chrome.runtime.lastError;       // e.g. extension reloaded mid-flight
          window.postMessage({
            tag: TAG, kind: 'ack', id: m.card.id,
            ok: !!(resp && resp.ok),
            error: lastErr ? lastErr.message : (resp && resp.error)
          }, RESP);
        });
      } catch (e) {
        window.postMessage({ tag: TAG, kind: 'ack', id: m.card.id, ok: false, error: String(e && e.message || e) }, RESP);
      }
    } else if (m.kind === 'grade') {
      window.postMessage({ tag: TAG, kind: 'ack', id: (m.card && m.card.id) || null, ok: false, error: 'invalid card id' }, RESP);
    }
  });

  // Announce ourselves on load. Content scripts inject at document_idle — AFTER
  // the page's own scripts run and fire their initial ping — so that ping is
  // missed and the page would sit disconnected until the user clicks the pill.
  // Posting a pong here lets the page connect (and auto-backfill) on its own.
  window.postMessage({ tag: TAG, kind: 'pong' }, RESP);
})();
