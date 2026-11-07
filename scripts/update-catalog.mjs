#!/usr/bin/env node
// Refresh the bundled problem-catalog snapshot (extension/data/catalog.json).
//
// The extension ships this snapshot so "Next up" works the instant it's
// installed; the background worker then refreshes it from LeetCode weekly.
// Without it, the first run waited ~30s on 42 sequential GraphQL pages.
//
//   node scripts/update-catalog.mjs
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fetchCatalog } from '../extension/lib/leetcode-api.js';

const out = fileURLToPath(new URL('../extension/data/catalog.json', import.meta.url));
const t = Date.now();
const rows = await fetchCatalog();
if (rows.length < 1000) throw new Error(`suspiciously small catalog (${rows.length}); not writing`);
writeFileSync(out, JSON.stringify({ fetchedAt: Date.now(), rows }));
console.log(`wrote ${rows.length} problems to ${out} in ${((Date.now() - t) / 1000).toFixed(1)}s`);
