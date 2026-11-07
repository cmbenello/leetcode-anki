// Learner model + "what next" recommender, ported from Drill
// (~/Coding/embed, src/embed/engine.py). Every constant below comes from a
// measured result there (experiments/results/NOTES.md); the experiment ids are
// kept next to each one so the provenance survives the port.
//
// What carries over unchanged:
//   * 1-D Elo ability, per topic + global, mixed 0.7/0.3 in the prediction
//   * update schedule K = 320 / (1 + n/3), item difficulty nudged 8 pts/surprise
//   * recall bonus on re-attempts (E26), applied to the PREDICTION ONLY — a
//     repeat is predicted higher but moves ability exactly like a first try (E17c)
//   * retry timing: a failed problem waits a day; its near variants wait an hour
//     and are then preferred for a week, but only if likely to be solved (E24, E18)
//   * selection: Thompson-sample topic abilities, favour the weakest, aim at
//     p ≈ 0.75, and always show the prediction with the evidence behind it
//
// What changes for LeetCode, and why:
//   * NO recent-history correction term. Drill's runs on technique-text
//     embeddings with weights fit on Codeforces (E9); we have no embeddings for
//     LeetCode problems, and faking the features would make the number lie.
//   * "Near" = LeetCode's curated Similar Questions list. Drill found technique
//     similarity predicts and statement similarity barely does (E1: R² 0.53 vs
//     0.23); LC's list is human-curated by technique, so it's the closest proxy.
//     Topic-tag overlap is kept as a WEAK similarity, capped below NEAR, so tags
//     alone never make something a "variant".
//   * Item difficulty cold-starts from LeetCode's global acceptance rate and
//     difficulty label. Drill learns difficulty from many users' responses; with
//     one user we need a prior, then let your own attempts move it slowly.
//   * Solved problems are left to the spaced-repetition queue; the recommender
//     picks NEW problems and retries of ones you missed.

export const THETA0 = 1200;
export const GLOBAL = '*';
export const TARGET_P = 0.75;
export const NEAR = 0.75;
export const REPEAT_COOLDOWN_S = 86400;          // failed item itself waits a day (E11/E12)
export const VARIANT_COOLDOWN_S = 3600;          // no near variant within the hour of a fail
export const VARIANT_WINDOW_S = 7 * 86400;       // ...then preferred for a week (E16/E18)
export const ITEM_STEP = 8;

// E26 (178,705 re-attempts): after a pass +13 pts within the hour, +10 within a
// day, +5 within a week, +1 within a month; after a fail +20 within the hour,
// +10 within the day, nothing after. In logits near p ≈ 0.7.
export const RECALL_TABLE = {
  1: [[86400, 0.7], [7 * 86400, 0.35], [30 * 86400, 0.1]],
  0: [[3600, 1.2], [86400, 0.6]],
};

export function recallBonus(prevCorrect, gapSeconds) {
  for (const [limit, bonus] of RECALL_TABLE[prevCorrect ? 1 : 0]) {
    if (gapSeconds <= limit) return bonus;
  }
  return 0;
}

export const eloP = (theta, beta) => 1 / (1 + 10 ** ((beta - theta) / 400));
const logit = (p) => { const q = Math.min(Math.max(p, 1e-6), 1 - 1e-6); return Math.log(q / (1 - q)); };
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const DIFF_OFFSET = { Easy: -150, Medium: 0, Hard: 200 };

/**
 * Cold-start difficulty. An "average grinder" (θ = 1200) gets roughly:
 * Easy ~75%, Medium ~45-50%, Hard ~15-20% — then your attempts take over.
 */
export function priorBeta(item) {
  const a = Math.min(0.9, Math.max(0.1, (item?.acRate ?? 50) / 100));
  return THETA0 + 240 * Math.log10((1 - a) / a) + (DIFF_OFFSET[item?.difficulty] ?? 0);
}

function conceptsOf(tags) {
  return tags && tags.length ? tags : ['untagged'];
}

/**
 * Replay attempts in time order into a learner state.
 * attempts: [{ slug, ts (ms), correct: 0|1, tags: [topic slugs] }]
 * items:    { [slug]: { acRate, difficulty } }  — for difficulty priors
 */
export function replay(attempts, items = {}) {
  const st = { theta: new Map(), beta: new Map(), last: new Map(), items };
  for (const a of [...attempts].sort((x, y) => x.ts - y.ts)) record(st, a);
  return st;
}

export function thetaOf(st, c) { return st.theta.get(c)?.theta ?? THETA0; }
export function nOf(st, c) { return st.theta.get(c)?.n ?? 0; }
export function sigmaOf(st, c) { return 350 / Math.sqrt(nOf(st, c) + 1); }
export function betaOf(st, slug) {
  const b = st.beta.get(slug);
  return b ? b.beta : priorBeta(st.items[slug]);
}

export function pBase(st, slug, tags) {
  const cs = conceptsOf(tags);
  const mean = cs.reduce((s, c) => s + thetaOf(st, c), 0) / cs.length;
  return eloP(0.7 * mean + 0.3 * thetaOf(st, GLOBAL), betaOf(st, slug));
}

/** Drill's record(): ability moves from p_base — never from the recall-boosted p. */
export function record(st, a) {
  const cs = conceptsOf(a.tags);
  const d = (a.correct ? 1 : 0) - pBase(st, a.slug, a.tags);
  for (const c of [...cs, GLOBAL]) {
    const n = nOf(st, c);
    // Large early steps so a short history moves the estimate; decays with evidence.
    const K = 320 / (1 + n / 3);
    const share = c === GLOBAL ? 0.3 : 0.7 / cs.length;
    st.theta.set(c, { theta: thetaOf(st, c) + K * share * d, n: n + 1 });
  }
  const b = st.beta.get(a.slug) ?? { beta: priorBeta(st.items[a.slug]), n: 0 };
  st.beta.set(a.slug, { beta: b.beta - ITEM_STEP * d, n: b.n + 1 });
  const prev = st.last.get(a.slug);
  st.last.set(a.slug, {
    ts: a.ts, correct: a.correct ? 1 : 0, n: (prev?.n ?? 0) + 1,
    solved: (prev?.solved ?? false) || !!a.correct,
  });
}

/** P(solve) and the parts that make it up — the number shown before you start. */
export function predict(st, item, now = Date.now()) {
  const p0 = pBase(st, item.slug, item.tags);
  const last = st.last.get(item.slug);
  const recall = last ? recallBonus(last.correct, (now - last.ts) / 1000) : 0;
  return { p: sigmoid(logit(p0) + recall), pBase: p0, recall, reattempt: !!last };
}

/**
 * Similarity in [0, 1]. 1.0 = LeetCode lists them as similar questions
 * (either direction). Otherwise 0.6 × tag Jaccard — strictly below NEAR.
 */
export function similarity(a, b) {
  if (!a || !b || a.slug === b.slug) return 0;
  if (a.similar?.includes(b.slug) || b.similar?.includes(a.slug)) return 1;
  const ta = new Set(a.tags || []), tb = b.tags || [];
  if (!ta.size || !tb.length) return 0;
  let inter = 0;
  for (const t of tb) if (ta.has(t)) inter += 1;
  const union = ta.size + tb.length - inter;
  return union ? 0.6 * (inter / union) : 0;
}

export function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function normal(rng, mu, sd) {
  const u = Math.max(rng(), 1e-12), v = rng();
  return mu + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Rank candidate problems. Drill's select(), adapted:
 *   1. Thompson-sample each topic's ability; the 3 lowest draws are "weak".
 *   2. Skip: solved problems (the SR queue owns those), a failed problem
 *      within a day, any near variant of something failed within the hour.
 *   3. Score = −(|p − 0.75| − bonus), bonus for weak topics (+0.10) and for a
 *      fresh near variant of a recent miss you're likely to pass (+0.15…).
 *   4. With a goal, on-goal candidates fill the list first.
 *
 * catalog: [{ slug, title, difficulty, acRate, paid, tags, similar? }]
 * known:   { [slug]: item with `similar` } — metadata for problems you've tried
 * goal:    { matches(item) -> bool, tags?: [] } | null
 */
export function recommend({ st, catalog, known = {}, now = Date.now(), rng = Math.random, goal = null, k = 5 }) {
  const concepts = new Set([...st.theta.keys()].filter(c => c !== GLOBAL));
  for (const t of goal?.tags || []) concepts.add(t);
  const pool = goal?.tags?.length ? [...concepts].filter(c => goal.tags.includes(c)) : [...concepts];
  const sampled = pool.map(c => [c, normal(rng, thetaOf(st, c), sigmaOf(st, c))]);
  const weak = new Set(sampled.sort((x, y) => x[1] - y[1]).slice(0, 3).map(x => x[0]));

  const failed = [...st.last.entries()].filter(([, s]) => !s.solved);
  const ageS = (s) => (now - s.ts) / 1000;
  const hot = failed.filter(([, s]) => ageS(s) < VARIANT_COOLDOWN_S).map(([slug]) => known[slug] || { slug });
  const due = failed
    .filter(([, s]) => ageS(s) >= VARIANT_COOLDOWN_S && ageS(s) < VARIANT_WINDOW_S)
    .map(([slug]) => known[slug] || { slug });

  const cands = [];
  for (const item of catalog) {
    if (item.paid) continue;
    const s = st.last.get(item.slug);
    if (s?.solved) continue;
    if (s && ageS(s) < REPEAT_COOLDOWN_S) continue;
    const full = known[item.slug] ? { ...item, ...known[item.slug] } : item;
    if (hot.some(h => similarity(full, h) >= NEAR)) continue;

    const pr = predict(st, full, now);
    let bonus = 0;
    const weakHit = (full.tags || []).filter(t => weak.has(t));
    if (weakHit.length) bonus += 0.10;

    let variantOf = null, simDue = 0;
    for (const d of due) {
      const sim = similarity(full, d);
      if (sim > simDue) { simDue = sim; variantOf = d; }
    }
    const variant = !s && simDue >= NEAR && pr.p >= 0.6;
    if (variant) bonus += 0.15 + 0.5 * (simDue - NEAR);

    const onGoal = goal ? !!goal.matches(full) : null;
    cands.push({ item: full, ...pr, score: -(Math.abs(pr.p - TARGET_P) - bonus), weakHit, variant, variantOf, onGoal, retry: !!s });
  }
  cands.sort((a, b) => b.score - a.score);
  // With a goal active, "next up" means next up FOR THAT GOAL: on-goal
  // candidates first, off-goal only to fill once those run out. (A soft score
  // bonus can't do this — an off-goal Easy at 77% beats an on-goal Hard at 18%.)
  const ordered = goal ? [...cands.filter(c => c.onGoal), ...cands.filter(c => !c.onGoal)] : cands;

  // Diversity: at most 2 picks per topic, where "topic" is the weak area a
  // pick is targeting if any (else its first tag). Keying on the first tag
  // alone let four DFS problems through because their FIRST tags differed.
  const out = [], perTopic = {};
  for (const c of ordered) {
    const t = c.weakHit[0] || c.item.tags?.[0] || 'untagged';
    if ((perTopic[t] || 0) >= 2) continue;
    perTopic[t] = (perTopic[t] || 0) + 1;
    out.push({ ...c, reason: reasonFor(c) });
    if (out.length >= k) break;
  }
  return out;
}

function reasonFor(c) {
  const pct = `${Math.round(c.p * 100)}%`;
  if (c.variant) return `a fresh variant of ${c.variantOf?.title || c.variantOf?.slug}, which you missed recently`;
  if (c.retry) return `another go at one you missed — enough time has passed`;
  if (c.weakHit.length) return `targets ${c.weakHit.slice(0, 2).map(humanTag).join(' & ')}, currently your weakest`;
  return `predicted ${pct} — right at your frontier`;
}

export const humanTag = (t) => String(t || '').replace(/-/g, ' ');

/** The attempted problems that most resemble `item` — evidence, not a score. */
export function evidenceFor(item, attempts, known, k = 3) {
  const seen = new Set();
  const rows = [];
  for (const a of [...attempts].sort((x, y) => y.ts - x.ts)) {
    if (a.slug === item.slug || seen.has(a.slug)) continue;
    seen.add(a.slug);
    const other = known[a.slug] || { slug: a.slug, tags: a.tags };
    const sim = similarity(item, other);
    if (sim > 0) rows.push({ slug: a.slug, title: other.title || a.slug, correct: !!a.correct, sim, ts: a.ts });
  }
  return rows.sort((x, y) => y.sim - x.sim).slice(0, k);
}

/** Per-topic ability, weakest first. `confident` once there are 3+ attempts. */
export function mastery(st) {
  return [...st.theta.entries()]
    .filter(([c]) => c !== GLOBAL)
    .map(([c, v]) => ({ concept: c, theta: v.theta, n: v.n, sigma: sigmaOf(st, c), confident: v.n >= 3 }))
    .sort((a, b) => a.theta - b.theta);
}

/** Were the predictions honest? Mean predicted vs actual over logged attempts. */
export function calibration(attempts) {
  const rows = attempts.filter(a => typeof a.pPred === 'number');
  if (rows.length < 5) return { n: rows.length };
  const predicted = rows.reduce((s, a) => s + a.pPred, 0) / rows.length;
  const actual = rows.reduce((s, a) => s + (a.correct ? 1 : 0), 0) / rows.length;
  return { n: rows.length, predicted, actual, gap: predicted - actual };
}
