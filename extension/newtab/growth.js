// Goal growth: your solved problems as a plant spreading out from the goal.
//
//   centre     the goal ("Google interview · 42 / 150")
//   angle      topic — fixed sector order, so sectors don't jump around
//   distance   progress toward the goal: the k-th problem you solved sits at
//              r0 + (R − r0)·√(k/target), so the canopy's AREA grows with your
//              count and the growth front reaches the goal ring at 100%
//   branches   each problem grows from the nearest earlier problem in its
//              topic, curving gently the same way — limbs lengthen over time
//   brightness the branch to a problem is a touch brighter the more recent it is
//
// Minimal on purpose: one colour, tapering branch lines, nothing on the tips
// (hover a tip to see the problem). Zoom with a pinch or ⌘/Ctrl+scroll, drag to pan, double-click to
// zoom in; plain scrolling still scrolls the page.

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

export function primaryTopic(tags = []) {
  const norm = new Set(tags.map(t => ALIAS[t] || t));
  for (const t of PRIORITY) if (norm.has(t)) return t;
  return 'other';
}

// Colours come from the page's theme tokens (newtab.css).
const TOKENS = {
  stem: ['--stem', 'rgba(210,230,255,0.3)'], stemHi: ['--stem-hi', 'rgba(255,255,255,0.8)'],
  old: ['--leaf-old', 'rgba(140,186,245,0.55)'], mid: ['--leaf-mid', 'rgba(165,205,250,0.72)'],
  recent: ['--leaf-recent', 'rgba(205,230,255,0.88)'], today: ['--leaf-today', '#ffffff'],
  ring: ['--ring', 'rgba(255,255,255,0.2)'],
  label: ['--label', 'rgba(238,245,255,0.55)'], halo: ['--halo', 'rgba(206,210,217,0.18)'],
};
let COLORS = {};
function readColors() {
  const cs = getComputedStyle(document.documentElement);
  COLORS = {};
  for (const [k, [v, fb]] of Object.entries(TOKENS)) COLORS[k] = cs.getPropertyValue(v).trim() || fb;
}
readColors();

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
  const R = height / 2 - 46;
  const r0 = Math.max(72, height * 0.108);   // just enough room for the goal text
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
  present.forEach((t, i) => {
    const span = usable * (weights[i] / wsum);
    sectors[t] = { topic: t, start: a, span, mid: a + span / 2, count: counts[t], nodes: [] };
    a += span + gap;
  });

  const scale = Math.max(1, Math.min(1.6, R / 254));
  const nodes = [];
  problems.forEach((p, k) => {
    const sec = sectors[p._topic];
    const r = r0 + (R - r0) * Math.sqrt((k + 1) / T);
    const want = sec.mid + (hash01(p.slug) - 0.5) * sec.span * 0.92;
    // parent: nearest earlier node in this sector that sits closer to the hub
    let parent = null, best = Infinity;
    const wx = cx + Math.cos(want) * r, wy = cy + Math.sin(want) * r;
    for (const q of sec.nodes) {
      if (q.r >= r - 2) continue;
      const d = Math.hypot(q.x - wx, q.y - wy);
      if (d < best) { best = d; parent = q; }
    }
    const ang = parent ? parent.ang + (want - parent.ang) * 0.55 : want;
    const x = cx + Math.cos(ang) * r, y = cy + Math.sin(ang) * r;
    const px = parent ? parent.x : cx + Math.cos(ang) * (r0 - 6);
    const py = parent ? parent.y : cy + Math.sin(ang) * (r0 - 6);
    // control point: midpoint nudged sideways, always the same way round —
    // a gentle consistent curl reads as growth instead of spokes
    const mx = (px + x) / 2, my = (py + y) / 2;
    const len = Math.hypot(x - px, y - py) || 1;
    // long limbs curve; short twigs stay nearly straight (a full curl on every
    // short segment turns a branch into a row of scallops)
    const curl = len * (0.04 + 0.18 * Math.min(1, Math.max(0, (len - 24) / 90)));
    const qx = mx + (-(y - py) / len) * curl, qy = my + ((x - px) / len) * curl;
    const age = now - p.t;
    const sameDay = new Date(p.t).toDateString() === new Date(now).toDateString();
    const node = {
      ...p, k, r, ang, x, y, px, py, qx, qy,
      pr: parent ? parent.r : r0 - 6,
      dot: (p.difficulty === 'Hard' ? 2.6 : p.difficulty === 'Easy' ? 1.7 : 2.1) * Math.sqrt(scale),
      tone: p.undated ? 'old' : sameDay ? 'today' : age < 7 * DAY ? 'recent' : age < 60 * DAY ? 'mid' : 'old',
      // two short, faint twigs at every tip: texture, not data — they keep
      // a sparse plant from reading as a handful of bare wires
      twigs: [0, 1].map(j => ({
        a: (j ? 1 : -1) * (0.45 + hash01(`${p.slug}#${j}`) * 0.5),
        len: (5 + hash01(`${p.slug}@${j}`) * 7) * scale,
      })),
    };
    sec.nodes.push(node);
    nodes.push(node);
  });
  return { cx, cy, R, r0, T, n, nodes, scale, sectors: Object.values(sectors) };
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
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let L = null, view = null, raf = 0, hover = null, shown = 0, W = 0, H = 0, dpr = 1;
  // view transform: screen = content * s + (tx, ty)
  let s = 1, tx = 0, ty = 0;
  const MIN_S = 1, MAX_S = 6;

  function resize() {
    W = Math.min(stage.clientWidth || 900, 1100);
    H = Math.round(Math.min(W * 0.82, Math.max(560, innerHeight * 0.76), 860));
    dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    stage.style.height = `${H}px`;
  }
  const doLayout = (v) => layout(v.problems.map(p => ({ ...p })), { width: W, height: H, target: v.progress.target, now: v.now });

  // The canvas is centred in the stage; the hub sits over the plant's centre
  // and follows it when you pan or zoom.
  function placeHub() {
    if (!L) return;
    const off = (stage.clientWidth - W) / 2;
    hub.style.left = `${off + tx + L.cx * s}px`;
    hub.style.top = `${ty + L.cy * s}px`;
    // the goal lens steps aside while you're zoomed in exploring leaves
    hub.style.opacity = s >= 1.6 ? '0' : String(1 - (s - 1) / 0.6 * 0.6);
    hub.style.visibility = s >= 1.6 ? 'hidden' : 'visible';
  }

  function draw(upto) {
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!L) return;
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * tx, dpr * ty);
    const { cx, cy, R, T, n } = L;

    if (T > n || n === 0) {
      ctx.save();
      ctx.setLineDash([2, 6]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.strokeStyle = COLORS.ring;
      ctx.lineWidth = 1 / s;
      ctx.stroke();
      ctx.restore();
    }

    const vis = L.nodes.slice(0, upto);
    ctx.lineCap = 'round';
    // a soft halo makes the lines feel diffused rather than etched
    ctx.shadowColor = COLORS.halo;
    ctx.shadowBlur = 4 * dpr;
    for (const nd of vis) {
      const hi = hover && hover === nd;
      // taper: thicker near the centre, finer toward the tips. The branch to a
      // recent problem is a little brighter — the same colour throughout.
      const t = Math.min(1, Math.max(0, (nd.pr - L.r0) / (R - L.r0 || 1)));
      ctx.beginPath();
      ctx.moveTo(nd.px, nd.py);
      ctx.quadraticCurveTo(nd.qx, nd.qy, nd.x, nd.y);
      ctx.strokeStyle = hi ? COLORS.stemHi : COLORS[nd.tone];
      // strokes thicken with √zoom, not zoom, so close-ups stay delicate
      ctx.lineWidth = (hi ? 1.5 : 1) * (1.8 - 0.9 * t) * L.scale / Math.sqrt(s);
      ctx.stroke();
    }
    for (const nd of vis) {
      const dir = Math.atan2(nd.y - nd.qy, nd.x - nd.qx);
      ctx.strokeStyle = COLORS[nd.tone];
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 0.7 * L.scale / Math.sqrt(s);
      for (const tw of nd.twigs) {
        ctx.beginPath();
        ctx.moveTo(nd.x, nd.y);
        ctx.lineTo(nd.x + Math.cos(dir + tw.a) * tw.len, nd.y + Math.sin(dir + tw.a) * tw.len);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    ctx.shadowBlur = 0;
    if (hover && vis.includes(hover)) {
      // only the hovered tip gets a mark, so you can see what you're pointing at
      ctx.beginPath();
      ctx.arc(hover.x, hover.y, 3.2 / Math.sqrt(s), 0, TAU);
      ctx.fillStyle = COLORS.stemHi;
      ctx.fill();
    }

    // topic labels just outside the ring, kept readable while zoomed
    ctx.font = `${10.5 / Math.max(1, s * 0.75)}px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif`;
    ctx.fillStyle = COLORS.label;
    ctx.textBaseline = 'middle';
    for (const sec of L.sectors) {
      if (sec.span < 0.22) continue;
      const lx = cx + Math.cos(sec.mid) * (R + 22), ly = cy + Math.sin(sec.mid) * (R + 22);
      ctx.textAlign = Math.abs(Math.cos(sec.mid)) < 0.3 ? 'center' : Math.cos(sec.mid) > 0 ? 'left' : 'right';
      ctx.fillText(`${topicLabel(sec.topic)} ${sec.count}`, lx, ly);
    }
  }

  function animate() {
    cancelAnimationFrame(raf);
    const total = L.nodes.length;
    if (reduce || !total) { shown = total; draw(total); return; }
    const start = performance.now();
    const DUR = Math.min(1600, 500 + total * 12);
    const step = (now) => {
      const f = Math.min(1, (now - start) / DUR);
      shown = Math.round(total * (1 - Math.pow(1 - f, 2.2)));
      draw(shown);
      if (f < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
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
    // keep the centre of the plant somewhere on screen
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
    const ns = Math.min(MAX_S, Math.max(MIN_S, s * factor));
    if (ns === s) return;
    tx = mx - (mx - tx) * (ns / s);
    ty = my - (my - ty) * (ns / s);
    s = ns;
    if (s === 1) { tx = 0; ty = 0; }
    clampPan();
    setZoomed();
    tip.hidden = true;
    placeHub();
    draw(shown);
  }
  function resetView() { s = 1; tx = 0; ty = 0; setZoomed(); placeHub(); draw(shown); }

  const local = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('wheel', (e) => {
    // a trackpad pinch arrives as ctrl+wheel; ⌘/Ctrl+scroll zooms too. Plain
    // scrolling is left alone so the page still scrolls past the graph.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const [mx, my] = local(e);
    // cap each step: a mouse notch is ~100px of deltaY, a pinch sends many
    // small ones — both should feel gradual
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
    let best = null, bd = 16 / s;
    for (const nd of L.nodes.slice(0, shown)) {
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
      clampPan(); placeHub(); draw(shown);
      tip.hidden = true;
      return;
    }
    const [mx, my] = local(e);
    const nd = nodeAt(mx, my);
    if (nd !== hover) { hover = nd; draw(shown); }
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
    tip.append(b, meta, line);
    tip.hidden = false;
    const off = (stage.clientWidth - W) / 2;
    const sx = off + nd.x * s + tx + 16, sy = nd.y * s + ty - 10;
    tip.style.left = `${Math.min(sx, off + W - 230)}px`;
    tip.style.top = `${Math.max(0, sy)}px`;
  });
  canvas.addEventListener('pointerleave', () => { if (!drag) { hover = null; tip.hidden = true; draw(shown); } });
  canvas.addEventListener('click', () => { if (hover && onOpen && !drag?.moved) onOpen(hover); });

  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => {
      if (!view) return;
      resize(); L = doLayout(view); shown = L.nodes.length; resetView();
    }, 120);
  });

  // Size and draw the empty ring right away, so a slow or failed load never
  // leaves the browser's default 300×150 canvas on screen.
  resize();
  L = layout([], { width: W, height: H, target: 1 });
  placeHub();
  draw(0);

  return {
    /** Show a load failure in the hub instead of a misleading "0". */
    fail(msg) {
      root.querySelector('.growth-done').textContent = '—';
      root.querySelector('.growth-pace').textContent = `couldn’t load: ${msg}`;
    },
    /** Re-read theme colours and redraw in place. */
    retheme() { readColors(); if (L) draw(shown); },
    update(v) {
      const same = view && v.goal?.id === view.goal?.id && v.problems.length === view.problems.length;
      view = v;
      readColors();
      resize();
      L = doLayout(v);
      if (!same) { s = 1; tx = 0; ty = 0; setZoomed(); }
      placeHub();
      setHub();
      if (same) { shown = L.nodes.length; draw(shown); } else animate();
    },
  };
}
