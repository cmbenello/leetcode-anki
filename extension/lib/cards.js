// Card-record normalisation, applied at the storage boundary (getCards).
//
// Everything that reads cards assumed well-formed records. One odd record —
// a null left by an old version or a JSON import, `submissions` stored as an
// object, a timestamp under `at` instead of `t` — threw inside the goals,
// ranking and due-list requests, and the new-tab page froze on "0" and
// "Thinking…". Reads now normalise in memory; migration v3 writes it back.

const slugTitle = (slug) => String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

function stamp(x) {
  const v = Number(x?.t ?? x?.at);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Normalise in place. Returns how many fixes were made. Pure (no chrome.*). */
export function sanitizeCards(cards, now = Date.now()) {
  let fixed = 0;
  if (!cards || typeof cards !== 'object') return 0;
  for (const [key, c] of Object.entries(cards)) {
    if (!c || typeof c !== 'object' || Array.isArray(c)) { delete cards[key]; fixed += 1; continue; }
    if (c.slug !== key) { c.slug = key; fixed += 1; }
    for (const field of ['history', 'submissions']) {
      if (c[field] == null) {
        if (field === 'history') { c.history = []; fixed += 1; }
        continue;
      }
      if (!Array.isArray(c[field])) { c[field] = []; fixed += 1; continue; }
      const before = c[field].length;
      c[field] = c[field].filter(x => x && typeof x === 'object' && stamp(x) != null);
      if (c[field].length !== before) fixed += 1;
      for (const x of c[field]) {
        const t = stamp(x);
        if (x.t !== t) { x.t = t; fixed += 1; }
      }
    }
    if (!Number.isFinite(c.due)) { c.due = now; fixed += 1; }
    if (typeof c.title !== 'string' || !c.title.trim()) { c.title = slugTitle(key); fixed += 1; }
    for (const k of ['reps', 'lapses', 'intervalMin']) {
      if (c[k] != null && !Number.isFinite(c[k])) { c[k] = 0; fixed += 1; }
    }
  }
  return fixed;
}
