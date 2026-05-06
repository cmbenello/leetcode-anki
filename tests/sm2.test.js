// Run with:  node tests/sm2.test.js
import {
  newCard, grade, isDue, QUALITY,
  DEFAULT_INTERVALS_MIN, DEFAULT_GROWTH,
  formatDuration, parseDuration,
} from '../extension/lib/sm2.js';
import assert from 'node:assert/strict';

const tests = [];
function test(name, fn) { tests.push({ name, fn }); }

test('new card is due immediately', () => {
  const c = newCard('two-sum', 'Two Sum');
  assert.equal(c.reps, 0);
  assert.equal(c.intervalMin, 0);
  assert.ok(isDue(c));
});

test('first Good uses default base interval (3 days)', () => {
  const c = newCard('two-sum');
  const { card, nextIntervalMin } = grade(c, QUALITY.GOOD);
  assert.equal(nextIntervalMin, DEFAULT_INTERVALS_MIN.good);
  assert.equal(card.reps, 1);
});

test('first Again uses 30 min default', () => {
  const c = newCard('two-sum');
  const { card } = grade(c, QUALITY.AGAIN);
  assert.equal(card.intervalMin, 30);
  assert.equal(card.lapses, 1);
  assert.equal(card.reps, 0);
});

test('first Easy uses 10 day default', () => {
  const c = newCard('two-sum');
  const { card } = grade(c, QUALITY.EASY);
  assert.equal(card.intervalMin, DEFAULT_INTERVALS_MIN.easy);
});

test('subsequent Good multiplies by growth (3d -> ~7.5d)', () => {
  let c = newCard('two-sum');
  ({ card: c } = grade(c, QUALITY.GOOD));
  ({ card: c } = grade(c, QUALITY.GOOD));
  // 4320 * 2.5 = 10800 (~7.5 days)
  assert.equal(c.intervalMin, Math.round(4320 * DEFAULT_GROWTH.good));
});

test('subsequent grade never falls below the configured base', () => {
  let c = newCard('two-sum');
  // First Hard: 1d. growth 1.2 -> 1.2d. But base.hard is 1d so should stay >= 1d.
  ({ card: c } = grade(c, QUALITY.HARD));
  ({ card: c } = grade(c, QUALITY.HARD));
  assert.ok(c.intervalMin >= DEFAULT_INTERVALS_MIN.hard);
});

test('Again resets reps and uses Again base', () => {
  let c = newCard('two-sum');
  ({ card: c } = grade(c, QUALITY.GOOD));
  ({ card: c } = grade(c, QUALITY.GOOD));
  ({ card: c } = grade(c, QUALITY.AGAIN));
  assert.equal(c.reps, 0);
  assert.equal(c.intervalMin, DEFAULT_INTERVALS_MIN.again);
  assert.equal(c.lapses, 1);
});

test('settings override the defaults', () => {
  const c = newCard('two-sum');
  const settings = {
    intervals: { again: 5, hard: 30, good: 120, easy: 360 },
    growth:    { again: 1, hard: 1.5, good: 2, easy: 3 },
  };
  const { card } = grade(c, QUALITY.GOOD, settings);
  assert.equal(card.intervalMin, 120);
});

test('grade does not mutate input card', () => {
  const c = newCard('two-sum');
  const before = JSON.stringify(c);
  grade(c, QUALITY.GOOD);
  assert.equal(JSON.stringify(c), before);
});

test('button-id and quality-number both work', () => {
  const c1 = newCard('two-sum');
  const c2 = newCard('two-sum');
  const a = grade(c1, QUALITY.GOOD);
  const b = grade(c2, 'good');
  assert.equal(a.nextIntervalMin, b.nextIntervalMin);
});

test('formatDuration handles minutes/hours/days', () => {
  assert.equal(formatDuration(30), '30m');
  assert.equal(formatDuration(60), '1h');
  assert.equal(formatDuration(90), '1.5h');
  assert.equal(formatDuration(1440), '1d');
  assert.equal(formatDuration(4320), '3d');
});

test('parseDuration parses "30m", "1d", "1d12h", "90"', () => {
  assert.equal(parseDuration('30m'), 30);
  assert.equal(parseDuration('1d'), 1440);
  assert.equal(parseDuration('1d12h'), 1440 + 720);
  assert.equal(parseDuration('90'), 90);
  assert.equal(parseDuration('  2h  '), 120);
});

let passed = 0, failed = 0;
for (const { name, fn } of tests) {
  try { fn(); console.log('  ok  ', name); passed++; }
  catch (e) { console.log('  FAIL', name, '\n      ', e.message); failed++; }
}
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
