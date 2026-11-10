// How strong you are in each topic and subtopic, from the predictor.
//
// Strength = the chance you'd solve a typical Medium there: the predictor's
// pBase (lib/model.js) averaged over the catalog's free Medium problems in
// that topic (a bucket with fewer than MIN_MEDIUMS Mediums averages over all
// its problems). It uses the model's own Elo, with two changes:
//
//   * each attempt counts toward its topic (or subtopic) alone rather than
//     its LeetCode tags: tags like "array" and "dynamic-programming" are
//     shared across topics, and per-tag ability blurred a topic you keep
//     failing into its neighbours (a simulated weak topic came out 69%
//     against 70–78% elsewhere; per topic, 47–74% against 77–87%);
//   * a solve earns credit for how CLEANLY it went (cleanScore): full on the
//     first try, less for each wrong submission before Accepted, less if it
//     felt hard or took hints. When every Accepted is a full win, Elo just
//     climbs with every solve and strength becomes a count: 40 solves that
//     each needed retries beat 10 first-try solves (90% vs 84%). With credit,
//     ability settles where your expected score matches how cleanly you
//     solve: 80% vs 83%, while 40 clean solves still come out on top (88%).
// `n` is how many problems there you've attempted; under CONFIDENT_N the
// number is mostly the prior, and the graph shows it as a rough guess.
// Pure: tested in tests/strength.test.js.

import { replay, pBase, perceivedScore } from './model.js';

export const MIN_MEDIUMS = 3;
export const CONFIDENT_N = 3;
// credit for an Accepted after 0, 1, 2, 3+ wrong submissions
export const FAIL_CREDIT = Object.freeze([1, 0.8, 0.65, 0.5]);
export const HINT_CREDIT = 0.85;

/** How cleanly an attempt went, in [0, 1]: the lower of tries and felt difficulty, less for hints. */
export function cleanScore(a) {
  if (!a.correct) return 0;
  const tries = FAIL_CREDIT[Math.min(Math.max(0, a.fails ?? 0), FAIL_CREDIT.length - 1)];
  const felt = a.perceived != null ? perceivedScore(a.perceived) : 1;
  return Math.min(tries, felt) * (a.hints ? HINT_CREDIT : 1);
}

/**
 * attempts: the model's attempts [{ slug, ts, correct, tags, fails?, perceived?, hints? }]
 * items:    { [slug]: { acRate, difficulty } } for difficulty priors
 * rows:     catalog items [{ slug, tags, difficulty, paid }]
 * topicOf(x) → topic key, subOf(topic, x) → subtopic key (x has slug + tags)
 * → { topics: { [topic]: { p, n, sure } }, subs: { [topic]: { [sub]: { p, n, sure } } } }
 */
export function topicStrength({ attempts = [], items = {}, rows, topicOf, subOf }) {
  const keysOf = (x) => { const t = topicOf(x); return [t, `${t}/${subOf(t, x)}`]; };
  const scored = attempts.map(a => ({ ...a, score: cleanScore(a) }));
  const byTopic = replay(scored.map(a => ({ ...a, tags: [keysOf(a)[0]] })), items);
  const bySub = replay(scored.map(a => ({ ...a, tags: [keysOf(a)[1]] })), items);

  const acc = new Map();
  const add = (key, p, medium) => {
    let a = acc.get(key);
    if (!a) acc.set(key, a = { sm: 0, nm: 0, sa: 0, na: 0 });
    a.sa += p; a.na += 1;
    if (medium) { a.sm += p; a.nm += 1; }
  };
  for (const r of rows) {
    if (r.paid) continue;
    const [t, ts] = keysOf(r);
    const med = r.difficulty === 'Medium';
    add(t, pBase(byTopic, r.slug, [t]), med);
    add(ts, pBase(bySub, r.slug, [ts]), med);
  }

  const tried = new Map(), seen = new Set();
  for (const a of attempts) {
    if (seen.has(a.slug)) continue;
    seen.add(a.slug);
    for (const key of keysOf(a)) tried.set(key, (tried.get(key) || 0) + 1);
  }

  const out = { topics: {}, subs: {} };
  for (const [key, a] of acc) {
    const p = a.nm >= MIN_MEDIUMS ? a.sm / a.nm : a.sa / a.na;
    const n = tried.get(key) || 0;
    const v = { p: Math.round(p * 1000) / 1000, n, sure: n >= CONFIDENT_N };
    const slash = key.indexOf('/');
    if (slash < 0) out.topics[key] = v;
    else (out.subs[key.slice(0, slash)] ||= {})[key.slice(slash + 1)] = v;
  }
  return out;
}
