// Runs in <head>, before anything else on the new tab.
// The page has one look (Glass): set it before first paint so there's no
// flash of the default tokens.
document.documentElement.dataset.theme = 'glass';
// Start reading the graph's cached view now (the background keeps it current
// in storage), so it's ready the moment newtab.js runs.
window.__lcankiHome = chrome.storage.local.get('homeCache').then(r => r.homeCache || null, () => null);
