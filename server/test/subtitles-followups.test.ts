// Subtitle caches and conversions: a replaced sidecar is re-converted, a failing rename settles the conversion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { subtitleVtt } = await import('../src/services/playback.ts');
const { extractSubtitle, sidecarStamp } = await import('../src/services/subtitles.ts');
const { pruneSubtitleCache } = await import('../src/services/tasks.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-subfu-'));
const srt = (text: string) => `1\n00:00:01,000 --> 00:00:02,000\n${text}\n\n`;
let n = 0;
function media(sidecar: string, mtime = 1700): string {
  const id = `subfu-${++n}`;
  db.run("INSERT INTO items (id, type, title, sort_title, added_at, updated_at) VALUES (?, 'movie', 'S', 's', '2026', '2026')", id);
  db.run('INSERT INTO media (id, item_id, path, mtime, subs) VALUES (?, ?, ?, ?, ?)', `${id}-m`, id, path.join(dir, `${id}.mkv`), mtime,
    JSON.stringify([{ index: 100, codec: 'subrip', language: 'eng', title: null, default: false, forced: false, external: true, path: sidecar }]));
  return `${id}-m`;
}
/** Rewrite a sidecar with different content and a later mtime (as a user replacing the file would). */
function replace(file: string, text: string, at: number) {
  fs.writeFileSync(file, srt(text));
  fs.utimesSync(file, at, at);
}

test('a replaced sidecar .srt is converted again (WebVTT for players, raw extraction)', async () => {
  const side = path.join(dir, 'movie.en.srt');
  replace(side, 'First version', 1_700_000_000);
  const id = media(side);
  const v1 = await subtitleVtt(id, 100);
  assert.match(fs.readFileSync(v1, 'utf8'), /First version/);
  const e1 = await extractSubtitle(id, 100, 'vtt').done;
  assert.match(fs.readFileSync(e1, 'utf8'), /First version/);

  replace(side, 'Second, longer version', 1_700_000_100); // the media file itself is unchanged (same mtime)
  const v2 = await subtitleVtt(id, 100);
  assert.notEqual(v2, v1);
  assert.match(fs.readFileSync(v2, 'utf8'), /Second, longer version/);
  const e2 = await extractSubtitle(id, 100, 'vtt').done;
  assert.notEqual(e2, e1);
  assert.match(fs.readFileSync(e2, 'utf8'), /Second, longer version/);
  // Unchanged sidecar: cache hit.
  assert.equal(await subtitleVtt(id, 100), v2);

  // The cleanup task drops the copies of the old sidecar version, keeps the current ones.
  const cache = path.join(config.cacheDir, 'subs');
  const mine = () => fs.readdirSync(cache).filter((f) => f.startsWith(`${id}_`)).sort();
  assert.equal(mine().length, 2, 'one .vtt per sidecar version (shared by both paths)');
  pruneSubtitleCache();
  assert.deepEqual(mine(), [path.basename(v2)]);
  assert.ok(path.basename(v2).includes(sidecarStamp({ external: true, path: side })));
  assert.equal(sidecarStamp({ external: false, path: side }), '', 'embedded tracks keep the plain key');
});

test('a conversion whose result cannot be moved into place rejects instead of hanging', async (tt) => {
  const side = path.join(dir, 'other.en.srt');
  replace(side, 'Hello', 1_700_000_000);
  const id = media(side);
  // An "ffmpeg" that writes its output, but something already sits where the result goes: the rename in the exit
  // handler throws (it used to be an uncaught exception, leaving the promise pending forever).
  const fake = path.join(dir, 'fake-ffmpeg.sh');
  fs.writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\n: > "$last"\nf="${last%.part}"; f="${f%.tmp}"\nmkdir -p "$f/blocker"\nexit 0\n', { mode: 0o755 });
  const real = config.ffmpeg;
  config.ffmpeg = fake;
  tt.after(() => (config.ffmpeg = real));
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => uncaught.push(e);
  process.on('uncaughtException', onUncaught);
  tt.after(() => process.off('uncaughtException', onUncaught));
  const timeout = (ms: number) => new Promise((_r, rej) => setTimeout(() => rej(new Error('never settled')), ms).unref());
  await assert.rejects(Promise.race([subtitleVtt(id, 100), timeout(5000)]), /EISDIR|ENOTEMPTY|EEXIST|EPERM/);
  const cache = path.join(config.cacheDir, 'subs');
  const clear = () => {
    for (const f of fs.readdirSync(cache)) if (f.startsWith(`${id}_`)) fs.rmSync(path.join(cache, f), { recursive: true, force: true });
  };
  clear();
  const ex = extractSubtitle(id, 100, 'vtt');
  await assert.rejects(Promise.race([ex.done, timeout(5000)]), /EISDIR|ENOTEMPTY|EEXIST|EPERM/);
  assert.ok(ex.failed);
  assert.deepEqual(uncaught, []);
  assert.deepEqual(fs.readdirSync(cache).filter((f) => f.startsWith(`${id}_`) && /\.(tmp|part)$/.test(f)), [], 'temporary output removed');
  // With the blockers gone and the real ffmpeg back, the next request converts normally (nothing stuck in flight).
  clear();
  config.ffmpeg = real;
  assert.match(fs.readFileSync(await subtitleVtt(id, 100), 'utf8'), /Hello/);
  assert.match(fs.readFileSync(await extractSubtitle(id, 100, 'vtt').done, 'utf8'), /Hello/);
});
