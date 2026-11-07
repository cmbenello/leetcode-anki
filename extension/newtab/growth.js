// Goal growth: your solved problems as a jungle spreading out from the goal.
//
//   centre          the goal ("Google interview · 42 / 150")
//   angle           topic — fixed sector order, so sectors don't jump around
//   distance        progress toward the goal: the k-th problem you solved sits
//                   at r0 + (R − r0)·√(k/target), so canopy AREA grows with your
//                   count and the growth front touches the goal ring at 100%
//   branches        each problem grows from the nearest earlier problem in its
//                   topic, so topics read as limbs that lengthen over time
//   leaf            size = difficulty; brightness = recency (today glows)
//   warm dot        due for review
//
// Subtle by design: thin stems, muted sage, one warm accent.

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

export function primaryTopic(tags = []) {
  const norm = new Set(tags.map(t => ALIAS[t] || t));
  for (const t of PRIORITY) if (norm.has(t)) return t;
  return 'other';
}

const COLORS = {
  stem: 'rgba(170, 186, 160, 0.26)',
  stemHi: 'rgba(214, 222, 200, 0.55)',
  old: '#5d7562',
  mid: '#7f9a7c',
  recent: '#a9bf9c',
  today: '#e7dcbc',
  due: 'rgba(207, 159, 88, 0.75)',
  leaflet: 'rgba(120, 146, 118, 0.55)',
  ring: 'rgba(236, 228, 206, 0.13)',
  ringFaint: 'rgba(236, 228, 206, 0.05)',
  label: 'rgba(214, 214, 200, 0.42)',
};

function hash01(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}
const DAY = 86400000;

/** Pure layout: problems -> positioned nodes + sectors. Exported for tests. */
export function layout(problems, { size, target, now = Date.now() }) {
  const cx = size / 2, cy = size / 2;
  const R = size / 2 - 46;             // leave room for topic labels
  const r0 = 64;                       // hub radius + breathing room
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
  const gap = present.length > 1 ? 0.04 : 0;
  const usable = TAU - gap * present.length;
  const sectors = {};
  let a = -Math.PI / 2;
  present.forEach((t, i) => {
    const span = usable * (weights[i] / wsum);
    sectors[t] = { topic: t, start: a, span, mid: a + span / 2, count: counts[t], nodes: [] };
    a += span + gap;
  });

  const nodes = [];
  problems.forEach((p, k) => {
    const sec = sectors[p._topic];
    const r = r0 + (R - r0) * Math.sqrt((k + 1) / T);
    const want = sec.mid + (hash01(p.slug) - 0.5) * sec.span * 0.84;
    // parent: nearest earlier node in this sector that sits closer to the hub
    let parent = null, best = Infinity;
    for (const q of sec.nodes) {
      if (q.r >= r - 2) continue;
      const d = Math.hypot(q.x - (cx + Math.cos(want) * r), q.y - (cy + Math.sin(want) * r));
      if (d < best) { best = d; parent = q; }
    }
    const pa = parent ? parent.ang : want;
    const ang = parent ? pa + (want - pa) * 0.55 : want;
    const age = now - p.t;
    const node = {
      ...p, k, r, ang,
      x: cx + Math.cos(ang) * r, y: cy + Math.sin(ang) * r,
      px: parent ? parent.x : cx + Math.cos(ang) * (r0 - 10),
      py: parent ? parent.y : cy + Math.sin(ang) * (r0 - 10),
      pr: parent ? parent.r : r0 - 10,
      size: p.difficulty === 'Hard' ? 10 : p.difficulty === 'Easy' ? 6 : 8,
      tone: age < DAY && new Date(p.t).toDateString() === new Date(now).toDateString() ? 'today'
          : age < 7 * DAY ? 'recent' : age < 60 * DAY ? 'mid' : 'old',
      isDue: p.due != null && p.due <= now,
    };
    sec.nodes.push(node);
    nodes.push(node);
  });
  return { cx, cy, R, r0, T, n, nodes, sectors: Object.values(sectors) };
}

function drawLeaf(ctx, x, y, ang, len, color, glow) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(ang);
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = 8; }
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.quadraticCurveTo(len * 0.5, -len * 0.42, len, 0);
  ctx.quadraticCurveTo(len * 0.5, len * 0.42, 0, 0);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
}

/**
 * Mount the view. Returns { update(view) }.
 * view: { goal, progress: { done, target, pct, daysLeft, perDay }, problems, now }
 */
export function mountGrowth(root, { onOpen } = {}) {
  root.innerHTML = `
    <div class="growth-stage">
      <canvas class="growth-canvas"></canvas>
      <div class="growth-hub">
        <div class="growth-goal"></div>
        <div class="growth-count"><span class="growth-done">0</span><span class="growth-target"></span></div>
        <div class="growth-pace"></div>
      </div>
      <div class="growth-tip" hidden></div>
    </div>`;
  const stage = root.querySelector('.growth-stage');
  const canvas = root.querySelector('.growth-canvas');
  const tip = root.querySelector('.growth-tip');
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let L = null, view = null, raf = 0, hover = null, shown = 0, size = 0;

  function resize() {
    size = Math.min(stage.clientWidth || 560, 600);
    const dpr = Math.min(2, devicePixelRatio || 1);
    canvas.width = Math.round(size * dpr);
    canvas.height = Math.round(size * dpr);
    canvas.style.width = canvas.style.height = `${size}px`;
    stage.style.height = `${size}px`;
    canvas.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(upto) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, size, size);
    if (!L) return;
    const { cx, cy, R, r0, T, n } = L;

    // growth rings at 25 / 50 / 75 % of the goal, and the goal ring itself
    for (const f of [0.25, 0.5, 0.75]) {
      ctx.beginPath();
      ctx.arc(cx, cy, r0 + (R - r0) * Math.sqrt(f), 0, TAU);
      ctx.strokeStyle = COLORS.ringFaint;
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    if (T > n || n === 0) {
      ctx.save();
      ctx.setLineDash([2, 5]);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.strokeStyle = COLORS.ring;
      ctx.stroke();
      ctx.restore();
    }

    // stems (with leaflets along them, so limbs read as vines), then the
    // leaf cluster at each problem on top
    const vis = L.nodes.slice(0, upto);
    ctx.lineCap = 'round';
    for (const nd of vis) {
      const hi = hover && (hover === nd || hover.slug === nd.slug);
      const cr = nd.pr + (nd.r - nd.pr) * 0.55;
      const qx = cx + Math.cos(nd.ang) * cr, qy = cy + Math.sin(nd.ang) * cr;
      ctx.beginPath();
      ctx.moveTo(nd.px, nd.py);
      ctx.quadraticCurveTo(qx, qy, nd.x, nd.y);
      ctx.strokeStyle = hi ? COLORS.stemHi : COLORS.stem;
      ctx.lineWidth = hi ? 1.4 : 1;
      ctx.stroke();

      const len = Math.hypot(nd.x - nd.px, nd.y - nd.py);
      const steps = Math.floor(len / 13);
      for (let i = 1; i < steps; i++) {
        const t = i / steps, u = 1 - t;
        const x = u * u * nd.px + 2 * u * t * qx + t * t * nd.x;
        const y = u * u * nd.py + 2 * u * t * qy + t * t * nd.y;
        const dx = 2 * u * (qx - nd.px) + 2 * t * (nd.x - qx);
        const dy = 2 * u * (qy - nd.py) + 2 * t * (nd.y - qy);
        const side = (i + nd.k) % 2 ? 1 : -1;
        drawLeaf(ctx, x, y, Math.atan2(dy, dx) + side * 0.95, 3.2 + 1.6 * t, COLORS.leaflet, false);
      }
    }
    for (const nd of vis) {
      const out = Math.atan2(nd.y - nd.py, nd.x - nd.px);
      const color = COLORS[nd.tone];
      const grow = hover === nd ? 1.3 : 1;
      const glow = nd.tone === 'today';
      // a small fan: centre leaf plus one or two side leaves (hard = three)
      drawLeaf(ctx, nd.x, nd.y, out, nd.size * grow, color, glow);
      drawLeaf(ctx, nd.x, nd.y, out + 0.75, nd.size * 0.7 * grow, color, glow);
      if (nd.difficulty !== 'Easy') drawLeaf(ctx, nd.x, nd.y, out - 0.75, nd.size * 0.7 * grow, color, glow);
      if (nd.isDue) {
        ctx.beginPath();
        ctx.arc(nd.x, nd.y, 3.4, 0, TAU);
        ctx.strokeStyle = COLORS.due;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    // topic labels just outside the goal ring
    ctx.font = '10.5px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
    ctx.fillStyle = COLORS.label;
    ctx.textBaseline = 'middle';
    for (const s of L.sectors) {
      if (s.span < 0.22) continue;
      const lx = cx + Math.cos(s.mid) * (R + 22), ly = cy + Math.sin(s.mid) * (R + 22);
      ctx.textAlign = Math.abs(Math.cos(s.mid)) < 0.3 ? 'center' : Math.cos(s.mid) > 0 ? 'left' : 'right';
      ctx.fillText(`${LABEL[s.topic] || s.topic.replace(/-/g, ' ')} ${s.count}`, lx, ly);
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
      pace += p.remaining === 0 ? ' · done 🎉'
        : p.daysLeft === 0 ? ' · due today'
        : ` · ${p.perDay < 1 ? `1 every ${Math.round(1 / p.perDay)}d` : `${p.perDay.toFixed(1)}/day`} for ${p.daysLeft}d`;
    }
    root.querySelector('.growth-pace').textContent = pace;
  }

  function nodeAt(mx, my) {
    let best = null, bd = 14;
    for (const nd of L.nodes.slice(0, shown)) {
      const d = Math.hypot(nd.x - mx, nd.y - my);
      if (d < bd) { bd = d; best = nd; }
    }
    return best;
  }
  canvas.addEventListener('mousemove', (e) => {
    if (!L) return;
    const rect = canvas.getBoundingClientRect();
    const nd = nodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (nd !== hover) { hover = nd; draw(shown); }
    canvas.style.cursor = nd ? 'pointer' : 'default';
    if (!nd) { tip.hidden = true; return; }
    const when = new Date(nd.t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    tip.textContent = '';
    const b = document.createElement('b'); b.textContent = nd.title;
    const meta = document.createElement('span');
    meta.textContent = [LABEL[nd._topic] || nd._topic.replace(/-/g, ' '), nd.difficulty].filter(Boolean).join(' · ');
    const line = document.createElement('span');
    line.textContent = `solved ${when} · ${nd.reviews} review${nd.reviews === 1 ? '' : 's'}${nd.isDue ? ' · due' : ''}`;
    tip.append(b, meta, line);
    tip.hidden = false;
    const x = nd.x + 14, y = nd.y - 10;
    tip.style.left = `${Math.min(x, size - 220)}px`;
    tip.style.top = `${Math.max(0, y)}px`;
  });
  canvas.addEventListener('mouseleave', () => { hover = null; tip.hidden = true; draw(shown); });
  canvas.addEventListener('click', () => { if (hover && onOpen) onOpen(hover); });

  let rt = 0;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (!view) return; resize(); L = layout(view.problems, { size, target: view.progress.target, now: view.now }); shown = L.nodes.length; draw(shown); }, 120);
  });

  return {
    update(v) {
      const same = view && v.goal?.id === view.goal?.id && v.problems.length === view.problems.length;
      view = v;
      resize();
      L = layout(v.problems.map(p => ({ ...p })), { size, target: v.progress.target, now: v.now });
      setHub();
      if (same) { shown = L.nodes.length; draw(shown); } else animate();
    },
  };
}
