/**
 * Every SQLite statement one request runs, with timings: boots the built server on a copy of the perf seed with
 * MEDIAMAX_PERF_SLOW_MS=0 and calls the given API path twice (cold, then warm).
 *
 *   node scripts/perf/trace.mjs /home [--admin] [--restricted]
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootServer } from '../screenshots/lib/server.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const apiPath = process.argv[2] ?? '/home';
const cacheRoot = arg('cache', path.join(os.tmpdir(), 'mediamax-perf'));
const pristine = path.join(cacheRoot, `seed-${arg('scale', '1')}`);
const work = path.join(cacheRoot, 'trace');
fs.rmSync(work, { recursive: true, force: true });
fs.cpSync(pristine, work, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(work, 'perf-manifest.json'), 'utf8'));
const tok = process.argv.includes('--admin') ? manifest.tokens.find((t) => t.admin) : manifest.tokens.find((t) => !t.admin && (process.argv.includes('--restricted') ? t.restricted : !t.restricted));
const server = await bootServer({ repo: path.resolve(arg('repo', repo)), data: work, env: { MEDIAMAX_PERF: '1', MEDIAMAX_PERF_SLOW_MS: '0' } });
try {
  for (const pass of ['cold', 'warm']) {
    const before = server.log.length;
    const t = performance.now();
    const res = await fetch(`${server.base}/api/v1${apiPath}`, { headers: { Authorization: `Bearer ${tok.token}` } });
    await res.arrayBuffer();
    const ms = performance.now() - t;
    const lines = [...server.log.slice(before).matchAll(/slow query ([\d.]+)ms: (.*)/g)].map((m) => [Number(m[1]), m[2]]);
    const agg = new Map();
    for (const [d, sql] of lines) {
      const k = sql.slice(0, 150);
      const e = agg.get(k) ?? { n: 0, ms: 0 };
      e.n++;
      e.ms += d;
      agg.set(k, e);
    }
    console.log(`\n== ${pass}: ${res.status} in ${ms.toFixed(1)}ms, ${lines.length} statements, ${lines.reduce((a, l) => a + l[0], 0).toFixed(1)}ms in SQLite`);
    for (const [k, e] of [...agg].sort((a, b) => b[1].ms - a[1].ms).slice(0, 25)) console.log(`${String(e.n).padStart(4)}× ${e.ms.toFixed(1).padStart(7)}ms  ${k}`);
  }
} finally {
  await server.stop();
  fs.rmSync(work, { recursive: true, force: true });
}
