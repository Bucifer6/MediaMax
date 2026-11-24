import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => fs.readFileSync(path.join(here, 'fixtures/mountinfo', n), 'utf8');

const win = await import('../src/services/storage/window.ts');
const { PiggybackQueue } = await import('../src/services/storage/piggyback.ts');
const mi = await import('../src/services/storage/mounts.ts');

/* ------------------------- maintenance window ------------------------ */

const at = (hm: string, day = 10) => {
  const [h, m] = hm.split(':').map(Number);
  return new Date(2026, 10, day, h, m, 0, 0);
};

test('maintenance window: same-day, wrapping midnight, all-day and malformed', () => {
  assert.equal(win.parseHm('02:00'), 120);
  assert.equal(win.parseHm('2:30'), 150);
  assert.equal(win.parseHm('24:00'), null);
  assert.equal(win.parseHm('ab'), null);

  assert.equal(win.inWindow(at('01:59'), '02:00', '05:00'), false);
  assert.equal(win.inWindow(at('02:00'), '02:00', '05:00'), true);
  assert.equal(win.inWindow(at('04:59'), '02:00', '05:00'), true);
  assert.equal(win.inWindow(at('05:00'), '02:00', '05:00'), false, 'end is exclusive');

  assert.equal(win.inWindow(at('23:30'), '23:00', '04:00'), true);
  assert.equal(win.inWindow(at('03:00'), '23:00', '04:00'), true);
  assert.equal(win.inWindow(at('12:00'), '23:00', '04:00'), false);

  assert.equal(win.inWindow(at('12:00'), '03:00', '03:00'), true, 'start = end → no restriction');
  assert.equal(win.inWindow(at('12:00'), 'nope', '03:00'), true, 'malformed → no restriction');

  assert.equal(win.windowLength('02:00', '05:00'), 180);
  assert.equal(win.windowLength('23:00', '04:00'), 300);
});

test('maintenance window: next opening', () => {
  assert.deepEqual(win.nextWindowStart(at('12:00'), '02:00', '05:00'), at('02:00', 11), 'tomorrow');
  assert.deepEqual(win.nextWindowStart(at('01:00'), '02:00', '05:00'), at('02:00', 10), 'later today');
  assert.deepEqual(win.nextWindowStart(at('03:00'), '02:00', '05:00'), at('03:00', 10), 'already open');
  assert.deepEqual(win.nextWindowStart(at('22:00'), '23:00', '04:00'), at('23:00', 10));
  assert.deepEqual(win.nextWindowStart(at('04:30'), '23:00', '04:00'), at('23:00', 10));
});

/* --------------------------- piggyback queue -------------------------- */

test('piggyback queue: per-disk progress, oldest first, cleared when every disk caught up', () => {
  const q = new PiggybackQueue();
  q.defer('trickplay', 2000);
  q.defer('scan-libraries', 1000);
  q.defer('trickplay', 5000); // keeps its original time
  assert.deepEqual(q.pendingFor('dev:8:17'), ['scan-libraries', 'trickplay']);

  q.markDone('scan-libraries', 'dev:8:17', ['dev:8:17', 'dev:8:33']);
  assert.deepEqual(q.pendingFor('dev:8:17'), ['trickplay']);
  assert.deepEqual(q.pendingFor('dev:8:33'), ['scan-libraries', 'trickplay']);
  assert.equal(q.isDeferred('scan-libraries'), true);

  q.markDone('scan-libraries', 'dev:8:33', ['dev:8:17', 'dev:8:33']);
  assert.equal(q.isDeferred('scan-libraries'), false, 'all disks done → gone');

  const snap = q.snapshot();
  const r = new PiggybackQueue();
  r.restore(snap);
  assert.deepEqual(r.pendingFor('dev:8:99'), ['trickplay']);
  r.clear('trickplay');
  assert.equal(r.size, 0);
  r.markDone('nothing', 'x'); // no-op
});

/* ------------------------------ mountinfo ----------------------------- */

test('mountinfo: Synology (md/LVM + btrfs), longest-prefix match', () => {
  const m = mi.parseMountInfo(fixture('synology.txt'));
  assert.equal(m.length, 6);
  const v1 = mi.findMount('/volume1/video/Movies/Film (2020)/film.mkv', m)!;
  assert.equal(v1.mountPoint, '/volume1');
  assert.equal(v1.fsType, 'btrfs');
  assert.equal(v1.dev, '253:1');
  assert.equal(mi.diskKeyFor(v1, '/volume1/video'), 'dev:253:1');
  assert.equal(mi.findMount('/volume1/@docker/btrfs/x', m)!.id, 42);
  assert.equal(mi.findMount('/volume10/x', m)!.mountPoint, '/', 'no partial-name match');
  assert.equal(mi.findMount('/volume2', m)!.mountPoint, '/volume2');
});

test('mountinfo: Unraid array disks, cache pool, FUSE user share and SMB remote', () => {
  const m = mi.parseMountInfo(fixture('unraid.txt'));
  const d1 = mi.findMount('/mnt/disk1/Movies', m)!;
  assert.equal(d1.source, '/dev/md1p1');
  assert.equal(mi.diskKeyFor(d1, ''), 'dev:9:1');
  const user = mi.findMount('/mnt/user/Movies', m)!;
  assert.equal(user.fsType, 'fuse.shfs');
  assert.equal(mi.diskKeyFor(user, ''), 'dev:0:42', 'FUSE shares are one disk key (no /dev source)');
  const cache = mi.findMount('/mnt/cache/appdata', m)!;
  assert.equal(mi.diskKeyFor(cache, ''), 'src:/dev/nvme0n1p1', 'btrfs anonymous dev → keyed by source');
  const smb = mi.findMount('/mnt/remotes/NAS_Movies/x.mkv', m)!;
  assert.equal(mi.isNetworkFs(smb.fsType), true);
  assert.equal(mi.isNetworkFs(d1.fsType), false);
});

test('mountinfo: TrueNAS ZFS datasets, escaped spaces, NFS; Docker bind mounts', () => {
  const m = mi.parseMountInfo(fixture('truenas.txt'));
  assert.equal(mi.findMount('/mnt/tank/media/tv', m)!.source, 'tank/media');
  const nfs = mi.findMount('/mnt/nfs share/movies', m)!;
  assert.equal(nfs.mountPoint, '/mnt/nfs share', '\\040 decoded');
  assert.equal(mi.isNetworkFs(nfs.fsType), true);
  assert.equal(mi.diskKeyFor(mi.findMount('/mnt/tank/media', m), ''), 'zfs:tank', 'datasets of one pool share a key');
  assert.equal(mi.diskKeyFor(mi.findMount('/mnt/tank/other', m), ''), 'zfs:tank');

  const d = mi.parseMountInfo(fixture('docker.txt'));
  assert.equal(mi.findMount('/media/movies/a.mkv', d)!.dev, '8:17');
  assert.equal(mi.findMount('/media/tv/show/a.mkv', d)!.id, 612);
  assert.equal(mi.findMount('/config/cache', d)!.dev, '259:2');
  assert.equal(mi.diskKeyFor(null, '/x'), 'path:/x');
  assert.deepEqual(mi.parseMountInfo('garbage\n\n1 2 3'), []);
});

test('sysfs: partitions, md RAID members and rotational flag (fake /sys tree)', () => {
  const sys = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-sys-'));
  const mk = (p: string, content?: string) => {
    const f = path.join(sys, p);
    fs.mkdirSync(content === undefined ? f : path.dirname(f), { recursive: true });
    if (content !== undefined) fs.writeFileSync(f, content);
  };
  const ln = (target: string, p: string) => {
    fs.mkdirSync(path.dirname(path.join(sys, p)), { recursive: true });
    fs.symlinkSync(path.join(sys, target), path.join(sys, p));
  };
  for (const disk of ['sdb', 'sdc', 'sdd']) {
    mk(`devices/pci/block/${disk}/queue/rotational`, disk === 'sdb' ? '0' : '1');
    mk(`devices/pci/block/${disk}/stat`, '100 0 0 0 50 0 0 0 0 0 0');
    mk(`devices/pci/block/${disk}/${disk}1/partition`, '1');
    ln(`devices/pci/block/${disk}`, `class/block/${disk}`);
    ln(`devices/pci/block/${disk}/${disk}1`, `class/block/${disk}1`);
    ln(`devices/pci/block/${disk}`, `block/${disk}`);
  }
  ln('devices/pci/block/sdb/sdb1', 'dev/block/8:17');
  // Unraid-style md1 over sdc1 + sdd1, partitioned as md1p1.
  mk('devices/virtual/block/md1/md1p1/partition', '1');
  ln('devices/pci/block/sdc/sdc1', 'devices/virtual/block/md1/slaves/sdc1');
  ln('devices/pci/block/sdd/sdd1', 'devices/virtual/block/md1/slaves/sdd1');
  ln('devices/virtual/block/md1', 'class/block/md1');
  ln('devices/virtual/block/md1/md1p1', 'class/block/md1p1');
  ln('devices/virtual/block/md1/md1p1', 'dev/block/9:1');

  const entry = (dev: string, source: string) => ({ id: 1, parent: 0, dev, root: '/', mountPoint: '/x', fsType: 'xfs', source });
  assert.deepEqual(mi.resolveDisks(entry('8:17', '/dev/sdb1'), sys), ['sdb']);
  assert.deepEqual(mi.resolveDisks(entry('9:1', '/dev/md1p1'), sys).sort(), ['sdc', 'sdd']);
  assert.deepEqual(mi.resolveDisks(entry('0:44', '/dev/sdc1'), sys), ['sdc'], 'btrfs: via the source device');
  assert.deepEqual(mi.resolveDisks(entry('0:45', 'tank/media'), sys), [], 'ZFS: unknown');
  assert.equal(mi.isRotational('sdb', sys), false);
  assert.equal(mi.isRotational('sdc', sys), true);
  assert.equal(mi.isRotational('nope', sys), null);
  assert.equal(mi.ioCount('sdc', sys), 150);

  // sysfs I/O sampling: first sample unknown, unchanged for >10 min → idle, new I/O → active.
  const t0 = Date.now();
  assert.equal(mi.sampleIo('sdc', t0, sys), 'unknown');
  assert.equal(mi.sampleIo('sdc', t0 + 60000, sys), 'unknown');
  assert.equal(mi.sampleIo('sdc', t0 + 11 * 60000, sys), 'idle');
  fs.writeFileSync(path.join(sys, 'devices/pci/block/sdc/stat'), '101 0 0 0 50 0 0 0 0 0 0');
  assert.equal(mi.sampleIo('sdc', t0 + 12 * 60000, sys), 'active');
  fs.rmSync(sys, { recursive: true, force: true });
});

test('hdparm / smartctl output parsing (never wakes the disk)', () => {
  assert.equal(mi.parseHdparm('\n/dev/sdc:\n drive state is:  standby\n'), 'standby');
  assert.equal(mi.parseHdparm('\n/dev/sdc:\n drive state is:  active/idle\n'), 'active');
  assert.equal(mi.parseHdparm('\n/dev/sdc:\n drive state is:  unknown\n'), 'unknown');
  assert.equal(mi.parseHdparm('HDIO_DRIVE_CMD(check) failed: Permission denied'), null);
  assert.equal(mi.parseSmartctl('smartctl 7.3\nDevice is in STANDBY mode, exit(2)\n', 2), 'standby');
  assert.equal(mi.parseSmartctl('=== START OF INFORMATION SECTION ===\nDevice Model: WDC WD80EFAX\nPower mode is:    ACTIVE or IDLE\n', 0), 'active');
  assert.equal(mi.parseSmartctl('Smartctl open device: /dev/sdc failed: Permission denied', 2), null);
  assert.equal(mi.combineStates(['standby', 'standby']), 'standby');
  assert.equal(mi.combineStates(['standby', 'active']), 'active');
  assert.equal(mi.combineStates(['standby', 'idle']), 'idle');
  assert.equal(mi.combineStates([]), 'unknown');
});

/* --------------------------- scheduling policy ------------------------ */

const { db } = await import('../src/db.ts');
const { nowIso } = await import('../src/util/misc.ts');
const storage = await import('../src/services/storage/storage.ts');
const tasks = await import('../src/services/tasks.ts');
const { getKv, setKv } = await import('../src/services/settings.ts');

const S = (p: Partial<typeof storage.DEFAULT_STORAGE> = {}) => ({ ...storage.DEFAULT_STORAGE, ...p });

test('policy: disk-friendly mode holds media-disk tasks to the window; other tasks always run', () => {
  const s = S({ diskFriendly: true, windowStart: '02:00', windowEnd: '05:00' });
  assert.equal(storage.decide('trickplay', s, at('14:00'), null).run, false);
  assert.match(storage.decide('trickplay', s, at('14:00'), null).reason!, /maintenance window/);
  assert.equal(storage.decide('trickplay', s, at('03:00'), null).run, true);
  assert.equal(storage.decide('refresh-livetv', s, at('14:00'), null).run, true, 'network-only task');
  assert.equal(storage.decide('backup', s, at('14:00'), null).run, true, 'data-dir task');
  assert.equal(storage.decide('scan-libraries', S(), at('14:00'), null).run, true, 'mode off');
  for (const id of ['scan-libraries', 'episode-thumbnails', 'trickplay', 'detect-intros', 'dj-analysis', 'subtitles', 'hdr-formats']) assert.ok(storage.isDiskTask(id));
});

test('policy: with disk-state checks, sleeping disks are skipped (and remembered), awake ones processed', () => {
  const states = new Map([['dev:8:17', 'standby' as const], ['dev:8:33', 'active' as const]]);
  const plan = storage.decide('trickplay', S({ checkDiskState: true }), at('14:00'), states);
  assert.equal(plan.run, true);
  assert.deepEqual(plan.awakeKeys, ['dev:8:33']);
  assert.ok(plan.filter);
  const all = storage.decide('trickplay', S({ checkDiskState: true }), at('14:00'), new Map([['dev:8:17', 'standby' as const]]));
  assert.equal(all.run, false);
  assert.equal(storage.decide('trickplay', S({ checkDiskState: false }), at('14:00'), states).run, true);
  assert.equal(storage.decide('trickplay', S({ checkDiskState: true }), at('14:00'), states).filter !== undefined, true);
  // In disk-friendly mode the window may wake disks: no filter.
  assert.equal(storage.decide('trickplay', S({ diskFriendly: true, windowStart: '00:00', windowEnd: '23:59', checkDiskState: true }), at('14:00'), states).filter, undefined);
});

test('scheduler integration: deferral outside the window, piggyback run for the awake disk, full run clears', async () => {
  storage._resetStorage();
  const media = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-media-'));
  db.insert('libraries', { id: 'lib-m', name: 'Movies', type: 'movies', paths: JSON.stringify([media]), created_at: nowIso() });
  // A window that is certainly closed right now.
  const now = new Date();
  const h = (now.getHours() + 12) % 24;
  storage.saveStorageSettings({ diskFriendly: true, windowStart: `${String(h).padStart(2, '0')}:00`, windowEnd: `${String((h + 1) % 24).padStart(2, '0')}:00`, checkDiskState: false });

  assert.equal((await storage.planScheduledRun('refresh-livetv')).run, true);
  const plan = await storage.planScheduledRun('scan-libraries');
  assert.equal(plan.run, false);
  assert.deepEqual(storage._queue().snapshot().map((e) => e.taskId), ['scan-libraries']);
  assert.ok(getKv<any[]>('storage:deferred', []).some((e) => e.taskId === 'scan-libraries'), 'persisted');

  // A stream from that disk: its share of the postponed scan runs (and leaves lastRunAt alone).
  setKv('task:scan-libraries', { lastRunAt: '2020-01-01T00:00:00.000Z', lastDurationMs: null, lastResult: null, lastError: null });
  const key = storage.diskKeyForPath(path.join(media, 'film.mkv'));
  assert.equal(key, storage.diskKeyForPath(media));
  assert.deepEqual(storage.allDiskKeys(), [key]);
  const ran = await storage.piggyback(key);
  assert.equal(ran, 1);
  assert.equal(storage._queue().size, 0, 'only one disk → task fully caught up');
  assert.equal(getKv<any>('task:scan-libraries', {}).lastRunAt, '2020-01-01T00:00:00.000Z', 'piggyback run keeps the schedule');
  assert.ok(db.get('SELECT last_scan_at FROM libraries WHERE id = ?', 'lib-m')?.last_scan_at, 'library was scanned');

  // Tasks that can't be split by disk are left for the window.
  storage._queue().defer('hdr-formats');
  assert.equal(await storage.piggyback(key), 0);
  assert.equal(storage._queue().isDeferred('hdr-formats'), true);
  // A manual (full) run clears it.
  await tasks.runTask('hdr-formats');
  assert.equal(storage._queue().isDeferred('hdr-formats'), false);

  // Settings are validated.
  const s = storage.saveStorageSettings({ windowStart: '25:00', pollIntervalMinutes: 5, watchMode: 'bogus' as any });
  assert.equal(s.pollIntervalMinutes, 60);
  assert.equal(s.watchMode, 'native');
  assert.notEqual(s.windowStart, '25:00');
  storage.saveStorageSettings({ diskFriendly: false });
  fs.rmSync(media, { recursive: true, force: true });
});

/* ------------------------------ watching ------------------------------ */

test('directory watcher: no per-file watches, sees new files in new folders, ignores NAS metadata', async () => {
  const { DirWatcher, folderSignature } = await import('../src/services/storage/dirwatch.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-watch-'));
  for (const d of ['Show/Season 1', 'Show/@eaDir', 'Movies']) fs.mkdirSync(path.join(root, d), { recursive: true });
  for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, 'Show/Season 1', `e${i}.mkv`), '');
  const seen: string[] = [];
  const w = new DirWatcher(root, (rel) => seen.push(rel));
  const r = await w.start();
  if (process.platform === 'linux') assert.equal(r.directories, 4, 'root, Show, Season 1, Movies — files and @eaDir are not watched');
  const sig1 = await folderSignature(root);
  assert.equal(await folderSignature(root), sig1, 'same tree, same signature');
  assert.match(sig1!, /^[0-9a-f]{40}$/, 'a digest, not the joined folder list');
  const wait = async (fn: () => boolean) => {
    for (let i = 0; i < 100 && !fn(); i++) await new Promise((res) => setTimeout(res, 20));
    return fn();
  };
  fs.mkdirSync(path.join(root, 'Movies/New Film (2024)'));
  await wait(() => seen.some((s) => s.includes('New Film')));
  await new Promise((res) => setTimeout(res, 50));
  fs.writeFileSync(path.join(root, 'Movies/New Film (2024)/film.mkv'), 'x');
  assert.ok(await wait(() => seen.some((s) => s.endsWith('film.mkv'))), `file in a new folder seen: ${seen.join(', ')}`);
  seen.length = 0;
  fs.writeFileSync(path.join(root, 'Show/@eaDir/thumb.jpg'), 'x');
  fs.writeFileSync(path.join(root, 'Movies/.hidden'), 'x');
  fs.writeFileSync(path.join(root, 'Movies/x.part'), 'x');
  await new Promise((res) => setTimeout(res, 200));
  assert.deepEqual(seen, [], 'ignored paths');
  w.close();
  assert.notEqual(await folderSignature(root), sig1, 'poll signature changes when folders change');
  assert.equal(await folderSignature(path.join(root, 'missing')), null);
  fs.rmSync(root, { recursive: true, force: true });
});

test('artwork next to media is served from a copy in the data dir', async () => {
  const { registerImage, resolveImage } = await import('../src/services/images.ts');
  const { config } = await import('../src/config.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-art-'));
  const poster = path.join(dir, 'poster.jpg');
  fs.writeFileSync(poster, 'v1');
  const id = registerImage(poster)!;
  const first = await resolveImage(id);
  assert.ok(first.path.startsWith(config.imageCacheDir), first.path);
  fs.renameSync(poster, poster + '.bak'); // the "disk" is gone: still served
  assert.equal(fs.readFileSync((await resolveImage(id)).path, 'utf8'), 'v1');
  fs.renameSync(poster + '.bak', poster);
  fs.writeFileSync(poster, 'v2');
  const future = new Date(Date.now() + 60000);
  fs.utimesSync(poster, future, future);
  registerImage(poster); // a rescan sees the newer original
  assert.equal(fs.readFileSync((await resolveImage(id)).path, 'utf8'), 'v2');
  fs.rmSync(dir, { recursive: true, force: true });
});
