// Prep phases: named date windows ("Company A 2026", "Company B 2027") that
// group problems by the day you first solved them. A problem outside every
// window, or with no date at all (NeetCode keeps none), is "Unstructured".
// Pure, so tests can pin it down.

import { dayKeyMs } from './dates.js';

export const UNSTRUCTURED = Object.freeze({ id: 'unstructured', name: 'Unstructured', from: null, to: null });

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'phase';

/**
 * Check and tidy a phase list as typed: every phase needs a name and a start
 * day (local YYYY-MM-DD); an empty end means "still going". Returns
 * { ok, phases } sorted by start, or { ok: false, error } naming the row.
 */
export function validatePhases(list) {
  const out = [];
  const ids = new Set([UNSTRUCTURED.id]);
  for (const [i, p] of (Array.isArray(list) ? list : []).entries()) {
    const name = String(p?.name ?? '').trim().slice(0, 40);
    const from = String(p?.from ?? '').trim();
    const to = String(p?.to ?? '').trim();
    const row = name ? `“${name}”` : `row ${i + 1}`;
    if (!name && !from && !to) continue;                    // a blank row: ignore it
    if (!name) return { ok: false, error: `${row} needs a name` };
    if (!DAY_RE.test(from)) return { ok: false, error: `${row} needs a start date` };
    if (to && !DAY_RE.test(to)) return { ok: false, error: `${row} has a bad end date` };
    if (to && to < from) return { ok: false, error: `${row} ends before it starts` };
    if (name.toLowerCase() === UNSTRUCTURED.name.toLowerCase()) return { ok: false, error: '“Unstructured” is what everything outside a phase is called' };
    let id = slugify(String(p.id || name));
    for (let n = 2; ids.has(id); n++) id = `${slugify(name)}-${n}`;
    ids.add(id);
    out.push({ id, name, from, to: to || null });
  }
  out.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
  return { ok: true, phases: out };
}

/** Stored phases, tolerating anything malformed (drops bad rows instead of failing). */
export function normalizePhases(list) {
  const kept = [];
  for (const p of Array.isArray(list) ? list : []) {
    const r = validatePhases([p]);
    if (r.ok && r.phases.length) kept.push({ ...r.phases[0], id: p.id || r.phases[0].id });
  }
  return validatePhases(kept).phases;
}

/**
 * The phase a problem belongs to, by the LOCAL day of its first solve.
 * Ends are inclusive. Where windows overlap, the one that started later wins:
 * it's the more specific push.
 */
export function phaseFor(phases, t, undated = false) {
  if (undated || !Number.isFinite(t) || t <= 0) return UNSTRUCTURED.id;
  const day = dayKeyMs(t);
  let hit = null;
  for (const p of phases) {
    if (day >= p.from && (!p.to || day <= p.to) && (!hit || p.from >= hit.from)) hit = p;
  }
  return hit ? hit.id : UNSTRUCTURED.id;
}

/**
 * Phases with how many of `problems` (each with a `phase` id) fall in each,
 * in date order. Unstructured comes last, and only when something is in it.
 */
export function phaseSummary(phases, problems) {
  const counts = {};
  for (const p of problems) counts[p.phase] = (counts[p.phase] || 0) + 1;
  const out = phases.map(p => ({ ...p, count: counts[p.id] || 0 }));
  if (counts[UNSTRUCTURED.id]) out.push({ ...UNSTRUCTURED, count: counts[UNSTRUCTURED.id] });
  return out;
}
