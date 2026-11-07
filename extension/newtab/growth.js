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
const hsla = (h, l, a) => `hsla(${h}, 34%, ${l}%, ${a.toFixed(3)})`;   // soft, low saturation

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
    it.ang = (lo + hi) / 2;
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
    const r = r0 + (R - r0) * Math.sqrt((k + 1) / T);
    const ang = it.ang;
    const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    const par = it.parent?.node || null;
    const pr = par ? par.r : r0 - 8;
    const pa = par ? par.ang : ang;
    const px = cx + Math.cos(pa) * pr, py = cy + Math.sin(pa) * pr;
    const er = pr + (r - pr) * 0.18;
    const qx = cx + Math.cos(ang) * er, qy = cy + Math.sin(ang) * er;
    const age = now - p.t;
    const sameDay = new Date(p.t).toDateString() === new Date(now).toDateString();
    const node = {
      ...p, k, r, ang, x, y, px, py, qx, qy, pr,
      via: it.via, parentTitle: par ? par.title : null,
      // edge width bucket: thick near the centre, thinner toward the edge
      wb: Math.min(3, Math.floor(Math.max(0, (pr - r0) / (R - r0 || 1)) * 4)),
      dot: (p.difficulty === 'Hard' ? 2.8 : p.difficulty === 'Easy' ? 1.9 : 2.35) * Math.sqrt(scale),
      sec: p._topic,
      tone: p.undated ? 'old' : sameDay ? 'today' : age < 7 * DAY ? 'recent' : age < 60 * DAY ? 'mid' : 'old',
    };
    it.node = node;
    sec.nodes.push(node);
    nodes.push(node);
  }
  return { cx, cy, R, r0, T, n, nodes, scale, sectors: Object.values(sectors) };
}

const EDGE_WIDTH = [2.6, 2.1, 1.7, 1.35];   // per width bucket, before scale

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
      edges: EDGE_WIDTH.map(() => new Path2D()),
      tone: {
        old: hsla(sec.hue, 58 + 10 * I, 0.38 + 0.5 * I),
        mid: hsla(sec.hue, 61 + 10 * I, 0.44 + 0.5 * I),
        recent: hsla(sec.hue, 66 + 8 * I, 0.55 + 0.45 * I),
        today: hsla(sec.hue, 76, 0.95),
      },
    };
  }
  for (const nd of L.nodes) {
    const p = bySec[nd.sec].edges[nd.wb];
    p.moveTo(nd.px, nd.py);
    p.quadraticCurveTo(nd.qx, nd.qy, nd.x, nd.y);
  }
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
    ctx.strokeStyle = COLORS.edge;
    for (const sec of L.sectors) {
      const paint = edges[sec.topic];
      paint.edges.forEach((path, i) => {
        ctx.lineWidth = EDGE_WIDTH[i] * L.scale / k;
        ctx.stroke(path);
      });
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
      ctx.beginPath();
      ctx.moveTo(hover.px, hover.py);
      ctx.quadraticCurveTo(hover.qx, hover.qy, hover.x, hover.y);
      ctx.strokeStyle = COLORS.hi;
      ctx.lineWidth = EDGE_WIDTH[hover.wb] * L.scale * 1.3 / k;
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
    const when = nd.undated ? 'solved on NeetCode'
      : `solved ${new Date(nd.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    tip.textContent = '';
    const b = document.createElement('b'); b.textContent = nd.title;
    const meta = document.createElement('span');
    meta.textContent = [topicLabel(nd._topic), nd.difficulty].filter(Boolean).join(' · ');
    const line = document.createElement('span');
    const due = nd.due != null && nd.due <= Date.now();
    line.textContent = `${when}${nd.reviews ? ` · ${nd.reviews} review${nd.reviews === 1 ? '' : 's'}` : ''}${due ? ' · due for review' : ''}`;
    const from = document.createElement('span');
    from.className = 'growth-tip-from';
    from.textContent = nd.parentTitle
      ? `grew from ${nd.parentTitle} · ${{ similar: 'similar problem', pattern: 'same pattern', topics: 'shared topics', topic: 'same topic' }[nd.via]}`
      : `first ${topicLabel(nd._topic)} problem`;
    tip.append(b, meta, line, from);
    tip.hidden = false;
    const off = (stage.clientWidth - W) / 2;
    const sx = off + nd.x * s + tx + 16, sy = nd.y * s + ty - 10;
    tip.style.left = `${Math.min(sx, off + W - 230)}px`;
    tip.style.top = `${Math.max(0, sy)}px`;
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
