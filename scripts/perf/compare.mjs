/**
 * Markdown before/after table from two run.mjs results.
 *
 *   node scripts/perf/compare.mjs scripts/perf/results/before.json scripts/perf/results/after.json [--level=10]
 */
import fs from 'node:fs';

const [a, b] = process.argv.slice(2, 4).map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
const level = Number(process.argv.find((x) => x.startsWith('--level='))?.split('=')[1] ?? 10);
const byName = new Map(b.results.map((r) => [r.name, r]));
const kb = (n) => (n >= 10240 ? `${Math.round(n / 1024)} KB` : `${(n / 1024).toFixed(1)} KB`);
const ms = (n) => (n == null || Number.isNaN(n) ? '–' : n >= 100 ? `${Math.round(n)}` : `${n}`);
const x = (before, after) => (before > 0 && after > 0 ? `${(before / after).toFixed(before / after >= 10 ? 0 : 1)}×` : '');

console.log(`| Endpoint | p50 ms (seq) | p95 ms @${level} | req/s @${level} | SQL statements | Wire size |`);
console.log('|---|---|---|---|---|---|');
for (const r of a.results) {
  const o = byName.get(r.name);
  if (!o) continue;
  const la = r.levels[level] ?? {};
  const lb = o.levels[level] ?? {};
  console.log(`| ${r.name} | ${ms(r.seqP50)} → **${ms(o.seqP50)}** ${x(r.seqP50, o.seqP50)} | ${ms(la.p95)} → **${ms(lb.p95)}** | ${la.rps ?? '–'} → **${lb.rps ?? '–'}** | ${r.queries} → ${o.queries} | ${kb(r.wire)} → ${kb(o.wire)}${o.encoding ? ` (${o.encoding})` : ''} |`);
}
