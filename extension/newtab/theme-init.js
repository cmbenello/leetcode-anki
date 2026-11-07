// Applied synchronously in <head> so the page paints in the right theme on
// the first frame (chrome.storage is async; localStorage isn't). newtab.js
// keeps this in sync with the saved setting.
try {
  document.documentElement.dataset.theme = localStorage.getItem('lcanki-theme') || 'glass';
} catch (e) { /* storage blocked: default theme */ }
