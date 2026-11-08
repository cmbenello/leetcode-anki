// Goal growth: your solved problems as rings around the goal.
//
//   rings      difficulty: easy (inner), medium, hard (outer)
//   arcs       topics — fixed order, each arc sized by how many you've done
//   position   along a topic's arc, problems follow the "built on" tree
//              (depth-first leaf order, as in hierarchical edge bundling), so
//              a problem sits beside the one it built on — even across rings;
//              each ring then spreads its own dots so neighbours never touch
//   links      "built on" links bow inward inside their topic; links between
//              topics are bundled through the middle (Holten, "Hierarchical
//              Edge Bundles", 2006), kept faint
//   dots       colour = topic (brighter where you've done more); a touch
//              brighter if recent
//
//   phases     pick a prep phase below the graph to light up just the problems
//              first solved in it; the rest fade back but keep their places
//
// Zoom with a pinch or ⌘/Ctrl+scroll, drag to pan, double-click to zoom in;
// plain scrolling still scrolls the page. Geometry is built once per data
// change into batched Path2D objects; zoom/pan only change the transform.

import { TOPICS, primaryTopic, tagTopic } from '../lib/topics.js';

export { primaryTopic };
const TAU = Math.PI * 2;

// Circle order, labels and hues: NeetCode's roadmap (lib/topics.js).
const DISPLAY = TOPICS.map(t => t.key);
const LABEL = Object.fromEntries(TOPICS.map(t => [t.key, t.label]));
const topicLabel = (t) => LABEL[t] || String(t).replace(/-/g, ' ');
const TOPIC_HUE = Object.fromEntries(TOPICS.map(t => [t.key, t.hue]));
const hsla = (h, l, a) => `hsla(${h}, 42%, ${l}%, ${a.toFixed(3)})`;


// Neutral colours come from the page's theme tokens (newtab.css).
const TOKENS = {
  edge: ['--stem', 'rgba(206,210,217,0.4)'], hi: ['--stem-hi', 'rgba(206,210,217,0.95)'],
  ring: ['--ring', 'rgba(206,210,217,0.16)'], label: ['--label', 'rgba(206,210,217,0.5)'],
  bg: ['--bg', '#17181b'],
};
const TONES = ['old', 'mid', 'recent', 'today'];
let COLORS = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  COLORS = {};
  for (const [k, [v, fb]] of Object.entries(TOKENS)) COLORS[k] = cs.getPropertyValue(v).trim() || fb;
}
if (typeof document !== 'undefined') readColors();

/**
 * How related two problems are, and why. LeetCode's curated Similar
 * Questions beat everything; otherwise shared topic tags (Jaccard) plus a
 * bonus for the same NeetCode pattern ("Sliding Window", "1-D DP", …).
 */
export function relate(p, q) {
  if ((p.similar || []).includes(q.slug) || (q.similar || []).includes(p.slug)) return { score: 2, via: 'similar' };
  const a = new Set(p.tags || []);
  let inter = 0;
  for (const t of q.tags || []) if (a.has(t)) inter += 1;
  const union = a.size + (q.tags || []).length - inter;
  const j = union ? inter / union : 0;
  const samePattern = !!(p.pattern && p.pattern === q.pattern);
  return { score: j + (samePattern ? 0.35 : 0), via: samePattern ? 'pattern' : j > 0 ? 'topics' : 'topic' };
}

/**
 * Continuous difficulty in [0, 1]: LeetCode's label plus its acceptance rate,
 * on the scale of the recommender's difficulty prior (lib/model.js priorBeta).
 */
export function difficultyScore(p) {
  const a = Math.min(0.9, Math.max(0.1, (p.acRate ?? 50) / 100));
  const off = { Easy: -150, Medium: 0, Hard: 200 }[p.difficulty] ?? 0;
  const beta = 240 * Math.log10((1 - a) / a) + off;
  return Math.min(1, Math.max(0, (beta + 330) / 700));
}

const ringOf = (p) => (p.difficulty === 'Easy' ? 0 : p.difficulty === 'Hard' ? 2 : 1);
const DAY = 86400000;

/**
 * Positions as close as possible (least squares) to `ideal` (ascending), at
 * least `g` apart, inside [lo, hi]: isotonic regression (pool adjacent
 * violators) on ideal[i] − i·g, clamped. O(n). Exported for tests.
 */
export function spread(ideal, g, lo, hi) {
  const blocks = [];
  ideal.forEach((v, i) => {
    let b = { sum: v - i * g, cnt: 1 };
    while (blocks.length && blocks[blocks.length - 1].sum / blocks[blocks.length - 1].cnt >= b.sum / b.cnt) {
      const prev = blocks.pop();
      b = { sum: prev.sum + b.sum, cnt: prev.cnt + b.cnt };
    }
    blocks.push(b);
  });
  const top = hi - (ideal.length - 1) * g, out = [];
  for (const b of blocks) {
    const q = Math.max(lo, Math.min(top, b.sum / b.cnt));
    for (let k = 0; k < b.cnt; k++) out.push(q + out.length * g);
  }
  return out;
}

/** Pure layout: problems -> positioned nodes, rings, arcs, links. Exported for tests. */
export function layout(problems, { size, width = size, height = size, target, now = Date.now() }) {
  const cx = width / 2, cy = height / 2;
  const R = height / 2 - 52;
  const r0 = Math.max(80, height * 0.11);                      // room for the goal text
  const n = problems.length;
  const scale = Math.max(1, Math.min(1.8, R / 254));
  const rings = [0.42, 0.76, 0.97].map(f => r0 + (R - r0) * f);
  // centre-to-centre spacing a ring aims for; a crowded ring settles for even spacing
  const SPACING = 2.6 * 2.8 * Math.sqrt(scale) + 2;
  const ringGap = [Infinity, Infinity, Infinity];

  // topic arcs, sized by the topic's most crowded ring (dots per unit of
  // circumference), so no topic's inner ring ends up packed tighter than the
  // rest; a floor keeps small topics legible
  const counts = {}, perRingCount = {};
  for (const p of problems) {
    p._topic = primaryTopic(p.tags, p.pattern);
    counts[p._topic] = (counts[p._topic] || 0) + 1;
    (perRingCount[p._topic] ??= [0, 0, 0])[ringOf(p)] += 1;
  }
  const present = DISPLAY.filter(t => counts[t]);
  const maxCount = Math.max(1, ...present.map(t => counts[t]));
  const GAP = present.length > 1 ? 0.035 : 0;
  const usable = TAU - GAP * present.length;
  const wts = present.map(t => Math.max(3 / rings[1], ...perRingCount[t].map((c, j) => c / rings[j])));
  const wsum = wts.reduce((a, b) => a + b, 0) || 1;
  const sectors = {};
  let a = -Math.PI / 2 + GAP / 2;
  present.forEach((t, i) => {
    const span = usable * (wts[i] / wsum);
    sectors[t] = {
      topic: t, start: a, span, mid: a + span / 2, count: counts[t], nodes: [],
      hue: TOPIC_HUE[t] ?? 220, intensity: 0.3 + 0.7 * Math.sqrt(counts[t] / maxCount),
    };
    a += span + GAP;
  });

  // "built on" links: within a topic, each problem's parent is the earlier
  // problem it's most related to (ties to the most recent)
  const items = problems.map((p, k) => ({ p, k, parent: null, via: 'start', kids: [], size: 0 }));
  const bySec = {};
  for (const it of items) (bySec[it.p._topic] ??= []).push(it);
  for (const list of Object.values(bySec)) {
    list.forEach((it, i) => {
      let best = -1;
      for (let j = 0; j < i; j++) {
        const rel = relate(it.p, list[j].p);
        if (rel.score >= best) { best = rel.score; it.parent = list[j]; it.via = rel.via; }
      }
      if (it.parent) it.parent.kids.push(it);
    });
  }
  const sizeOf = (it) => (it.size ||= 1 + it.kids.reduce((s, c) => s + sizeOf(c), 0));

  // order each topic depth-first through its tree; small subtrees first, so a
  // problem's direct "leaves" sit right beside it and big branches stay together
  const nodes = [];
  for (const [topic, list] of Object.entries(bySec)) {
    const sec = sectors[topic];
    const order = [];
    const stack = list.filter(it => !it.parent).reverse();
    while (stack.length) {
      const it = stack.pop();
      order.push(it);
      const kids = [...it.kids].sort((x, y) => sizeOf(y) - sizeOf(x) || y.k - x.k);   // popped smallest-first
      for (const c of kids) stack.push(c);
    }
    // place: each problem's ideal angle comes from the tree order across the
    // topic's arc; then each ring spreads its own dots — as close to those
    // angles as it can, never closer than SPACING (or evenly, when full).
    // Radius is exactly the difficulty ring: one layer per ring.
    const step = sec.span / Math.max(1, order.length);
    const perRing = [[], [], []];
    order.forEach((it, i) => { it.ideal = sec.start + step * (i + 0.5); perRing[ringOf(it.p)].push(it); });
    perRing.forEach((list, ring) => {
      if (!list.length) return;
      const r = rings[ring];
      const g = Math.min(SPACING / r, sec.span / list.length);
      const angs = spread(list.map(it => it.ideal), g, sec.start + g / 2, sec.start + sec.span - g / 2);
      list.forEach((it, j) => { it.ang = angs[j]; });
      ringGap[ring] = Math.min(ringGap[ring], g * r);
    });
    order.forEach((it) => {
      const p = it.p;
      const ring = ringOf(p);
      const ang = it.ang;
      const r = rings[ring];
      const age = now - p.t;
      const sameDay = new Date(p.t).toDateString() === new Date(now).toDateString();
      const node = {
        ...p, k: it.k, r, ang, ring, x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r,
        via: it.via, parentTitle: it.parent ? it.parent.p.title : null,
        dot: 0,                                    // set below, once every ring is placed
        sec: topic,
        tone: p.undated ? 'old' : sameDay ? 'today' : age < 7 * DAY ? 'recent' : age < 60 * DAY ? 'mid' : 'old',
      };
      it.node = node;
      sec.nodes.push(node);
      nodes.push(node);
    });
  }
  // one dot size for every ring, shrunk just enough that the tightest
  // neighbours still show a gap
  const tight = Math.min(...ringGap);
  const base = Math.min(2.8 * Math.sqrt(scale), Math.max(1.8, (tight - 2.2) / 2));
  for (const nd of nodes) nd.dot = base * (nd.ring === 0 ? 0.92 : nd.ring === 2 ? 1.1 : 1);
  const index = new Map(nodes.map((nd, i) => [nd, i]));
  for (const it of items) {
    it.node.par = it.parent ? index.get(it.parent.node) : -1;
    if (it.parent) (it.parent.node.kids ||= []).push(index.get(it.node));
  }

  // cross-topic links: a problem that also belongs to other topics (its tags,
  // or a LeetCode similar question placed elsewhere) links to the most related
  // problem there — top two per problem
  const bySlug = Object.fromEntries(nodes.map(nd => [nd.slug, nd]));
  const cross = new Map();
  const addCross = (x, y, score) => {
    const key = x.slug < y.slug ? `${x.slug}|${y.slug}` : `${y.slug}|${x.slug}`;
    if (!cross.has(key) || cross.get(key).score < score) cross.set(key, { a: x, b: y, score });
  };
  for (const nd of nodes) {
    const picks = [];
    for (const sl of nd.similar || []) {
      const q = bySlug[sl];
      if (q && q.sec !== nd.sec) picks.push({ q, score: 2 });
    }
    const own = new Set();
    for (const t of nd.tags || []) {
      const topic = tagTopic(t);
      if (topic !== nd.sec && sectors[topic]) own.add(topic);
    }
    if (own.size) nd.alsoIn = [...own];
    for (const topic of own) {
      let best = null, bs = 0.34;
      for (const q of sectors[topic].nodes) {
        const rel = relate(nd, q);
        if (rel.score > bs) { bs = rel.score; best = q; }
      }
      if (best) picks.push({ q: best, score: bs });
    }
    picks.sort((x, y) => y.score - x.score).slice(0, 2).forEach(({ q, score }) => addCross(nd, q, score));
  }
  const crossLinks = [...cross.values()];
  for (const c of crossLinks) {
    (c.a.cross ||= []).push(c.b);
    (c.b.cross ||= []).push(c.a);
  }

  // topic labels just past the outermost dot of the topic
  for (const sec of Object.values(sectors)) {
    const outer = sec.nodes.reduce((m, nd) => Math.max(m, nd.r), rings[2]);
    sec.labelR = outer + 18 * Math.sqrt(scale);
  }

  return { cx, cy, R, r0, n, target, nodes, scale, rings, crossLinks, sectors: Object.values(sectors) };
}

// "built on" links bow inward along the topic; cross-topic links bundle
// through hubs near the centre (one hub per topic).
function linkPath(path, L, a, b) {
  path.moveTo(a.x, a.y);
  if (a.sec === b.sec) {
    const m = Math.atan2(Math.sin(a.ang) + Math.sin(b.ang), Math.cos(a.ang) + Math.cos(b.ang));
    const rr = Math.min(a.r, b.r) - (L.R - L.r0) * 0.07;
    path.quadraticCurveTo(L.cx + Math.cos(m) * rr, L.cy + Math.sin(m) * rr, b.x, b.y);
  } else {
    const hub = (nd) => {
      const s = L.sectors.find(x => x.topic === nd.sec);
      const hr = L.r0 + (L.R - L.r0) * 0.06;
      return [L.cx + Math.cos(s.mid) * hr, L.cy + Math.sin(s.mid) * hr];
    };
    const [hax, hay] = hub(a), [hbx, hby] = hub(b);
    path.bezierCurveTo(hax, hay, hbx, hby, b.x, b.y);
  }
}

/**
 * Everything static, batched once per data or phase change (content
 * coordinates). With a phase picked, problems outside it — and links that
 * touch them — go into separate faint batches.
 */
const STAR = '__starred';                       // the ★ filter, alongside the phases
const inFilter = (nd, f) => !f || (f === STAR ? !!nd.starred : (nd.phases ? nd.phases.includes(f) : nd.phase === f));
function buildPaint(L, phase = null) {
  for (const nd of L.nodes) nd.inPhase = inFilter(nd, phase);
  const hueOf = {};
  for (const sec of L.sectors) hueOf[sec.topic] = sec.hue;
  for (const sec of L.sectors) sec.inCount = sec.nodes.reduce((n, nd) => n + (nd.inPhase ? 1 : 0), 0);
  const paint = { tone: {} };
  for (const sec of L.sectors) {
    const I = sec.intensity;
    paint.tone[sec.topic] = {
      old: hsla(sec.hue, 58 + 10 * I, 0.42 + 0.5 * I),
      mid: hsla(sec.hue, 61 + 10 * I, 0.48 + 0.5 * I),
      recent: hsla(sec.hue, 66 + 8 * I, 0.6 + 0.4 * I),
      today: hsla(sec.hue, 76, 0.97),
    };
  }
  paint.hue = hueOf;
  paint.links = new Path2D();
  paint.linksDim = new Path2D();
  for (const nd of L.nodes) {
    if (nd.par < 0) continue;
    const pa = L.nodes[nd.par];
    linkPath(nd.inPhase && pa.inPhase ? paint.links : paint.linksDim, L, pa, nd);
  }
  paint.cross = new Path2D();
  for (const { a, b } of L.crossLinks) if (a.inPhase && b.inPhase) linkPath(paint.cross, L, a, b);
  return paint;
}

/**
 * Mount the view. Returns { update(view), fail(msg), retheme() }.
 * view: { goal, progress: { done, target, pct, daysLeft, perDay }, problems, now }
 */
export function mountGrowth(root, { onOpen, onTopic, onOpenSuggestion } = {}) {
  root.innerHTML = `
    <div class="growth-stage">
      <canvas class="growth-canvas"></canvas>
      <div class="growth-hub">
        <div class="growth-goal"></div>
        <div class="growth-count"><span class="growth-done">…</span><span class="growth-target"></span></div>
        <div class="growth-pace"></div>
      </div>
      <div class="growth-zoom" hidden>
        <button type="button" data-z="in" title="Zoom in" aria-label="Zoom in">+</button>
        <button type="button" data-z="out" title="Zoom out" aria-label="Zoom out">−</button>
        <button type="button" data-z="reset" title="Reset view" aria-label="Reset view">⤢</button>
      </div>
      <div class="growth-tip" hidden></div>
      <div class="growth-suggest" role="dialog" aria-label="Suggested problem" hidden></div>
    </div>
    <div class="growth-phases" role="tablist" aria-label="Prep phase" hidden></div>`;
  const stage = root.querySelector('.growth-stage');
  const canvas = root.querySelector('.growth-canvas');
  const hub = root.querySelector('.growth-hub');
  const tip = root.querySelector('.growth-tip');
  const zoomUi = root.querySelector('.growth-zoom');
  const phaseBar = root.querySelector('.growth-phases');
  const sug = root.querySelector('.growth-suggest');
  let labelBoxes = [], hoverLabel = null, sugState = null;
  let L = null, paint = null, view = null, hover = null, W = 0, H = 0, dpr = 1;
  // the picked prep phase (null = all), remembered per browser
  let phase = null;
  try { phase = localStorage.getItem('lcanki.phase') || null; } catch (e) { /* storage blocked */ }
  const starCount = () => (view?.problems || []).reduce((n, p) => n + (p.starred ? 1 : 0), 0);
  const phaseInfo = (id) => id === STAR
    ? (starCount() ? { id: STAR, name: 'Starred', count: starCount(), star: true } : null)
    : view?.phases?.find(p => p.id === id) || null;
  // view transform: screen = content * s + (tx, ty)
  let s = 1, tx = 0, ty = 0;
  const MIN_S = 1, MAX_S = 6;

  function resize() {
    W = Math.min(stage.clientWidth || 1000, 1500);
    H = Math.round(Math.min(W * 0.72, Math.max(620, innerHeight * 0.86), 1060));
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    stage.style.height = `${H}px`;
  }
  function relayout() {
    L = view
      ? layout(view.problems.map(p => ({ ...p })), { width: W, height: H, target: view.progress.target, now: view.now })
      : layout([], { width: W, height: H, target: 1 });
    paint = buildPaint(L, phase);
    settleVisuals();
  }

  // The canvas is centred in the stage; the hub sits over the centre and
  // follows it when you pan or zoom.
  function placeHub() {
    if (!L) return;
    const off = (stage.clientWidth - W) / 2;
    hub.style.left = `${off + tx + L.cx * s}px`;
    hub.style.top = `${ty + L.cy * s}px`;
    const fade = s >= 1.6 ? 0 : 1 - (s - 1) / 0.6;
    hub.style.opacity = String(fade);
    hub.style.visibility = fade === 0 ? 'hidden' : 'visible';
  }

  let pending = false;
  function requestDraw() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(() => { pending = false; draw(); });
  }

  // ------------------------------------------------ filter transitions ----
  // Each dot has a visual state — a: topic colour (1) vs faded grey (0),
  // g: glow — that eases between states when the filter changes: a soft
  // pastel glow rises behind the picked dots while the rest fade back.
  // Dots keep their size.
  const V_NORMAL = { a: 1, g: 0 }, V_PICK = { a: 1, g: 1 }, V_FADE = { a: 0, g: 0 };
  // phase to phase is a slow drift; into or out of All is quicker
  const BETWEEN_MS = 1100, FROM_ALL_MS = 600;
  const reducedMotion = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  let anim = null;
  const targetOf = (nd) => (!phase ? V_NORMAL : nd.inPhase ? V_PICK : V_FADE);
  function settleVisuals() {
    anim = null;
    if (L) for (const nd of L.nodes) nd.vis = { ...targetOf(nd) };
  }
  function startTransition(ms) {
    if (reducedMotion || !L) { settleVisuals(); requestDraw(); return; }
    for (const nd of L.nodes) { nd.from = { ...(nd.vis || targetOf(nd)) }; nd.to = targetOf(nd); }
    anim = { start: performance.now(), ms };
    requestDraw();
  }
  function stepTransition() {
    const t = Math.min(1, (performance.now() - anim.start) / anim.ms);
    const e = (1 - Math.cos(Math.PI * t)) / 2;                                // gentle sine ease
    for (const nd of L.nodes) {
      const f = nd.from, to = nd.to;
      nd.vis = { a: f.a + (to.a - f.a) * e, g: f.g + (to.g - f.g) * e };
    }
    if (t >= 1) anim = null;
  }
  // link brightness from the dots at its ends: normal 0.2, picked 0.34, faded 0.03
  const linkW = (v) => 0.03 + v.a * 0.17 + v.g * 0.12;

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!L) return;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    const { cx, cy } = L;
    const k = Math.sqrt(s);              // strokes and dots grow with √zoom

    // the three rings, barely there, unlabelled
    ctx.save();
    ctx.strokeStyle = COLORS.ring;
    ctx.lineWidth = 1 / s;
    ctx.setLineDash([2 / s, 7 / s]);
    for (const r of L.rings) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, TAU); ctx.stroke(); }
    ctx.restore();

    ctx.lineCap = 'round';
    if (anim) stepTransition();
    if (!phase && !anim) {
      // the plain view: everything batched
      ctx.strokeStyle = 'rgba(206,210,217,0.06)';
      ctx.lineWidth = 0.7 / k;
      ctx.stroke(paint.cross);
      ctx.lineWidth = 0.9 / k;
      ctx.strokeStyle = 'rgba(206,210,217,0.2)';
      ctx.stroke(paint.links);
      // dots: one fill per (topic, tone)
      for (const sec of L.sectors) {
        for (const tone of TONES) {
          let any = false;
          ctx.beginPath();
          for (const nd of sec.nodes) {
            if (nd.tone !== tone) continue;
            const r = nd.dot / k;
            ctx.moveTo(nd.x + r, nd.y);
            ctx.arc(nd.x, nd.y, r, 0, TAU);
            any = true;
          }
          if (!any) continue;
          ctx.fillStyle = paint.tone[sec.topic][tone];
          ctx.fill();
        }
      }
    } else {
      // a filter is on, or on its way: every link and dot from its state
      const strokeBuckets = (pairs, alphaOf, width) => {
        const buckets = new Map();
        for (const [a, b] of pairs) {
          const al = Math.round(alphaOf(a, b) * 200) / 200;
          if (al < 0.005) continue;
          let p = buckets.get(al);
          if (!p) buckets.set(al, p = new Path2D());
          linkPath(p, L, a, b);
        }
        ctx.lineWidth = width;
        for (const [al, p] of buckets) { ctx.strokeStyle = `rgba(206,210,217,${al})`; ctx.stroke(p); }
      };
      strokeBuckets(L.crossLinks.map(c => [c.a, c.b]), (a, b) => 0.06 * Math.min(a.vis.a, b.vis.a), 0.7 / k);
      strokeBuckets(L.nodes.filter(nd => nd.par >= 0).map(nd => [L.nodes[nd.par], nd]), (a, b) => Math.min(linkW(a.vis), linkW(b.vis)), 0.9 / k);

      // faded: one soft grey, by how far each has faded
      const greys = new Map();
      for (const nd of L.nodes) {
        const al = Math.round(0.09 * (1 - nd.vis.a) * 400) / 400;
        if (al <= 0) continue;
        let p = greys.get(al);
        if (!p) greys.set(al, p = new Path2D());
        const r = nd.dot / k;
        p.moveTo(nd.x + r, nd.y);
        p.arc(nd.x, nd.y, r, 0, TAU);
      }
      for (const [al, p] of greys) { ctx.fillStyle = `rgba(206,210,217,${al})`; ctx.fill(p); }

      // a soft pastel glow behind the picked ones, rising as they come in
      for (const nd of L.nodes) {
        if (nd.vis.g < 0.01) continue;
        const r = nd.dot / k, R = r * 5.5 + 5 / k, hue = paint.hue[nd.sec] ?? 220, g = nd.vis.g;
        const grad = ctx.createRadialGradient(nd.x, nd.y, r * 0.6, nd.x, nd.y, R);
        grad.addColorStop(0, `hsla(${hue}, 38%, 84%, ${(0.2 * g).toFixed(3)})`);
        grad.addColorStop(0.45, `hsla(${hue}, 38%, 84%, ${(0.07 * g).toFixed(3)})`);
        grad.addColorStop(1, `hsla(${hue}, 38%, 84%, 0)`);
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, R, 0, TAU);
        ctx.fill();
      }

      // the dots in colour, same size as ever: picked ones warm up to their
      // topic's bright tone, the rest fade out
      for (const nd of L.nodes) {
        if (nd.vis.a < 0.004) continue;
        const r = nd.dot / k;
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, r, 0, TAU);
        ctx.globalAlpha = nd.vis.a;
        ctx.fillStyle = paint.tone[nd.sec][nd.tone];
        ctx.fill();
        if (nd.vis.g > 0.01) {
          ctx.globalAlpha = nd.vis.a * nd.vis.g;
          ctx.fillStyle = paint.tone[nd.sec].recent;
          ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
      if (anim) requestDraw();                   // next frame of the transition
    }

    if (hover) {
      // light this problem's links: what it built on, what built on it, and
      // its cross-topic links
      const p = new Path2D();
      if (hover.par >= 0) linkPath(p, L, L.nodes[hover.par], hover);
      for (const ci of hover.kids || []) linkPath(p, L, hover, L.nodes[ci]);
      for (const q of hover.cross || []) linkPath(p, L, hover, q);
      ctx.strokeStyle = COLORS.hi;
      ctx.lineWidth = 1.3 / k;
      ctx.stroke(p);
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, hover.dot * 1.8 / k, 0, TAU);
      ctx.fillStyle = COLORS.hi;
      ctx.fill();
    }

    // topic labels just outside each topic's dots, a constant size while zoomed
    ctx.font = `${12.5 / s}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    // each label is a button: its box (canvas CSS px) is kept for hit-testing
    labelBoxes = [];
    for (const sec of L.sectors) {
      if (sec.span < 0.12) continue;
      const lx = cx + Math.cos(sec.mid) * sec.labelR, ly = cy + Math.sin(sec.mid) * sec.labelR;
      const align = Math.abs(Math.cos(sec.mid)) < 0.3 ? 'center' : Math.cos(sec.mid) > 0 ? 'left' : 'right';
      const text = `${topicLabel(sec.topic)} ${phase ? sec.inCount : sec.count}`;
      ctx.textAlign = align;
      const on = hoverLabel === sec.topic || sugState?.topic === sec.topic;
      ctx.fillStyle = on ? COLORS.hi : COLORS.label;
      ctx.globalAlpha = phase && !sec.inCount && !on ? 0.35 : 1;
      ctx.fillText(text, lx, ly);
      const w = ctx.measureText(text).width * s, sx = tx + lx * s, sy = ty + ly * s;
      const x0 = align === 'left' ? sx : align === 'right' ? sx - w : sx - w / 2;
      labelBoxes.push({ sec, x0: x0 - 6, x1: x0 + w + 6, y0: sy - 11, y1: sy + 11 });
    }
    ctx.globalAlpha = 1;
  }

  const fmtDay = (d) => new Date(`${d}T12:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  function setHub() {
    const ph = phase && phaseInfo(phase);
    if (ph) {
      root.querySelector('.growth-goal').textContent = ph.name;
      root.querySelector('.growth-done').textContent = ph.count;
      root.querySelector('.growth-target').textContent = '';
      root.querySelector('.growth-pace').textContent = ph.star ? 'to come back to'
        : !ph.from ? 'outside any phase'
        : ph.to ? `${fmtDay(ph.from)} – ${fmtDay(ph.to)}` : `since ${fmtDay(ph.from)}`;
      return;
    }
    const g = view.goal, p = view.progress;
    root.querySelector('.growth-goal').textContent = g ? g.name : 'All practice';
    root.querySelector('.growth-done').textContent = p.done;
    root.querySelector('.growth-target').textContent = g ? ` / ${p.target}` : '';
    let pace = g ? `${Math.round(p.pct * 100)}%` : 'problems solved';
    if (g && p.daysLeft != null) {
      pace += p.remaining === 0 ? ' · done'
        : p.daysLeft === 0 ? ' · due today'
        : ` · ${p.perDay < 1 ? `1 every ${Math.round(1 / p.perDay)}d` : `${p.perDay.toFixed(1)}/day`}`;
    }
    root.querySelector('.growth-pace').textContent = pace;
  }

  // ------------------------------------------------------------ phases ----
  function renderPhases() {
    const list = view?.phases || [];
    const stars = starCount();
    phaseBar.textContent = '';
    phaseBar.hidden = !list.some(p => p.id !== 'unstructured') && !stars;
    if (phaseBar.hidden) return;
    const tab = (id, name, count) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(phase === id));
      b.className = phase === id ? 'on' : '';
      const n = document.createElement('span'); n.textContent = name;
      const c = document.createElement('span'); c.className = 'phase-count'; c.textContent = count;
      b.append(n, c);
      b.addEventListener('click', () => setPhase(phase === id || id == null ? null : id));
      phaseBar.appendChild(b);
    };
    tab(null, 'All', view.problems.length);
    if (stars) tab(STAR, '★ Starred', stars);
    // empty phases (nothing solved then, or nothing on this goal) stay out of the way
    if (list.some(p => p.id !== 'unstructured')) for (const p of list) if (p.count || phase === p.id) tab(p.id, p.name, p.count);
  }
  function setPhase(id) {
    const between = !!(phase && id);
    phase = id;
    try { if (id) localStorage.setItem('lcanki.phase', id); else localStorage.removeItem('lcanki.phase'); } catch (e) { /* fine */ }
    paint = buildPaint(L, phase);
    clearHover();
    setHub();
    renderPhases();
    startTransition(between ? BETWEEN_MS : FROM_ALL_MS);
  }

  // ---------------------------------------------------------- zoom / pan ----
  function clampPan() {
    const cxS = tx + L.cx * s, cyS = ty + L.cy * s;
    if (cxS < 0) tx -= cxS; else if (cxS > W) tx -= cxS - W;
    if (cyS < 0) ty -= cyS; else if (cyS > H) ty -= cyS - H;
  }
  function setZoomed() {
    zoomUi.hidden = s === 1;
    canvas.style.cursor = s > 1 ? 'grab' : 'default';
  }
  function zoomAt(mx, my, factor) {
    if (!L) return;
    let ns = Math.min(MAX_S, Math.max(MIN_S, s * factor));
    if (ns < 1.03) ns = 1;                     // snap home: rounding never leaves it at 1.0004×
    if (ns === s) return;
    tx = mx - (mx - tx) * (ns / s);
    ty = my - (my - ty) * (ns / s);
    s = ns;
    if (s === 1) { tx = 0; ty = 0; }
    clampPan();
    setZoomed();
    clearHover();
    closeSuggest();
    placeHub();
    requestDraw();
  }
  function resetView() { s = 1; tx = 0; ty = 0; setZoomed(); placeHub(); requestDraw(); }

  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('wheel', (e) => {
    if (!(e.ctrlKey || e.metaKey)) return;     // plain scroll scrolls the page
    e.preventDefault();
    const [mx, my] = local(e);
    const d = Math.max(-50, Math.min(50, e.deltaY));
    zoomAt(mx, my, Math.exp(-d * 0.01));
  }, { passive: false });
  canvas.addEventListener('dblclick', (e) => { const [mx, my] = local(e); zoomAt(mx, my, 2); });
  zoomUi.addEventListener('click', (e) => {
    const z = e.target.closest('button')?.dataset.z;
    if (z === 'reset') resetView();
    else if (z) zoomAt(W / 2, H / 2, z === 'in' ? 1.6 : 1 / 1.6);
  });

  let drag = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (s === 1) return;
    drag = { x: e.clientX, y: e.clientY, tx, ty, moved: false };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  });
  canvas.addEventListener('pointerup', () => {
    if (drag) canvas.style.cursor = 'grab';
    setTimeout(() => { drag = null; }, 0);       // let the click handler see drag.moved
  });

  // Hover must never outlive the pointer. pointerleave alone misses the
  // cases that left a stale card on screen: scrolling the page under a still
  // cursor, leaving the window, switching tabs.
  function clearHover() {
    tip.hidden = true;
    if (hover || hoverLabel) { hover = null; hoverLabel = null; requestDraw(); }
    if (!drag) canvas.style.cursor = s > 1 ? 'grab' : 'default';
  }
  canvas.addEventListener('pointerleave', () => { if (!drag) clearHover(); });
  canvas.addEventListener('pointercancel', clearHover);
  addEventListener('scroll', clearHover, { passive: true });
  addEventListener('blur', clearHover);
  document.addEventListener('visibilitychange', clearHover);
  document.addEventListener('mouseout', (e) => { if (!e.relatedTarget) clearHover(); });   // left the window
  document.addEventListener('pointermove', (e) => { if (hover && e.target !== canvas && !drag) clearHover(); }, { passive: true });

  function nodeAt(mx, my) {
    const x = (mx - tx) / s, y = (my - ty) / s;
    // the dot itself plus a few pixels: anything looser keeps a card up
    // while you're plainly between dots
    const k = Math.sqrt(s);
    let best = null, bd = Infinity;
    for (const nd of L.nodes) {
      if (!nd.inPhase) continue;                 // faded problems don't pop up
      const d = Math.hypot(nd.x - x, nd.y - y);
      if (d <= nd.dot / k + 4 / s && d < bd) { bd = d; best = nd; }
    }
    return best;
  }
  canvas.addEventListener('pointermove', (e) => {
    if (!L) return;
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      tx = drag.tx + dx; ty = drag.ty + dy;
      clampPan(); placeHub(); requestDraw();
      tip.hidden = true;
      return;
    }
    const [mx, my] = local(e);
    const lb = labelAt(mx, my);
    if ((lb?.sec.topic ?? null) !== hoverLabel) { hoverLabel = lb?.sec.topic ?? null; requestDraw(); }
    if (lb) {
      if (hover) { hover = null; requestDraw(); }
      tip.hidden = true;
      canvas.style.cursor = 'pointer';
      return;
    }
    const nd = nodeAt(mx, my);
    if (nd !== hover) { hover = nd; requestDraw(); }
    canvas.style.cursor = nd ? 'pointer' : s > 1 ? 'grab' : 'default';
    if (!nd) { tip.hidden = true; return; }
    showTip(nd);
  });
  function labelAt(mx, my) {
    return labelBoxes.find(b => mx >= b.x0 && mx <= b.x1 && my >= b.y0 && my <= b.y1) || null;
  }
  canvas.addEventListener('click', (e) => {
    if (drag?.moved) return;
    const [mx, my] = local(e);
    const lb = labelAt(mx, my);
    if (lb) { if (sugState?.topic === lb.sec.topic) closeSuggest(); else openSuggest(lb); return; }
    if (sugState) { closeSuggest(); return; }
    if (hover && onOpen) onOpen(hover);
  });

  // ------------------------------------------------- topic suggestions ----
  // Click a topic's label: a suggested next problem on that arc, from the
  // recommender (goal-aware). "another" steps through its top few.
  async function openSuggest(box) {
    const topic = box.sec.topic;
    sugState = { topic, box, recs: null, i: 0 };
    renderSuggest();
    requestDraw();
    let recs = [];
    try { recs = (await onTopic?.(topic)) || []; } catch (e) { recs = []; }
    if (sugState?.topic !== topic) return;           // closed or switched meanwhile
    sugState.recs = recs;
    renderSuggest();
  }
  function closeSuggest() {
    if (!sugState) return;
    sugState = null;
    sug.hidden = true;
    requestDraw();
  }
  function renderSuggest() {
    const st = sugState;
    sug.textContent = '';
    const head = document.createElement('div');
    head.className = 'sug-head';
    head.textContent = `${topicLabel(st.topic)} · next up`;
    sug.appendChild(head);
    const rec = st.recs?.[st.i];
    if (!st.recs) {
      const p = document.createElement('div'); p.className = 'sug-meta'; p.textContent = 'finding one…'; sug.appendChild(p);
    } else if (!rec) {
      const p = document.createElement('div'); p.className = 'sug-meta'; p.textContent = 'Nothing left to suggest here.'; sug.appendChild(p);
    } else {
      const a = document.createElement('a');
      a.className = 'sug-title';
      a.href = rec.href || rec.url;
      a.textContent = rec.title;
      a.addEventListener('click', (e) => { if (onOpenSuggestion) { e.preventDefault(); onOpenSuggestion(rec); } });
      const meta = document.createElement('div');
      meta.className = 'sug-meta';
      meta.textContent = [rec.difficulty, rec.p != null ? `${Math.round(rec.p * 100)}% you'd solve it` : null].filter(Boolean).join(' · ');
      sug.append(a, meta);
      if (rec.reason) {
        const why = document.createElement('div'); why.className = 'sug-why'; why.textContent = rec.reason; sug.appendChild(why);
      }
      if (st.recs.length > 1) {
        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'sug-more';
        more.textContent = 'another';
        more.addEventListener('click', () => { st.i = (st.i + 1) % st.recs.length; renderSuggest(); });
        sug.appendChild(more);
      }
    }
    sug.hidden = false;
    // beside the label, kept inside the stage
    const off = (stage.clientWidth - W) / 2, b = st.box;
    const sw = sug.offsetWidth || 240, sh = sug.offsetHeight || 90;
    let x = off + (b.x0 + b.x1) / 2 - sw / 2, y = b.y1 + 8;
    if (y + sh > H) y = b.y0 - sh - 8;
    x = Math.max(8, Math.min(stage.clientWidth - sw - 8, x));
    sug.style.left = `${x}px`;
    sug.style.top = `${Math.max(8, y)}px`;
  }
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSuggest(); });
  document.addEventListener('pointerdown', (e) => {
    if (sugState && !sug.contains(e.target) && e.target !== canvas) closeSuggest();
  });

  function showTip(nd) {
    const when = nd.undated ? 'on NeetCode'
      : new Date(nd.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    const sw = document.createElement('i');
    sw.className = 'tip-dot';
    sw.style.background = paint.tone[nd.sec]?.recent || COLORS.hi;
    const b = document.createElement('b');
    b.textContent = nd.starred ? `${nd.title} ★` : nd.title;
    head.append(sw, b);
    const meta = document.createElement('div');
    meta.className = 'tip-meta';
    const due = nd.due != null && nd.due <= Date.now();
    const ph = view?.phases?.some(p => p.id !== 'unstructured')
      ? (nd.phases || [nd.phase]).map(id => phaseInfo(id)?.name).filter(Boolean).join(', ') || null
      : null;
    meta.textContent = [nd.difficulty, topicLabel(nd.sec), when, ph, due ? 'due' : null].filter(Boolean).join(' · ');
    tip.append(head, meta);
    if (nd.parentTitle) {
      const from = document.createElement('div');
      from.className = 'tip-from';
      from.textContent = `↳ ${nd.parentTitle}`;
      const why = document.createElement('span');
      why.textContent = ` · ${{ similar: 'similar', pattern: 'same pattern', topics: 'shared topics', topic: 'same topic' }[nd.via]}`;
      from.appendChild(why);
      tip.appendChild(from);
    }
    if (nd.alsoIn?.length) {
      const also = document.createElement('div');
      also.className = 'tip-also';
      also.textContent = `also ${nd.alsoIn.map(topicLabel).join(', ')}`;
      tip.appendChild(also);
    }
    tip.hidden = false;
    const off = (stage.clientWidth - W) / 2;
    const ax = off + nd.x * s + tx, ay = nd.y * s + ty;
    const tw = tip.offsetWidth || 220, th = tip.offsetHeight || 70;
    tip.style.left = `${ax + 14 + tw > off + W ? ax - 14 - tw : ax + 14}px`;
    tip.style.top = `${ay - th - 12 < 0 ? ay + 14 : ay - th - 12}px`;
  }

  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); relayout(); clearHover(); resetView(); }, 120);
  });

  // Size and draw right away, so a slow or failed load never leaves the
  // browser's default 300×150 canvas on screen.
  resize();
  relayout();
  placeHub();
  draw();

  return {
    /** Show a load failure in the hub instead of a misleading "0". */
    fail(msg) {
      root.querySelector('.growth-done').textContent = '—';
      root.querySelector('.growth-pace').textContent = `couldn’t load: ${msg}`;
    },
    /** Re-read theme colours and redraw in place. */
    retheme() { readColors(); requestDraw(); },
    update(v) {
      const sameGoal = view && v.goal?.id === view.goal?.id;
      view = v;
      if (phase && !phaseInfo(phase)) phase = null;   // that phase was deleted, or no longer has anything
      if (sugState && !sameGoal) closeSuggest();
      readColors();
      resize();
      relayout();
      clearHover();
      if (!sameGoal) { s = 1; tx = 0; ty = 0; setZoomed(); }
      placeHub();
      setHub();
      renderPhases();
      draw();
    },
  };
}
