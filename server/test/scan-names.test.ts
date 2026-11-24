// Library scans skip (and report) files whose names aren't valid UTF-8; valid Unicode names still import.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const { scanLibrary, toLibrary } = await import('../src/services/scanner.ts');
const { recentLogLines } = await import('../src/util/log.ts');
const { displayName, isValidUtf8Name } = await import('../src/util/fsnames.ts');

test('name helpers: strict UTF-8 check and log-safe rendering', () => {
  assert.equal(isValidUtf8Name(Buffer.from('Café 日本 🎬.mkv')), true);
  assert.equal(isValidUtf8Name(Buffer.from([0x43, 0x61, 0x66, 0xe9])), false, 'latin-1 é');
  assert.equal(isValidUtf8Name(Buffer.from([0xc0, 0xaf])), false, 'overlong /');
  assert.equal(isValidUtf8Name(Buffer.from([0xed, 0xa0, 0x80])), false, 'surrogate');
  assert.equal(displayName(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x2e, 0x6d, 0x70, 0x34])), 'Caf\\xe9.mp4');
  assert.equal(displayName(Buffer.concat([Buffer.from('日本'), Buffer.from([0x82, 0xa0]), Buffer.from('\n.mp4')])), '日本\\x82\\xa0\\x0a.mp4');
});

test('a scan skips, logs and reports files with non-UTF-8 names and imports valid Unicode names', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-names-'));
  const sample = path.join(root, 'sample.mp4');
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=1', '-pix_fmt', 'yuv420p', sample]).status, 0);
  const media = fs.readFileSync(sample);
  fs.rmSync(sample);
  const good = ['Café crème.mp4', '東京物語.mp4', 'Party 🎉.mp4'];
  for (const n of good) fs.writeFileSync(path.join(root, n), media);
  // Linux allows any bytes in names: cp1252 "Caf\xe9.mp4", Shift-JIS "\x82\xa0.mp4", and a cp437 folder with a file.
  const rootBuf = Buffer.from(root + path.sep);
  fs.writeFileSync(Buffer.concat([rootBuf, Buffer.from('Caf'), Buffer.from([0xe9]), Buffer.from('.mp4')]), media);
  fs.writeFileSync(Buffer.concat([rootBuf, Buffer.from([0x82, 0xa0]), Buffer.from('.mp4')]), media);
  fs.writeFileSync(Buffer.concat([rootBuf, Buffer.from([0x82, 0xa0]), Buffer.from('.txt')]), 'not media: not reported');
  const badDir = Buffer.concat([rootBuf, Buffer.from('Se'), Buffer.from([0x84]), Buffer.from('nce')]);
  fs.mkdirSync(badDir);
  fs.writeFileSync(Buffer.concat([badDir, Buffer.from('/clip.mp4')]), media);

  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('names-lib', 'Clips', 'videos', ?, 0, '2026-01-01')", JSON.stringify([root]));
  await scanLibrary('names-lib');

  const paths = db.all<{ path: string }>("SELECT m.path FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = 'names-lib'").map((r) => r.path);
  assert.deepEqual(paths.map((p) => path.basename(p)).sort(), [...good].sort(), 'only the valid names were imported');
  for (const p of paths) assert.ok(fs.existsSync(p), `stored path exists: ${p}`);

  const lib = toLibrary(db.get("SELECT * FROM libraries WHERE id = 'names-lib'")!);
  assert.equal(lib.skippedNames?.count, 3);
  const shown = lib.skippedNames!.paths.map((p) => p.path.slice(root.length + 1)).sort();
  assert.deepEqual(shown, ['Caf\\xe9.mp4', 'Se\\x84nce/', '\\x82\\xa0.mp4'].sort());
  assert.equal(lib.skippedNames!.paths.find((p) => p.files)?.files, 1, 'the skipped folder counts its media file');

  const logs = recentLogLines(200).filter((l) => l.includes('[WARN]') && l.includes('not valid UTF-8'));
  assert.equal(logs.length, 3, logs.join('\n'));
  assert.ok(logs.some((l) => l.includes('Caf\\xe9.mp4')));
  assert.ok(!logs.some((l) => l.includes('�')), 'invalid bytes are escaped, not replaced');

  // Renaming the files clears the report on the next scan.
  for (const n of fs.readdirSync(root, { encoding: 'buffer' })) if (!isValidUtf8Name(n)) fs.rmSync(Buffer.concat([rootBuf, n]), { recursive: true });
  await scanLibrary('names-lib');
  assert.equal(toLibrary(db.get("SELECT * FROM libraries WHERE id = 'names-lib'")!).skippedNames, null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('a large number of skipped names is summarised in the log and capped in the report', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-names-many-'));
  const rootBuf = Buffer.from(root + path.sep);
  for (let i = 0; i < 250; i++) fs.writeFileSync(Buffer.concat([rootBuf, Buffer.from(`f${i}`), Buffer.from([0xff]), Buffer.from('.mkv')]), 'x');
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('names-many', 'Many', 'videos', ?, 0, '2026-01-01')", JSON.stringify([root]));
  const before = recentLogLines(2000).length;
  await scanLibrary('names-many');
  const logs = recentLogLines(2000).slice(before).filter((l) => l.includes('Library "Many"') && l.includes('not valid UTF-8'));
  assert.equal(logs.length, 11, 'ten one by one, then one summary');
  assert.match(logs.at(-1)!, /240 more/);
  const lib = toLibrary(db.get("SELECT * FROM libraries WHERE id = 'names-many'")!);
  assert.equal(lib.skippedNames?.count, 250);
  assert.equal(lib.skippedNames?.paths.length, 200);
  fs.rmSync(root, { recursive: true, force: true });
});

/** A tiny real video, copied wherever a test needs media files. */
function sampleClip(dir: string): Buffer {
  const f = path.join(dir, '.sample.mp4');
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x120:d=1', '-pix_fmt', 'yuv420p', f]).status, 0);
  const b = fs.readFileSync(f);
  fs.rmSync(f);
  return b;
}

test('movies: a shared (collection) folder holds separate movies; a movie\'s own folder groups its versions', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-movies-'));
  const media = sampleClip(root);
  const put = (rel: string) => (fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }), fs.writeFileSync(path.join(root, rel), media));
  put('Marvel/Iron Man (2008).mp4');
  put('Marvel/Thor (2011).mp4');
  put('Movie (2010)/Movie (2010) - 1080p.mkv');
  put('Movie (2010)/Movie (2010) - 4K.mkv');
  put('Avatar/Avatar (2009) - 1080p.mkv');
  put('Avatar/Avatar (2009) - 4K.mkv');
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('mov-lib', 'Movies', 'movies', ?, 0, '2026-01-01')", JSON.stringify([root]));
  await scanLibrary('mov-lib');
  const items = db.all<{ title: string; year: number; n: number }>("SELECT i.title, i.year, (SELECT COUNT(*) FROM media m WHERE m.item_id = i.id) n FROM items i WHERE i.library_id = 'mov-lib' AND i.type = 'movie' ORDER BY i.title");
  assert.deepEqual(items.map((i) => ({ ...i })), [
    { title: 'Avatar', year: 2009, n: 2 },
    { title: 'Iron Man', year: 2008, n: 1 },
    { title: 'Movie', year: 2010, n: 2 },
    { title: 'Thor', year: 2011, n: 1 },
  ]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('symlinked folders are followed, but a symlink loop (or a second link to a folder) imports each file once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-loop-'));
  fs.writeFileSync(path.join(root, 'clip.mp4'), sampleClip(root));
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-loop-other-'));
  fs.writeFileSync(path.join(other, 'linked.mp4'), fs.readFileSync(path.join(root, 'clip.mp4')));
  fs.symlinkSync(root, path.join(root, 'loop'));
  fs.mkdirSync(path.join(root, 'sub'));
  fs.symlinkSync(root, path.join(root, 'sub', 'back'));
  fs.symlinkSync(other, path.join(root, 'ext1'));
  fs.symlinkSync(other, path.join(root, 'ext2'));
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('loop-lib', 'Clips', 'videos', ?, 0, '2026-01-01')", JSON.stringify([root]));
  await scanLibrary('loop-lib');
  const names = db.all<{ path: string }>("SELECT m.path FROM media m JOIN items i ON i.id = m.item_id WHERE i.library_id = 'loop-lib'").map((r) => path.basename(r.path));
  assert.deepEqual(names.sort(), ['clip.mp4', 'linked.mp4'], 'each file once; the linked folder outside the library is still followed');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(other, { recursive: true, force: true });
});
