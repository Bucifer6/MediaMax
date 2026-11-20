// QA regressions: numeric settings validation, orphaned karaoke stems cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const { updateSettings, getSettings } = await import('../src/services/settings.ts');
const { pruneOrphanStems } = await import('../src/services/stems.ts');
const { db } = await import('../src/db.ts');
const { scanLibrary } = await import('../src/services/scanner.ts');
const { config } = await import('../src/config.ts');
import { spawnSync } from 'node:child_process';

test('cleared / invalid numeric settings are kept in range instead of breaking playback', () => {
  const s = updateSettings({
    transcoding: { ...getSettings().transcoding, segmentSeconds: 0, maxConcurrent: -3, defaultBitrate: Number(''), preset: 'bogus' as any },
    trickplay: { enabled: true, intervalSeconds: 0, width: 99999 },
    sessionTimeoutDays: 0,
    backups: { intervalDays: -1, keep: 0 },
  } as any);
  assert.equal(s.transcoding.segmentSeconds, 1);
  assert.equal(s.transcoding.maxConcurrent, 1);
  assert.equal(s.transcoding.defaultBitrate, 300);
  assert.equal(s.transcoding.preset, 'veryfast');
  assert.equal(s.trickplay.intervalSeconds, 2);
  assert.equal(s.trickplay.width, 640);
  assert.equal(s.sessionTimeoutDays, 0, '0 = sessions never expire');
  assert.equal(s.backups.intervalDays, 0);
  assert.equal(s.backups.keep, 1);
  // Strings from forms and non-numbers.
  const t = updateSettings({ transcoding: { ...getSettings().transcoding, segmentSeconds: '6' as any, threads: 'x' as any } } as any);
  assert.equal(t.transcoding.segmentSeconds, 6);
  assert.equal(t.transcoding.threads, 0);
});

test('orphaned karaoke stems are pruned; models, onnxruntime and uploads stay', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stems-'));
  for (const d of ['models', 'ort', '.upload-x-1', 'keep1', 'gone1']) fs.mkdirSync(path.join(dir, 'stems', d), { recursive: true });
  const n = pruneOrphanStems((id) => id === 'keep1', dir);
  assert.equal(n, 1);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'stems')).sort(), ['.upload-x-1', 'keep1', 'models', 'ort']);
  assert.equal(pruneOrphanStems(() => true, path.join(dir, 'nope')), 0);
});

test('a library folder that is suddenly empty (unmounted share) does not wipe the library and watch history', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-lib-'));
  const file = path.join(root, 'Artist', 'Album', '01 - Song.flac');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-metadata', 'title=Song', '-metadata', 'artist=Artist', '-metadata', 'album=Album', file]).status, 0);
  db.run("INSERT INTO libraries (id, name, type, paths, fetch_metadata, created_at) VALUES ('qa-lib', 'QA', 'music', ?, 0, '2026-01-01')", JSON.stringify([root]));
  db.run("INSERT INTO users (id, username, display_name, created_at) VALUES ('qa-u', 'qa', 'QA', '2026-01-01')");
  await scanLibrary('qa-lib');
  const track = db.get<{ id: string }>("SELECT id FROM items WHERE library_id = 'qa-lib' AND type = 'track'");
  assert.ok(track, 'track scanned');
  db.run("INSERT INTO user_data (user_id, item_id, played, play_count) VALUES ('qa-u', ?, 1, 3)", track!.id);
  // The share goes away but its mount point stays as an empty folder.
  fs.rmSync(path.join(root, 'Artist'), { recursive: true, force: true });
  await scanLibrary('qa-lib');
  assert.ok(db.get('SELECT 1 FROM items WHERE id = ?', track!.id), 'item kept');
  assert.equal(db.get<{ play_count: number }>("SELECT play_count FROM user_data WHERE user_id = 'qa-u'")?.play_count, 3);
  // A real removal (other files still there) is still picked up.
  const other = path.join(root, 'Other', '01.flac');
  fs.mkdirSync(path.dirname(other), { recursive: true });
  assert.equal(spawnSync(config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=1', '-metadata', 'title=Other', '-metadata', 'artist=Other', other]).status, 0);
  await scanLibrary('qa-lib');
  assert.equal(db.get('SELECT 1 FROM items WHERE id = ?', track!.id), undefined, 'vanished file removed once the folder is back');
});

test('deleting an account removes its (and its profiles\u2019) series rules and scheduled recordings', async () => {
  const { deleteUser } = await import('../src/services/auth.ts');
  const t = '2026-01-01T00:00:00.000Z';
  db.run("INSERT INTO users (id, username, display_name, created_at) VALUES ('qa-acc', 'qa-acc', 'Acc', ?)", t);
  db.run("INSERT INTO users (id, username, display_name, created_at, parent_user_id) VALUES ('qa-kid', 'qa-kid', 'Kid', ?, 'qa-acc')", t);
  for (const [id, by] of [['r1', 'qa-acc'], ['r2', 'qa-kid']]) {
    db.run("INSERT INTO recording_rules (id, title_match, created_by) VALUES (?, 'News', ?)", id, by);
    db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, rule_id, created_by, created_at) VALUES (?, 'c', 'C', 'News', '2099-01-01', '2099-01-02', 'scheduled', ?, ?, ?)", 'rec-' + id, id, by, t);
  }
  db.run("INSERT INTO recordings (id, channel_id, channel_name, title, start, end, status, created_by, created_at) VALUES ('rec-done', 'c', 'C', 'Old', '2020-01-01', '2020-01-02', 'completed', 'qa-acc', ?)", t);
  deleteUser('qa-acc', 'someone-else');
  assert.equal(db.get<{ n: number }>("SELECT COUNT(*) n FROM recording_rules WHERE id IN ('r1','r2')")!.n, 0);
  assert.deepEqual(db.all<{ status: string }>("SELECT status FROM recordings WHERE id IN ('rec-r1','rec-r2')").map((r) => r.status), ['cancelled', 'cancelled']);
  assert.equal(db.get<{ status: string }>("SELECT status FROM recordings WHERE id = 'rec-done'")!.status, 'completed');
});

test('subtitle cache entries of deleted or changed media are pruned', async () => {
  const { pruneSubtitleCache } = await import('../src/services/tasks.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-subcache-'));
  db.run("INSERT INTO items (id, type, title, sort_title, added_at, updated_at) VALUES ('qa-sub-item', 'movie', 'S', 's', '2026', '2026')");
  db.run("INSERT INTO media (id, item_id, path, mtime) VALUES ('qa_m-1', 'qa-sub-item', '/x/qa.mkv', 1700)");
  fs.mkdirSync(path.join(dir, 'subs'));
  fs.mkdirSync(path.join(dir, 'subfonts', 'qa_m-1_1700'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'subfonts', 'gone_5'), { recursive: true });
  for (const f of ['qa_m-1_3_1700.vtt', 'qa_m-1_3_1600.vtt', 'gone_2_5.srt', 'qa_m-1_4_1700.ass.part', 'README']) fs.writeFileSync(path.join(dir, 'subs', f), '');
  assert.equal(pruneSubtitleCache(dir), 3);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'subs')).sort(), ['README', 'qa_m-1_3_1700.vtt', 'qa_m-1_4_1700.ass.part']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'subfonts')), ['qa_m-1_1700']);
});
