// Run with:  node tests/phases.test.js
// Prep phases (lib/phases.js): which window a solve falls in, by LOCAL day.
import assert from 'node:assert/strict';
import { validatePhases, normalizePhases, phaseFor, phaseSummary, UNSTRUCTURED } from '../extension/lib/phases.js';

const tests = [];
const test = (name, fn) => tests.push({ name, fn });
const at = (y, m, d, h = 12, min = 0) => new Date(y, m - 1, d, h, min).getTime();
const P = validatePhases([
  { name: 'Spring push', from: '2026-03-02', to: '2026-04-17' },
  { name: 'Fall push', from: '2026-08-24' },
]).phases;

test('ends are inclusive, by local day', () => {
  assert.equal(phaseFor(P, at(2026, 3, 2, 0, 5)), 'spring-push');
  assert.equal(phaseFor(P, at(2026, 4, 17, 23, 55)), 'spring-push');
  assert.equal(phaseFor(P, at(2026, 4, 18, 0, 5)), UNSTRUCTURED.id);
  assert.equal(phaseFor(P, at(2026, 3, 1, 23, 55)), UNSTRUCTURED.id);
});

test('an open-ended phase runs to today; undated solves are Unstructured', () => {
  assert.equal(phaseFor(P, at(2026, 11, 7)), 'fall-push');
  assert.equal(phaseFor(P, 0, true), UNSTRUCTURED.id);
  assert.equal(phaseFor(P, NaN), UNSTRUCTURED.id);
  assert.equal(phaseFor([], at(2026, 3, 20)), UNSTRUCTURED.id);
});

test('overlapping windows: the one that started later wins', () => {
  const ov = validatePhases([{ name: 'Long', from: '2026-01-01', to: '2026-12-31' }, { name: 'Sprint', from: '2026-06-01', to: '2026-06-14' }]).phases;
  assert.equal(phaseFor(ov, at(2026, 6, 5)), 'sprint');
  assert.equal(phaseFor(ov, at(2026, 6, 20)), 'long');
});

test('validation: names, dates and order are checked; blank rows ignored; ids unique', () => {
  assert.equal(validatePhases([{ name: '', from: '2026-01-01' }]).ok, false);
  assert.equal(validatePhases([{ name: 'A' }]).ok, false);
  assert.equal(validatePhases([{ name: 'A', from: '2026-02-01', to: '2026-01-01' }]).ok, false);
  assert.equal(validatePhases([{ name: 'Unstructured', from: '2026-02-01' }]).ok, false);
  const r = validatePhases([{ name: 'A b', from: '2026-03-01' }, {}, { name: 'A b', from: '2026-01-01', to: '' }]);
  assert.ok(r.ok);
  assert.deepEqual(r.phases.map(p => [p.id, p.from, p.to]), [['a-b-2', '2026-01-01', null], ['a-b', '2026-03-01', null]]);
});

test('stored lists tolerate junk, and summaries put Unstructured last only when used', () => {
  const kept = normalizePhases([{ id: 'x', name: 'Keep', from: '2026-01-01' }, { name: 'bad', from: 'soon' }, null, 'str']);
  assert.deepEqual(kept, [{ id: 'x', name: 'Keep', from: '2026-01-01', to: null }]);
  assert.deepEqual(normalizePhases(undefined), []);
  const sum = phaseSummary(P, [{ phase: 'fall-push' }, { phase: 'fall-push' }, { phase: 'unstructured' }]);
  assert.deepEqual(sum.map(p => [p.id, p.count]), [['spring-push', 0], ['fall-push', 2], ['unstructured', 1]]);
  assert.equal(phaseSummary(P, [{ phase: 'fall-push' }]).length, 2);
});

let failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failed++; console.log(`  FAIL ${name}\n       ${e.message.split('\n').join('\n       ')}`); }
}
console.log(`\n${tests.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
