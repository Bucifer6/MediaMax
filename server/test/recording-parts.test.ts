// DVR: a recording resumed after a restart is saved as one file (parts joined, gap noted); when joining fails nothing
// is lost and the leftover part is tracked and deleted with the recording; parts left by older versions are found.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { updateSettings, getSettings } = await import('../src/services/settings.ts');
const { createUser } = await import('../src/services/auth.ts');
const { finishRecording, attachLegacyOrphanParts, listRecordings, cancelRecording, tick, stopActiveRecordings } = await import('../src/services/dvr.ts');
const { bus } = await import('../src/services/events.ts');

const recRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rec-parts-'));
updateSettings({ dvr: { ...getSettings().dvr, recordingsPath: recRoot, commercialDetection: false } } as any);
const admin = createUser({ username: 'dvradmin', password: 'pw-123456', isAdmin: true });
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-rec-src-'));

/** A small MPEG-TS clip (> 100 KB, the minimum for a part to count) with H.264 video + AAC audio. */
function makeTs(file: string, seconds: number, freq = 440) {
  const r = spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `testsrc2=s=320x240:r=25:d=${seconds}`, '-f', 'lavfi', '-i', `sine=f=${freq}:d=${seconds}`,
    '-shortest', '-pix_fmt', 'yuv420p', '-c:v', 'libx264', '-b:v', '1M', '-c:a', 'aac', '-f', 'mpegts', file]);
  assert.equal(r.status, 0, String(r.stderr));
  assert.ok(fs.statSync(file).size > 100_000);
}
function duration(file: string): number {
  const r = spawnSync(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(String(r.stdout).trim());
}
const t = (min: number) => new Date(Date.parse('2026-03-01T20:00:00Z') + min * 60000).toISOString();

function insertRecording(id: string, title: string, fields: Record<string, unknown>) {
  db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, created_by, created_at) VALUES (?, 'ch', 'Channel', ?, ?, ?, 'recording', ?, ?)",
    id, title, t(0), t(30), admin.id, t(0));
  for (const [k, v] of Object.entries(fields)) db.run(`UPDATE recordings SET ${k} = ? WHERE id = ?`, v as any, id);
}
const rec = (id: string) => listRecordings(admin).find((r) => r.id === id)!;
const row = (id: string) => db.get('SELECT * FROM recordings WHERE id = ?', id)!;

test('two parts are joined into one file, the parts removed, the gap noted and the file imported', async () => {
  const dir = path.join(recRoot, 'Evening News');
  fs.mkdirSync(dir, { recursive: true });
  const p1 = path.join(dir, 'Evening News (2026-03-01 2000).ts');
  const p2 = path.join(dir, 'Evening News (2026-03-01 2000) - part 2.ts');
  makeTs(p1, 3);
  makeTs(p2, 2, 880);
  const parts = [{ path: p1, startedAt: t(0), endedAt: t(10) }, { path: p2, startedAt: t(14), endedAt: t(30) }];
  insertRecording('rec-join', 'Evening News', { path: p2, parts: JSON.stringify(parts) });
  let completed = 0;
  bus.on('recording.completed', () => completed++);

  await finishRecording('rec-join', 0, '');

  const r = row('rec-join');
  assert.equal(r.status, 'completed');
  assert.equal(r.path, p1, 'the recording keeps its normal name');
  assert.ok(fs.existsSync(p1));
  assert.ok(!fs.existsSync(p2), 'part 2 was removed after joining');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('.')), [], 'no temporary files left');
  assert.ok(Math.abs(duration(p1) - 5) < 0.5, `joined duration ${duration(p1)}`);
  assert.equal(r.parts, null);
  assert.equal(r.leftover_parts, null);
  assert.equal(r.size_bytes, fs.statSync(p1).size);
  const api = rec('rec-join');
  assert.equal(api.gapSeconds, 240, 'interrupted for 4 minutes');
  assert.deepEqual(api.leftoverParts, []);
  assert.ok(api.itemId, 'imported into the Recordings library');
  assert.equal(db.get('SELECT path FROM media WHERE item_id = ?', api.itemId)!.path, p1);
  assert.equal(db.get<{ n: number }>('SELECT COUNT(*) n FROM media WHERE path = ?', p2)!.n, 0);
  assert.equal(completed, 1);
});

test('when the parts cannot be joined nothing is lost: the leftover is tracked, shown and deleted with the recording', async () => {
  const dir = path.join(recRoot, 'Film');
  fs.mkdirSync(dir, { recursive: true });
  const p1 = path.join(dir, 'Film (2026-03-01 2000).ts');
  const p2 = path.join(dir, 'Film (2026-03-01 2000) - part 2.ts');
  makeTs(p1, 3);
  // A damaged part (not a readable stream).
  fs.writeFileSync(p2, Buffer.alloc(300_000, 0x5a));
  const p1Size = fs.statSync(p1).size;
  insertRecording('rec-bad', 'Film', { path: p2, parts: JSON.stringify([{ path: p1, startedAt: t(0), endedAt: t(5) }, { path: p2, startedAt: t(7) }]) });

  await finishRecording('rec-bad', 0, '');

  const r = row('rec-bad');
  assert.equal(r.status, 'completed');
  assert.ok(fs.existsSync(p1) && fs.existsSync(p2), 'both parts are still on disk');
  assert.equal(fs.statSync(p1).size, p1Size, 'part 1 untouched');
  assert.equal(fs.statSync(p2).size, 300_000, 'part 2 untouched');
  assert.equal(r.path, p1, 'the readable part is the recording');
  assert.deepEqual(JSON.parse(r.leftover_parts), [p2]);
  const api = rec('rec-bad');
  assert.equal(api.gapSeconds, 120);
  assert.deepEqual(api.leftoverParts, [{ name: path.basename(p2), sizeBytes: 300_000 }]);

  // Deleting the recording deletes every part, and library items made from them.
  await import('../src/services/scanner.ts').then((s) => s.scanLibrary(db.get("SELECT id FROM libraries WHERE name = 'Recordings'")!.id));
  assert.ok(db.get('SELECT 1 FROM media WHERE path = ?', p2), 'the leftover part stays visible in the library meanwhile');
  cancelRecording(admin, 'rec-bad');
  assert.ok(!fs.existsSync(p1) && !fs.existsSync(p2));
  assert.equal(db.get('SELECT 1 FROM recordings WHERE id = ?', 'rec-bad'), undefined);
  assert.equal(db.get('SELECT 1 FROM media WHERE path IN (?, ?)', p1, p2), undefined);
});

test('a recording resumed after a restart records a new part and joins it when the programme ends', async (tt) => {
  // The "channel": an HTTP server sending a short TS clip (ffmpeg stops at its end, like a programme ending).
  const clip = path.join(work, 'live.ts');
  makeTs(clip, 2, 660);
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/mp2t', 'content-length': fs.statSync(clip).size });
    fs.createReadStream(clip).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  tt.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/live.ts`;
  db.run("INSERT INTO live_sources (id, name, type, url, created_at) VALUES ('src-rp', 'Src', 'm3u', 'http://x', ?)", t(0));
  db.run("INSERT INTO channels (id, source_id, remote_id, name, stream_url) VALUES ('ch-rp', 'src-rp', '1', 'Chan', ?)", url);

  // State after a restart: still 'recording', the first part on disk, no ffmpeg (rows from before parts were tracked
  // only have `path`).
  const start = new Date(Date.now() - 10 * 60000).toISOString();
  const end = new Date(Date.now() + 20 * 60000).toISOString();
  const stamp = start.slice(0, 16).replace('T', ' ').replace(':', '');
  const p1 = path.join(recRoot, 'Quiz', `Quiz (${stamp}).ts`);
  fs.mkdirSync(path.dirname(p1), { recursive: true });
  makeTs(p1, 3);
  fs.utimesSync(p1, new Date(Date.now() - 5 * 60000), new Date(Date.now() - 5 * 60000));
  db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, path, created_by, created_at) VALUES ('rec-res', 'ch-rp', 'Chan', 'Quiz', ?, ?, 'recording', ?, ?, ?)",
    start, end, p1, admin.id, start);

  const done = new Promise<void>((resolve) => bus.on('recording.completed', (r: any) => r.id === 'rec-res' && resolve()));
  await tick();
  const during = row('rec-res');
  const parts = JSON.parse(during.parts);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].path, p1);
  assert.equal(parts[1].path, p1.replace(/\.ts$/, ' - part 2.ts'));
  await done;

  const r = row('rec-res');
  assert.equal(r.status, 'completed');
  assert.equal(r.path, p1);
  assert.deepEqual(fs.readdirSync(path.dirname(p1)), [path.basename(p1)], 'one file, parts removed');
  assert.ok(Math.abs(duration(p1) - 5) < 0.6, `joined duration ${duration(p1)}`);
  assert.ok(r.gap_seconds >= 290 && r.gap_seconds <= 320, `gap ${r.gap_seconds}`);
  assert.equal(r.title, 'Quiz', 'no "(resumed)" in the title');
});

test('parts left by older versions ("(resumed)" files) are attached to their recording; unrelated files are not', () => {
  const stamp = '2026-02-01 1800';
  const orig = path.join(recRoot, 'Match', `Match (${stamp}).ts`);
  const resumedDir = path.join(recRoot, 'Match (resumed)');
  const resumed = path.join(resumedDir, `Match (resumed) (${stamp}).ts`);
  const unrelated = path.join(recRoot, 'Match', `Match (2026-02-08 1800).ts`);
  for (const f of [orig, resumed, unrelated]) fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, 'x');
  db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, path, created_by, created_at) VALUES ('rec-old', 'ch', 'C', 'Match', ?, ?, 'completed', ?, ?, ?)",
    '2026-02-01T18:00:00.000Z', '2026-02-01T20:00:00.000Z', resumed, admin.id, t(0));
  attachLegacyOrphanParts();
  attachLegacyOrphanParts(); // idempotent
  assert.deepEqual(JSON.parse(row('rec-old').leftover_parts), [orig]);
  assert.deepEqual(rec('rec-old').leftoverParts?.map((p) => p.name), [path.basename(orig)]);
  cancelRecording(admin, 'rec-old');
  assert.ok(!fs.existsSync(orig) && !fs.existsSync(resumed));
  assert.ok(fs.existsSync(unrelated), 'a file that cannot be attributed is left alone');
});

/** Schedule a recording on a channel with this stream URL that is due now, run the scheduler, wait until it failed. */
async function recordUntilFailed(id: string, streamUrl: string) {
  db.run("INSERT OR IGNORE INTO live_sources (id, name, type, url, created_at) VALUES ('src-fail', 'Src', 'm3u', 'http://x', ?)", t(0));
  db.run("INSERT INTO channels (id, source_id, remote_id, name, stream_url) VALUES (?, 'src-fail', ?, 'Chan', ?)", `ch-${id}`, id, streamUrl);
  db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, created_by, created_at) VALUES (?, ?, 'Chan', ?, ?, ?, 'scheduled', ?, ?)",
    id, `ch-${id}`, `Show ${id}`, new Date(Date.now() - 60000).toISOString(), new Date(Date.now() + 20 * 60000).toISOString(), admin.id, t(0));
  const failed = new Promise<void>((resolve) => bus.on('recording.failed', (r: any) => r.id === id && resolve()));
  await tick();
  await failed;
  return row(id);
}

test('HTTP-only reconnect options are passed for http(s) channels only (not rtsp/udp/rtp, where ffmpeg rejects them)', async (tt) => {
  // A stand-in ffmpeg that records its arguments and fails.
  const fake = path.join(work, 'fake-ffmpeg.sh');
  const argsFile = path.join(work, 'args.txt');
  fs.writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${argsFile}"\nexit 1\n`, { mode: 0o755 });
  const real = config.ffmpeg;
  config.ffmpeg = fake;
  tt.after(() => (config.ffmpeg = real));
  for (const [id, url, wantReconnect] of [['rec-rtsp', 'rtsp://192.0.2.1:554/?src=1&freq=11494', false], ['rec-udp', 'udp://239.0.0.1:1234', false], ['rec-http', 'http://192.0.2.1/live.ts', true]] as const) {
    fs.rmSync(argsFile, { force: true });
    const r = await recordUntilFailed(id, url);
    assert.equal(r.status, 'failed');
    const args = fs.readFileSync(argsFile, 'utf8');
    assert.ok(args.includes(url));
    assert.equal(args.includes('-reconnect'), wantReconnect, `${url}: ${args}`);
  }
});

test('a recording whose ffmpeg cannot be started fails instead of staying "recording" forever', async (tt) => {
  const real = config.ffmpeg;
  config.ffmpeg = path.join(work, 'no-such-ffmpeg');
  tt.after(() => (config.ffmpeg = real));
  const r = await recordUntilFailed('rec-noffmpeg', 'http://192.0.2.1/live.ts');
  assert.equal(r.status, 'failed');
  assert.match(r.error, /ENOENT|Could not run ffmpeg/);
});

after(() => {
  stopActiveRecordings();
  fs.rmSync(recRoot, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});
