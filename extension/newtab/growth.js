// Goal growth: your solved problems as a tree graph growing out of the goal.
//
//   centre     the goal ("Google interview · 42 / 150")
//   angle      topic — fixed sector order, so sectors don't jump around
//   distance   progress toward the goal: the k-th problem you solved sits at
//              r0 + (R − r0)·√(k/target), so the tree's AREA grows with your
//              count and the growth front reaches the goal ring at 100%
//   edges      each problem grows from the earlier problem in its topic it's
//              MOST RELATED to: a LeetCode "similar question" first, then the
//              closest match on topics and NeetCode pattern (see relate()).
//              Drawn as a radial dendrogram, so subtrees never cross.
//   nodes      one per problem; size = difficulty, brighter = more recent
//
// One colour, flat, no effects. Zoom with a pinch or ⌘/Ctrl+scroll, drag to
// pan, double-click to zoom in; plain scrolling still scrolls the page.
//
// Performance: edges are built once per data change into a few batched
// Path2D objects (bucketed by stroke width), so zooming and panning only change
// the transform. Redraws are coalesced to one per animation frame. (The
// previous renderer stroked every branch separately with a blur, which is
// what made zoom stutter.)

const TAU = Math.PI * 2;

// Primary topic = the most "technique-like" tag a problem carries; generic
// tags (array, string, hash table) only win when nothing more specific exists.
const ALIAS = {
  'breadth-first-search': 'graph', 'depth-first-search': 'graph', 'topological-sort': 'graph',
  'shortest-path': 'graph', 'binary-tree': 'tree', 'binary-search-tree': 'tree',
  'monotonic-stack': 'stack', 'memoization': 'dynamic-programming', 'heap-priority-queue': 'heap',
  'union-find': 'graph', 'prefix-sum': 'array', 'sorting': 'array', 'matrix': 'array',
  'counting': 'hash-table', 'bitmask': 'bit-manipulation', 'queue': 'stack',
};
const PRIORITY = [
  'dynamic-programming', 'backtracking', 'graph', 'trie', 'heap', 'binary-search', 'sliding-window',
  'two-pointers', 'linked-list', 'tree', 'stack', 'greedy', 'bit-manipulation', 'math',
  'string', 'hash-table', 'array',
];
// Circle order groups related techniques next to each other.
const DISPLAY = [
  'array', 'hash-table', 'string', 'two-pointers', 'sliding-window', 'stack', 'binary-search',
  'linked-list', 'tree', 'trie', 'graph', 'heap', 'backtracking', 'dynamic-programming',
  'greedy', 'bit-manipulation', 'math', 'other',
];
const LABEL = {
  'hash-table': 'hashing', 'two-pointers': 'two pointers', 'sliding-window': 'sliding window',
  'binary-search': 'binary search', 'linked-list': 'linked list', 'dynamic-programming': 'DP',
  'bit-manipulation': 'bits', 'heap': 'heap',
};
const topicLabel = (t) => LABEL[t] || String(t).replace(/-/g, ' ');

// Each topic gets its own soft hue (no yellows). Neighbouring topics on the
// circle get well-separated hues, so regions read apart at a glance.
const TOPIC_HUE = {
  'array': 212, 'hash-table': 170, 'string': 268, 'two-pointers': 18, 'sliding-window': 192,
  'stack': 330, 'binary-search': 145, 'linked-list': 240, 'tree': 125, 'trie': 300,
  'graph': 200, 'heap': 352, 'backtracking': 284, 'dynamic-programming': 158,
  'greedy': 28, 'bit-manipulation': 228, 'math': 185, 'other': 220,
};
const hsla = (h, l, a) => `hsla(${h}, 42%, ${l}%, ${a.toFixed(3)})`;   // soft, but enough to read

export function primaryTopic(tags = []) {
  const norm = new Set(tags.map(t => ALIAS[t] || t));
  for (const t of PRIORITY) if (norm.has(t)) return t;
  return 'other';
}

// Colours come from the page's theme tokens (newtab.css).
const TOKENS = {
  edge: ['--stem', 'rgba(206,210,217,0.36)'], hi: ['--stem-hi', 'rgba(206,210,217,0.95)'],
  old: ['--leaf-old', 'rgba(206,210,217,0.4)'], mid: ['--leaf-mid', 'rgba(206,210,217,0.55)'],
  recent: ['--leaf-recent', 'rgba(206,210,217,0.72)'], today: ['--leaf-today', 'rgba(206,210,217,0.92)'],
  ring: ['--ring', 'rgba(206,210,217,0.16)'], label: ['--label', 'rgba(206,210,217,0.5)'],
  cross: ['--cross', 'rgba(206,210,217,0.085)'], crossHi: ['--cross-hi', 'rgba(206,210,217,0.5)'],
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

function hash01(str) {
  let h = 2166136261;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const DAY = 86400000;

/** Pure layout: problems -> positioned nodes + sectors. Exported for tests. */
export function layout(problems, { size, width = size, height = size, target, now = Date.now() }) {
  // Wider than tall so the topic labels on the left and right never clip.
  const cx = width / 2, cy = height / 2;
  const R = height / 2 - 52;
  const r0 = Math.max(80, height * 0.11);   // room for the goal text
  const n = problems.length;
  const T = Math.max(target || 1, n, 1);

  // sectors sized by count^0.7 so big topics don't swallow the circle
  const counts = {};
  for (const p of problems) {
    p._topic = primaryTopic(p.tags);
    counts[p._topic] = (counts[p._topic] || 0) + 1;
  }
  const present = DISPLAY.filter(t => counts[t]);
  const weights = present.map(t => Math.pow(counts[t], 0.7));
  const wsum = weights.reduce((a, b) => a + b, 0) || 1;
  const gap = present.length > 1 ? 0.05 : 0;
  const usable = TAU - gap * present.length;
  const sectors = {};
  let a = -Math.PI / 2;
  // A topic lights up with how much you've done there: intensity runs from
  // dim (a couple of problems) to full (your biggest topic), on a √ scale so
  // small topics stay visible.
  const maxCount = Math.max(1, ...present.map(t => counts[t]));
  present.forEach((t, i) => {
    const span = usable * (weights[i] / wsum);
    const intensity = 0.3 + 0.7 * Math.sqrt(counts[t] / maxCount);
    sectors[t] = { topic: t, start: a, span, mid: a + span / 2, count: counts[t], nodes: [],
                   hue: TOPIC_HUE[t] ?? 220, intensity };
    a += span + gap;
  });

  const scale = Math.max(1, Math.min(1.8, R / 254));

  // Pass 1 — links. Within each topic, every problem's parent is the earlier
  // problem it's most related to (ties to the most recent). Positions play no
  // part, so the tree is purely "what built on what".
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

  // Pass 2 — angles, as a radial dendrogram: each subtree owns a wedge sized
  // by how many problems hang off it, and children split their parent's
  // wedge. Different subtrees never overlap, so edges never cross.
  const weight = (it) => Math.pow(sizeOf(it), 0.85);
  function assign(it, lo, hi) {
    // not dead centre: a little play inside the wedge keeps it from looking machined
    it.ang = lo + (hi - lo) * (0.32 + 0.36 * hash01(it.p.slug));
    if (!it.kids.length) return;
    const total = it.kids.reduce((s, c) => s + weight(c), 0);
    let a = lo;
    for (const c of it.kids) {
      const w = (hi - lo) * weight(c) / total;
      assign(c, a, a + w);
      a += w;
    }
  }
  for (const [topic, list] of Object.entries(bySec)) {
    const sec = sectors[topic];
    const pad = Math.min(0.035, sec.span * 0.08);
    const roots = list.filter(it => !it.parent);
    const total = roots.reduce((s, r) => s + weight(r), 0);
    let a = sec.start + pad;
    const span = sec.span - 2 * pad;
    for (const root of roots) {
      const w = span * weight(root) / total;
      assign(root, a, a + w);
      a += w;
    }
  }

  // Pass 3 — positions and edges. Distance from the centre is still solve
  // order. An edge leaves its parent sideways near the parent's own radius,
  // then runs straight out to the child (the dendrogram "elbow").
  const nodes = [];
  for (const it of items) {
    const { p, k } = it;
    const sec = sectors[p._topic];
    const r0k = r0 + (R - r0) * Math.sqrt((k + 1) / T);
    const ang = it.ang;
    const par = it.parent?.node || null;
    const pr = par ? par.r : r0 - 8;
    // ±3% radial jitter for variety, never inward of the parent
    const r = Math.max(pr + 3, r0k * (1 + (hash01(p.slug + 'r') - 0.5) * 0.06));
    const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    const pa = par ? par.ang : ang;
    const px = cx + Math.cos(pa) * pr, py = cy + Math.sin(pa) * pr;
    // elbow height and a slight sideways bend vary per edge
    const er = pr + (r - pr) * (0.08 + 0.3 * hash01(p.slug + 'e'));
    const qa = ang + (hash01(p.slug + 'b') - 0.5) * 0.14;
    const qx = cx + Math.cos(qa) * er, qy = cy + Math.sin(qa) * er;
    const age = now - p.t;
    const sameDay = new Date(p.t).toDateString() === new Date(now).toDateString();
    const node = {
      ...p, k, r, ang, x, y, px, py, qx, qy, pr,
      via: it.via, parentTitle: par ? par.title : null,
      // edge width bucket: thick near the centre, thinner toward the edge
      wb: Math.min(3, Math.floor(Math.max(0, (pr - r0) / (R - r0 || 1)) * 4)),
      vb: Math.min(2, Math.floor(hash01(p.slug + 'w') * 3)),      // width variance bucket
      dot: (p.difficulty === 'Hard' ? 3.7 : p.difficulty === 'Easy' ? 2.6 : 3.1) * Math.sqrt(scale),
      sec: p._topic,
      tone: p.undated ? 'old' : sameDay ? 'today' : age < 7 * DAY ? 'recent' : age < 60 * DAY ? 'mid' : 'old',
    };
    it.node = node;
    sec.nodes.push(node);
    nodes.push(node);
  }
  // Pass 4 — cross-topic links. A problem that also belongs to other topics
  // (by its tags, or a LeetCode similar question placed in another topic)
  // gets a super-faint link to the most related problem over there.
  const bySlug = Object.fromEntries(nodes.map(nd => [nd.slug, nd]));
  const cross = new Map();
  const addCross = (a, b, score) => {
    const key = a.slug < b.slug ? `${a.slug}|${b.slug}` : `${b.slug}|${a.slug}`;
    if (!cross.has(key) || cross.get(key).score < score) cross.set(key, { a, b, score });
  };
  for (const nd of nodes) {
    const picks = [];
    for (const sl of nd.similar || []) {
      const q = bySlug[sl];
      if (q && q.sec !== nd.sec) picks.push({ q, score: 2 });
    }
    const others = new Set();
    for (const t of nd.tags || []) {
      const topic = ALIAS[t] || t;
      if (topic !== nd.sec && sectors[topic]) others.add(topic);
    }
    for (const topic of others) {
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
  // "also" = the problem's OWN other topics (from its tags), not the topics
  // of whatever happens to link to it
  for (const nd of nodes) {
    const own = new Set();
    for (const t of nd.tags || []) {
      const topic = ALIAS[t] || t;
      if (topic !== nd.sec && sectors[topic]) own.add(topic);
    }
    if (own.size) nd.alsoIn = [...own];
  }

  return { cx, cy, R, r0, T, n, nodes, scale, crossLinks, sectors: Object.values(sectors) };
}

const EDGE_WIDTH = [1.6, 1.3, 1.05, 0.85];  // by depth bucket, before scale
const WIDTH_VARIANCE = [0.75, 1, 1.25];       // per-edge variety

function crossPath(path, L, a, b) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  path.moveTo(a.x, a.y);
  path.quadraticCurveTo(L.cx + (mx - L.cx) * 0.3, L.cy + (my - L.cy) * 0.3, b.x, b.y);
}

/**
 * Everything static, batched once per data change (content coordinates):
 * edges as one Path2D per (topic, width bucket), and each topic's colours.
 */
function buildPaint(L) {
  const bySec = {};
  for (const sec of L.sectors) {
    const I = sec.intensity;
    // Lines stay neutral silver; only the dots carry the topic's colour,
    // brighter the more you've solved in that topic (recent ones a touch more).
    bySec[sec.topic] = {
      edges: EDGE_WIDTH.map(() => WIDTH_VARIANCE.map(() => new Path2D())),
      tone: {
        old: hsla(sec.hue, 58 + 10 * I, 0.38 + 0.5 * I),
        mid: hsla(sec.hue, 61 + 10 * I, 0.44 + 0.5 * I),
        recent: hsla(sec.hue, 66 + 8 * I, 0.55 + 0.45 * I),
        today: hsla(sec.hue, 76, 0.95),
      },
    };
  }
  for (const nd of L.nodes) {
    const p = bySec[nd.sec].edges[nd.wb][nd.vb];
    p.moveTo(nd.px, nd.py);
    p.quadraticCurveTo(nd.qx, nd.qy, nd.x, nd.y);
  }
  // cross-topic links bow toward the centre, like a chord diagram
  const cross = new Path2D();
  for (const { a, b } of L.crossLinks) crossPath(cross, L, a, b);
  bySec.__cross = cross;
  return bySec;
}

/**
 * Mount the view. Returns { update(view), fail(msg), retheme() }.
 * view: { goal, progress: { done, target, pct, daysLeft, perDay }, problems, now }
 */
export function mountGrowth(root, { onOpen } = {}) {
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
    </div>`;
  const stage = root.querySelector('.growth-stage');
  const canvas = root.querySelector('.growth-canvas');
  const hub = root.querySelector('.growth-hub');
  const tip = root.querySelector('.growth-tip');
  const zoomUi = root.querySelector('.growth-zoom');
  let L = null, edges = null, view = null, hover = null, W = 0, H = 0, dpr = 1;
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
    edges = buildPaint(L);
  }

  // The canvas is centred in the stage; the hub sits over the tree's centre
  // and follows it when you pan or zoom.
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

  function draw() {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!L) return;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    const { cx, cy, R, T, n } = L;
    const k = Math.sqrt(s);             // strokes and nodes grow with √zoom

    if (T > n || n === 0) {
      ctx.save();
      ctx.setLineDash([3 / s, 7 / s]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.strokeStyle = COLORS.ring;
      ctx.lineWidth = 1.2 / s;
      ctx.stroke();
      ctx.restore();
    }

    ctx.lineCap = 'round';
    // cross-topic links first, barely there, underneath everything
    ctx.strokeStyle = COLORS.cross;
    ctx.lineWidth = 0.7 / k;
    ctx.stroke(edges.__cross);

    ctx.strokeStyle = COLORS.edge;
    for (const sec of L.sectors) {
      const paint = edges[sec.topic];
      paint.edges.forEach((byVar, i) => byVar.forEach((path, v) => {
        // line weight barely grows with canvas size (dots and spacing do)
        ctx.lineWidth = EDGE_WIDTH[i] * WIDTH_VARIANCE[v] * Math.min(L.scale, 1.2) / k;
        ctx.stroke(path);
      }));
    }

    // nodes: one fill per (topic, tone)
    for (const sec of L.sectors) {
      const paint = edges[sec.topic];
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
        ctx.fillStyle = paint.tone[tone];
        ctx.fill();
      }
    }

    if (hover) {
      // light up this problem's cross-topic links
      if (hover.cross?.length) {
        const p = new Path2D();
        for (const q of hover.cross) crossPath(p, L, hover, q);
        ctx.strokeStyle = COLORS.crossHi;
        ctx.lineWidth = 1 / k;
        ctx.stroke(p);
      }
      ctx.beginPath();
      ctx.moveTo(hover.px, hover.py);
      ctx.quadraticCurveTo(hover.qx, hover.qy, hover.x, hover.y);
      ctx.strokeStyle = COLORS.hi;
      ctx.lineWidth = EDGE_WIDTH[hover.wb] * Math.min(L.scale, 1.2) * 1.5 / k;
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, hover.dot * 1.8 / k, 0, TAU);
      ctx.fillStyle = COLORS.hi;
      ctx.fill();
    }

    // topic labels just outside the ring, kept a constant size while zoomed
    ctx.font = `${12.5 / s}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.textBaseline = 'middle';
    for (const sec of L.sectors) {
      if (sec.span < 0.2) continue;
      ctx.fillStyle = COLORS.label;
      const lx = cx + Math.cos(sec.mid) * (R + 24), ly = cy + Math.sin(sec.mid) * (R + 24);
      ctx.textAlign = Math.abs(Math.cos(sec.mid)) < 0.3 ? 'center' : Math.cos(sec.mid) > 0 ? 'left' : 'right';
      ctx.fillText(`${topicLabel(sec.topic)} ${sec.count}`, lx, ly);
    }
  }

  function setHub() {
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

  // ---------------------------------------------------------- zoom / pan ----
  function clampPan() {
    // keep the centre of the tree somewhere on screen
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
    tip.hidden = true;
    placeHub();
    requestDraw();
  }
  function resetView() { s = 1; tx = 0; ty = 0; setZoomed(); placeHub(); requestDraw(); }

  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('wheel', (e) => {
    // a trackpad pinch arrives as ctrl+wheel; ⌘/Ctrl+scroll zooms too. Plain
    // scrolling returns immediately so the page scrolls as normal.
    if (!(e.ctrlKey || e.metaKey)) return;
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

  function nodeAt(mx, my) {
    const x = (mx - tx) / s, y = (my - ty) / s;
    let best = null, bd = 14 / s;
    for (const nd of L.nodes) {
      const d = Math.hypot(nd.x - x, nd.y - y);
      if (d < bd) { bd = d; best = nd; }
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
    const nd = nodeAt(mx, my);
    if (nd !== hover) { hover = nd; requestDraw(); }
    canvas.style.cursor = nd ? 'pointer' : s > 1 ? 'grab' : 'default';
    if (!nd) { tip.hidden = true; return; }
    const when = nd.undated ? 'on NeetCode'
      : new Date(nd.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    tip.textContent = '';
    const head = document.createElement('div');
    head.className = 'tip-head';
    const sw = document.createElement('i');
    sw.className = 'tip-dot';
    sw.style.background = edges[nd._topic]?.tone.recent || COLORS.hi;
    const b = document.createElement('b');
    b.textContent = nd.title;
    head.append(sw, b);
    const meta = document.createElement('div');
    meta.className = 'tip-meta';
    const due = nd.due != null && nd.due <= Date.now();
    meta.textContent = [nd.difficulty, topicLabel(nd._topic), when, due ? 'due' : null].filter(Boolean).join(' · ');
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
    const left = ax + 14 + tw > off + W ? ax - 14 - tw : ax + 14;
    const top = ay - th - 12 < 0 ? ay + 14 : ay - th - 12;
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  });
  canvas.addEventListener('pointerleave', () => {
    if (drag) return;
    tip.hidden = true;
    if (hover) { hover = null; requestDraw(); }
  });
  canvas.addEventListener('click', () => { if (hover && onOpen && !drag?.moved) onOpen(hover); });

  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { resize(); relayout(); resetView(); }, 120);
  });

  // Size and draw the empty ring right away, so a slow or failed load never
  // leaves the browser's default 300×150 canvas on screen.
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
      readColors();
      resize();
      relayout();
      if (!sameGoal) { s = 1; tx = 0; ty = 0; setZoomed(); }
      placeHub();
      setHub();
      draw();                                   // no grow-in: it's just there
    },
  };
}
