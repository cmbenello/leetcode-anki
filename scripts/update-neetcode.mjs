#!/usr/bin/env node
// Refresh the bundled NeetCode list (extension/data/neetcode.json).
//
// NeetCode's practice tables live in its public JS bundles as rows like
//   {problem:"Two Sum", pattern:"Arrays & Hashing", link:"two-sum/", ...,
//    neetcode150:!0, blind75:!0, neetcode250:!0, ncLink:"two-integer-sum/"}
// `link` is the LeetCode slug (NeetCode stores your completed problems by it);
// `ncLink` is NeetCode's own problem page. We keep both plus list membership.
//
//   node scripts/update-neetcode.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BASE = 'https://neetcode.io';
const out = fileURLToPath(new URL('../extension/data/neetcode.json', import.meta.url));
const html = await (await fetch(`${BASE}/practice`)).text();
const scripts = [...html.matchAll(/src="([^"]+\.js)"/g)].map(m => m[1]);
let code = '';
for (const s of scripts) code += await (await fetch(new URL(s, BASE))).text();
// lazy chunks referenced from runtime.js: "<id>:"<hash>"" pairs -> <id>.<hash>.js
const runtime = scripts.find(s => s.includes('runtime'));
if (runtime) {
  const rt = await (await fetch(new URL(runtime, BASE))).text();
  const chunks = [...rt.matchAll(/(\d+):"([0-9a-f]{16})"/g)].map(m => `${m[1]}.${m[2]}.js`);
  for (const c of chunks) {
    try { code += await (await fetch(`${BASE}/${c}`)).text(); } catch { /* optional chunk */ }
  }
}
const rows = new Map();
for (const m of code.matchAll(/\{problem:"([^"]+)",pattern:"([^"]+)",link:"([^"]+)"([^}]*)\}/g)) {
  const [, title, pattern, link, rest] = m;
  const s = link.replace(/\/$/, '');
  if (!/^[a-z0-9-]+$/.test(s)) continue;
  const nc = (rest.match(/ncLink:"([^"]+)"/) || [])[1]?.replace(/\/$/, '') || null;
  const f = (/neetcode150:!0/.test(rest) ? 1 : 0) | (/neetcode250:!0/.test(rest) ? 2 : 0) | (/blind75:!0/.test(rest) ? 4 : 0);
  const prev = rows.get(s);
  rows.set(s, { s, t: title, p: pattern, n: nc || prev?.n || null, f: (prev?.f || 0) | f });
}
const list = [...rows.values()];
const count = (bit) => list.filter(r => r.f & bit).length;
if (count(1) < 140 || count(2) < 240) throw new Error(`unexpected list sizes: nc150=${count(1)} nc250=${count(2)}; not writing`);
writeFileSync(out, JSON.stringify({ fetchedAt: Date.now(), rows: list }));
console.log(`wrote ${list.length} problems (NeetCode 150: ${count(1)}, NeetCode 250: ${count(2)}, Blind 75: ${count(4)}, with NeetCode page: ${list.filter(r => r.n).length}) to ${out}`);
