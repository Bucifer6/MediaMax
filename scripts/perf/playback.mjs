/**
 * Playback start latency: POST /playback → first media bytes, for direct play, remux and transcode.
 *
 *   node scripts/perf/playback.mjs [--label=after] [--runs=5]
 *
 * Generates short test files with ffmpeg (H.264/AAC MP4, H.264/AC-3 MKV, MPEG-2 MKV), scans them into a fresh
 * server, then for each method measures: the POST /playback round trip, and the time until the first segment
 * (HLS: master → media playlist → first segment [+ init]) or the first byte range (direct) has arrived.
 * Writes scripts/perf/results/playback-<label>.json.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bootServer, client, waitFor } from '../screenshots/lib/server.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const label = arg('label', 'run');
const runs = Number(arg('runs', '5'));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-play-'));
const media = path.join(root, 'media');
fs.mkdirSync(media, { recursive: true });

const ff = (args) => execFileSync('ffmpeg', ['-v', 'error', '-y', ...args]);
const src = ['-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=24:d=90', '-f', 'lavfi', '-i', 'sine=f=440:d=90:sample_rate=48000'];
const films = [
  ['Direct Film (2001)', 'mp4', ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-ac', '2', '-movflags', '+faststart']],
  ['Remux Film (2002)', 'mkv', ['-c:v', 'libx264', '-preset', 'veryfast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'ac3', '-ac', '6']],
  ['Transcode Film (2003)', 'mkv', ['-c:v', 'mpeg2video', '-q:v', '4', '-g', '12', '-c:a', 'mp2']],
];
for (const [name, ext, args] of films) {
  const dir = path.join(media, name);
  fs.mkdirSync(dir, { recursive: true });
  ff([...src, ...args, path.join(dir, `${name}.${ext}`)]);
}

const server = await bootServer({ repo: path.resolve(arg('repo', repo)), data: path.join(root, 'data') });
process.on('exit', () => {
  try {
    server.proc.kill('SIGKILL');
  } catch { /* gone */ }
});
const out = { label, date: new Date().toISOString(), runs, results: {} };
try {
  const auth = await client(server.base).post('/setup', { username: 'admin', password: 'perf-admin-pass' });
  const c = client(server.base, auth.token);
  const lib = await c.post('/libraries', { name: 'Films', type: 'movies', paths: [media], fetchMetadata: false });
  await waitFor(async () => (await c.get(`/items?libraryId=${lib.id}&type=movie`)).total === 3 && !(await c.get('/libraries')).some((l) => l.scanning), 60000, 'scan');
  const items = (await c.get(`/items?libraryId=${lib.id}&type=movie`)).items;
  const byTitle = (t) => items.find((i) => i.title.startsWith(t)).id;
  // A browser-like profile: H.264 + AAC/MP3 in MP4, HLS capable.
  const profile = { videoCodecs: ['h264'], audioCodecs: ['aac', 'mp3'], containers: ['mp4', 'm4v', 'mov'], supportsHls: true, maxAudioChannels: 2 };
  const H = { Authorization: `Bearer ${auth.token}` };
  const get = async (u, extra = {}) => {
    const r = await fetch(new URL(u, server.base), { headers: { ...H, ...extra } });
    const b = Buffer.from(await r.arrayBuffer());
    if (!r.ok) throw new Error(`${u} → ${r.status} ${b.toString().slice(0, 200)}`);
    return b;
  };
  for (const [kind, title] of [['direct', 'Direct'], ['remux', 'Remux'], ['transcode', 'Transcode']]) {
    const rows = [];
    for (let k = 0; k < runs; k++) {
      const t0 = performance.now();
      const info = await c.post(`/playback/${byTitle(title)}`, { deviceProfile: profile });
      const tPost = performance.now() - t0;
      if (info.method !== kind) throw new Error(`${title}: expected ${kind}, got ${info.method} (${(info.reasons ?? []).join('; ')})`);
      if (kind === 'direct') {
        await get(info.url, { Range: 'bytes=0-1048575' });
      } else {
        const murl = new URL(info.url, server.base).toString();
        const master = (await get(murl)).toString();
        // A multi-variant master points at a media playlist; a single stream (remux) is the media playlist itself.
        let vurl = murl;
        let pl = master;
        if (!master.includes('#EXTINF')) {
          vurl = new URL(master.split('\n').find((l) => l && !l.startsWith('#')), murl).toString();
          pl = (await get(vurl)).toString();
        }
        const init = pl.match(/#EXT-X-MAP:URI="([^"]+)"/)?.[1];
        const seg = pl.split('\n').find((l) => l && !l.startsWith('#'));
        await Promise.all([init ? get(new URL(init, vurl).toString()) : null, get(new URL(seg, vurl).toString())]);
      }
      const tFirst = performance.now() - t0;
      rows.push({ post: Math.round(tPost), firstMedia: Math.round(tFirst) });
      await c.del(`/playback/sessions/${info.sessionId}`).catch(() => {});
    }
    const med = (k) => [...rows.map((r) => r[k])].sort((a, b) => a - b)[Math.floor(rows.length / 2)];
    out.results[kind] = { postMedianMs: med('post'), firstMediaMedianMs: med('firstMedia'), runs: rows };
    console.log(`${kind.padEnd(10)} POST ${String(med('post')).padStart(5)}ms   first media ${String(med('firstMedia')).padStart(5)}ms   ${rows.map((r) => r.firstMedia).join(', ')}`);
  }
} finally {
  await server.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
const dir = path.join(repo, 'scripts/perf/results');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, `playback-${label}.json`), JSON.stringify(out, null, 1));
