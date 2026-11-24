/**
 * Live TV follow-ups: a shared live remux whose ffmpeg died is replaced for the next viewer; programme search follows
 * LIKE semantics with a deterministic order; a failing .xz guide download stops xz; the transcode-dir sweep keeps
 * directories of running jobs.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-livefu-'));
const { db } = await import('../src/db.ts');
const { config } = await import('../src/config.ts');
const live = await import('../src/services/livetv/livetv.ts');
const epg = await import('../src/services/livetv/epg/epg.ts');
const { autoDecompress } = await import('../src/services/livetv/xmltv.ts');
const { createUser, issueToken, authenticate } = await import('../src/services/auth.ts');
const { stopSession } = await import('../src/services/playback.ts');
const { sweepTranscodeDir } = await import('../src/services/tasks.ts');

const admin = await createUser({ username: 'livefuadmin', password: 'pw-123456', isAdmin: true });
const device = (id: string) => authenticate(issueToken(admin.id, { deviceId: id, deviceName: id, platform: 'web' }).token)!;
const ctx = device('livefu-a');
const ctx2 = device('livefu-b');
const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});
const has = (bin: string, flag = '-version') => {
  try {
    execFileSync(bin, [flag], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const waitFor = async (fn: () => boolean, ms = 15000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 50));
  }
};
const now = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
db.run("INSERT INTO live_sources (id, name, type, url, enabled, proxy_streams, created_at) VALUES ('fu-src', 'FU', 'm3u', 'http://127.0.0.1:9/x.m3u', 1, 1, ?)", iso(now));
db.run("INSERT INTO live_sources (id, name, type, url, enabled, proxy_streams, created_at) VALUES ('fu-off', 'Off', 'm3u', 'http://127.0.0.1:9/y.m3u', 0, 1, ?)", iso(now));
db.run("INSERT INTO channel_categories (id, source_id, remote_id, kind, name, hidden) VALUES ('fu-hidden', 'fu-src', 'h', 'live', 'Hidden', 1)");
const addChannel = (id: string, epgId: string, extra: { source?: string; hidden?: number; category?: string; url?: string } = {}) =>
  db.run('INSERT INTO channels (id, source_id, remote_id, name, stream_url, epg_channel_id, hidden, category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    id, extra.source ?? 'fu-src', id, `Channel ${id}`, extra.url ?? 'http://127.0.0.1:9/none.ts', epgId, extra.hidden ?? 0, extra.category ?? null);

/* ------------------------------ 1. shared live job ------------------------------ */

test('a shared live remux whose upstream dropped is replaced for the next viewer', { skip: !has(config.ffmpeg) && 'ffmpeg not installed' }, async () => {
  // A 3-second MPEG-TS "upstream": ffmpeg reads it to the end and exits, like a provider connection that drops.
  const ts = path.join(tmp, 'short.ts');
  execFileSync(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=160x120:rate=10', '-f', 'lavfi', '-i', 'sine', '-t', '3',
    '-c:v', 'libx264', '-g', '10', '-c:a', 'aac', '-f', 'mpegts', '-y', ts]);
  let requests = 0;
  const srv = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { 'Content-Type': 'video/mp2t' });
    res.end(fs.readFileSync(ts));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  servers.push(srv);
  addChannel('fu-live', 'fu.live', { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}/live.ts` });

  const a = await live.playChannel(ctx, 'fu-live', { forceHls: true } as any, '127.0.0.1');
  const jobA = live.liveJobBySession.get(a.sessionId)!;
  assert.ok(jobA);
  await waitFor(() => jobA.exited);
  assert.equal(live.activeUpstreams('fu-src'), 0, 'a dead job holds no provider connection');

  const b = await live.playChannel(ctx2, 'fu-live', { forceHls: true } as any, '127.0.0.1');
  const jobB = live.liveJobBySession.get(b.sessionId)!;
  assert.notEqual(jobB, jobA, 'the next viewer gets a fresh upstream, not the dead job');
  assert.equal(requests, 2);
  assert.equal(jobA.killed, false, 'the first viewer still holds the old job');
  assert.ok(live.liveJobIds().includes(jobA.id) && live.liveJobIds().includes(jobB.id));

  // 6. The transcode-dir sweep keeps the directories of jobs in use, by job id (not session id).
  await waitFor(() => jobB.exited);
  const old = (Date.now() - 7 * 3600000) / 1000;
  const stale = path.join(config.transcodeDir, 'fu-stale-job');
  fs.mkdirSync(stale, { recursive: true });
  for (const d of [stale, jobA.dir, jobB.dir]) fs.utimesSync(d, old, old);
  const fresh = path.join(config.transcodeDir, 'fu-fresh-job');
  fs.mkdirSync(fresh, { recursive: true });
  sweepTranscodeDir();
  assert.equal(fs.existsSync(stale), false, 'stale directory removed');
  assert.ok(fs.existsSync(fresh), 'recent directory kept');
  assert.ok(fs.existsSync(jobA.dir) && fs.existsSync(jobB.dir), 'directories of jobs viewers hold are kept');

  // The first viewer leaves: its (replaced) job is stopped right away; the current one stays warm.
  stopSession(a.sessionId, 'stopped');
  assert.equal(jobA.killed, true);
  assert.equal(jobB.killed, false);
  stopSession(b.sessionId, 'stopped');
  // A new viewer within the warm period still gets a fresh job, as jobB's ffmpeg has stopped too.
  const c = await live.playChannel(ctx, 'fu-live', { forceHls: true } as any, '127.0.0.1');
  const jobC = live.liveJobBySession.get(c.sessionId)!;
  assert.notEqual(jobC, jobB);
  assert.equal(jobB.killed, true, 'the dead, unused job is stopped when it is dropped');
  stopSession(c.sessionId, 'stopped');
});

/* ------------------------------ 2. programme search ------------------------------ */

const TITLES = ['Evening News', 'The News Hour', 'news at ten', 'Newsround', 'Shadow Line', 'The Shadow', 'Weather', 'Sport Today', "Bob's \"Big\" Quiz",
  'Café Société', 'CAFÉ late', '100% Football', 'A_B Show', 'Planet Earth', 'Earthquake Live'];
function seedGuide() {
  addChannel('fu-a', 'fu.a');
  addChannel('fu-b1', 'fu.b'); // two channels on one guide: the programme is listed once (lowest channel id)
  addChannel('fu-b0', 'fu.b');
  addChannel('fu-hid', 'fu.hid', { hidden: 1 });
  addChannel('fu-cat', 'fu.cat', { category: 'fu-hidden' });
  addChannel('fu-dis', 'fu.dis', { source: 'fu-off' });
  db.run("UPDATE channels SET custom = '{\"epgChannelId\":\"fu.custom\"}' WHERE id = 'fu-a'"); // custom guide id wins
  addChannel('fu-c', 'fu.c');
  let k = 0;
  db.tx(() => {
    for (const epgId of ['fu.custom', 'fu.b', 'fu.hid', 'fu.cat', 'fu.dis', 'fu.c', 'fu.a']) {
      for (let i = -3; i < 30; i++) {
        const t = TITLES[(i + 15 + epgId.length) % TITLES.length];
        // Some programmes share a start time (tie-break by id).
        const start = now + Math.floor(i / 2) * 3600000;
        db.run('INSERT INTO programs (id, source_id, epg_channel_id, title, start, end) VALUES (?, ?, ?, ?, ?, ?)', `fu-p${String(k++).padStart(4, '0')}`, 'fu-guide', epgId, t, iso(start), iso(start + 3600000));
      }
    }
  });
}

/** The search, written out without SQL: visible channels, ASCII-case-insensitive LIKE, not ended, by start then id. */
function reference(q: string, limit = 20) {
  const vis = new Map<string, string>(); // effective guide id → lowest visible channel id
  for (const c of db.all("SELECT c.*, s.enabled FROM channels c JOIN live_sources s ON s.id = c.source_id WHERE c.id LIKE 'fu-%'")) {
    const hiddenCat = c.category_id && db.get('SELECT hidden FROM channel_categories WHERE id = ?', c.category_id)?.hidden;
    if (!c.enabled || c.hidden || hiddenCat) continue;
    const k = epg.effEpg(c)!;
    if (!vis.has(k) || c.id < vis.get(k)!) vis.set(k, c.id);
  }
  // LIKE: % and _ wildcards, case folded for ASCII letters only.
  const fold = (t: string) => t.replace(/[A-Z]/g, (c) => c.toLowerCase());
  const re = new RegExp(`^.*${[...fold(q)].map((ch) => (ch === '%' ? '.*' : ch === '_' ? '.' : ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('')}.*$`, 's');
  return db.all('SELECT * FROM programs WHERE end > ?', iso(Date.now()))
    .filter((p) => vis.has(p.epg_channel_id) && re.test(fold(p.title)))
    .sort((x, y) => (x.start < y.start ? -1 : x.start > y.start ? 1 : x.id < y.id ? -1 : 1))
    .slice(0, limit)
    .map((p) => `${p.id}|${vis.get(p.epg_channel_id)}|${p.start}`);
}
const search = (q: string, limit = 20) => live.searchLive(admin, q, limit).programs.filter((p) => p.id.startsWith('fu-')).map((p) => `${p.id}|${p.channelId}|${p.start}`);

test('programme search: visible channels, LIKE semantics, deterministic order and channel choice', () => {
  seedGuide();
  const queries = ['news', 'NEWS', 'News Hour', 'shadow', 'the', 'Th', 'ne', 'x', 'earth', 'quake', 'café', 'CAFÉ', 'caf', 'Bob\'s "Big"', '"Big"', '100%', '100% Foot', 'A_B', 'a_b', 'zzz', 'Société'];
  for (const q of queries) {
    const exp = reference(q);
    assert.deepEqual(search(q), exp, `search ${JSON.stringify(q)}`);
    assert.deepEqual(search(q, 3), exp.slice(0, 3), `search ${JSON.stringify(q)} (limit 3)`);
  }
  assert.ok(search('news').length > 3, 'the fixture has matches');
  assert.ok(search('news').every((r) => !r.includes('|fu-hid|') && !r.includes('|fu-cat|') && !r.includes('|fu-dis|')));
  assert.ok(search('news').some((r) => r.includes('|fu-b0|')) && !search('news').some((r) => r.includes('|fu-b1|')));
  // Unicode case: SQLite's LIKE only folds ASCII; the index (which folds Unicode) must not widen it.
  assert.ok(search('CAFÉ').every((r) => db.get('SELECT title FROM programs WHERE id = ?', r.split('|')[0])!.title.includes('CAFÉ')));
});

/* ------------------------------ 5. xz download errors ------------------------------ */

test('an .xz guide download that fails mid-way stops xz and reports the error', { skip: !has('xz', '--version') && 'xz not installed' }, async () => {
  const xz = execFileSync('xz', ['-c'], { input: Buffer.alloc(200000, 'guide data ') });
  const children = () => {
    try {
      return execFileSync('pgrep', ['-P', String(process.pid), '-x', 'xz'], { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  const before = children().length;
  const src = new Readable({ read() {} });
  src.push(xz.subarray(0, 1024));
  const out = await autoDecompress(src);
  await waitFor(() => children().length > before);
  setTimeout(() => src.destroy(new Error('connection reset')), 50);
  await assert.rejects(async () => {
    for await (const _ of out) void _;
  }, /connection reset/);
  await waitFor(() => children().length === before, 5000);
});
