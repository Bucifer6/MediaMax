/**
 * Live TV with two tuners on one aerial: radio services are told apart from TV, fallback mode lists each channel once
 * and tunes the other device when the first one's tuners are all busy; separate mode lists both devices' channels.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

const live = await import('../src/services/livetv/livetv.ts');
const { parseM3u } = await import('../src/services/livetv/m3u.ts');
const { updateSettings } = await import('../src/services/settings.ts');
const { createUser } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { issueToken } = await import('../src/services/auth.ts');

const admin = await createUser({ username: 'failoveradmin', password: 'pw-123456', isAdmin: true });
const servers: http.Server[] = [];
after(() => {
  for (const s of servers) s.close();
});

/** A fake HDHomeRun: lineup.json (two TV channels, one radio), status.json (tuners busy or free) and MPEG-TS streams. */
async function fakeHdhr(name: string) {
  const state = { busy: false, streams: 0, refuse: false };
  const srv = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    if (req.url === '/discover.json') return res.end(JSON.stringify({ FriendlyName: name, ModelNumber: 'HDHR5-4DT', TunerCount: 2, DeviceID: name }));
    if (req.url === '/lineup.json') {
      return res.end(JSON.stringify([
        { GuideNumber: '1', GuideName: 'TVR 1', URL: `${base}/auto/v1`, VideoCodec: 'MPEG2', AudioCodec: 'MPEG' },
        { GuideNumber: '2', GuideName: 'Pro TV', URL: `${base}/auto/v2`, HD: 1, VideoCodec: 'H264', AudioCodec: 'AAC' },
        { GuideNumber: '50', GuideName: 'Radio Romania Actualitati', URL: `${base}/auto/v50`, AudioCodec: 'MPEG' },
      ]));
    }
    if (req.url === '/status.json') {
      const t = (i: number) => (state.busy ? { Resource: `tuner${i}`, VctNumber: '1', VctName: 'TVR 1', TargetIP: '192.168.1.9' } : { Resource: `tuner${i}` });
      return res.end(JSON.stringify([t(0), t(1)]));
    }
    if (req.url?.startsWith('/auto/')) {
      if (state.refuse) {
        res.statusCode = 503;
        return res.end('All tuners in use');
      }
      state.streams++;
      res.setHeader('Content-Type', 'video/mp2t');
      return res.end(Buffer.alloc(188 * 10, 0x47));
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  servers.push(srv);
  return { url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`, state };
}

test('HDHomeRun radio services and busy tuners are recognised', () => {
  assert.equal(live.hdhrIsRadio({ GuideNumber: '50', GuideName: 'R', URL: 'x', AudioCodec: 'MPEG' }), true);
  assert.equal(live.hdhrIsRadio({ GuideNumber: '1', GuideName: 'T', URL: 'x', VideoCodec: 'MPEG2', AudioCodec: 'MPEG' }), false);
  assert.equal(live.hdhrIsRadio({ GuideNumber: '1', GuideName: 'T', URL: 'x' }), false, 'ATSC lineups without codecs stay TV');
  assert.equal(live.hdhrAllBusy([{ Resource: 'tuner0', VctNumber: '5.1' }, { Resource: 'tuner1', TargetIP: '10.0.0.2' }]), true);
  assert.equal(live.hdhrAllBusy([{ Resource: 'tuner0', VctNumber: '5.1' }, { Resource: 'tuner1' }]), false);
  assert.equal(live.hdhrAllBusy([]), false);
  assert.equal(live.hdhrAllBusy({ error: 1 }), false);
  const pl = parseM3u('#EXTM3U\n#EXTINF:-1 radio="true",Kiss FM\nhttp://x/1\n#EXTINF:-1,TV\nhttp://x/2');
  assert.deepEqual(pl.entries.map((e) => e.radio), [true, false]);
});

test('fallback mode: one entry per channel, the other tuner takes over when the first is busy; separate mode lists both', async () => {
  const a = await fakeHdhr('A');
  const b = await fakeHdhr('B');
  const srcA = live.createSource({ name: 'HDHomeRun A', type: 'hdhomerun', url: a.url });
  const srcB = live.createSource({ name: 'HDHomeRun B', type: 'hdhomerun', url: b.url });
  await live.refreshSource(srcA.id);
  await live.refreshSource(srcB.id);
  live.updateSource(srcA.id, { proxyStreams: true });
  live.updateSource(srcB.id, { proxyStreams: true });

  updateSettings({ liveTvSourceMode: 'failover' });
  const tv = live.listChannels(admin, { kind: 'tv' });
  assert.deepEqual(tv.items.map((c) => c.name), ['TVR 1', 'Pro TV']);
  assert.equal(tv.total, 2);
  assert.ok(tv.items.every((c) => c.sourceId === srcA.id && c.backups === 1 && !c.radio), 'the older source is listed, the other is its backup');
  const radio = live.listChannels(admin, { kind: 'radio' });
  assert.deepEqual(radio.items.map((c) => [c.name, c.radio]), [['Radio Romania Actualitati', true]]);
  assert.equal(live.listChannels(admin, {}).total, 3, 'no kind: both, as older apps expect');
  assert.equal(live.listChannels(admin, { sourceId: srcB.id }).total, 3, "a source's own list (admin) is not merged");
  assert.equal(live.listCategories(admin, srcA.id).some((c) => c.name === 'Radio'), true);

  // Device A's tuners are all in use: B's copy comes first.
  const tvr = tv.items[0]!;
  const rowA = live.accessibleChannelRow(admin, tvr.id);
  assert.deepEqual((await live.channelCandidates(rowA)).map((r) => r.source_id), [srcA.id, srcB.id]);
  a.state.busy = true;
  assert.deepEqual((await live.channelCandidates(rowA)).map((r) => r.source_id), [srcB.id, srcA.id]);
  assert.deepEqual((await live.channelCandidates(rowA, { catchup: true })).map((r) => r.source_id), [srcA.id], 'catch-up never moves');

  // The restream: A refuses (HTTP 503, its status.json said free), B serves it.
  a.state.busy = false;
  a.state.refuse = true;
  const app = await buildApp();
  const tok = issueToken(admin.id, { deviceId: 'failover', deviceName: 'test', platform: 'web' }).token;
  const r = await app.inject({ method: 'GET', url: `/api/v1/livetv/stream/${tvr.id}?token=${tok}` });
  assert.equal(r.statusCode, 200);
  assert.equal(b.state.streams, 1);
  assert.equal(live.activeUpstreams(srcA.id), 0, 'the refused attempt released its slot');
  b.state.refuse = true;
  const both = await app.inject({ method: 'GET', url: `/api/v1/livetv/stream/${tvr.id}?token=${tok}` });
  assert.equal(both.statusCode, 503, 'every tuner busy: the viewer is told so');
  await app.close();

  updateSettings({ liveTvSourceMode: 'separate' });
  const sep = live.listChannels(admin, { kind: 'tv' });
  assert.equal(sep.total, 4);
  assert.ok(sep.items.every((c) => c.backups === undefined));
  assert.deepEqual((await live.channelCandidates(rowA)).map((r) => r.source_id), [srcA.id]);
  updateSettings({ liveTvSourceMode: 'failover' });

  // The admin can say a channel is (not) radio.
  live.updateChannel(radio.items[0]!.id, { radio: false });
  assert.equal(live.listChannels(admin, { kind: 'radio' }).total, 0);
  live.updateChannel(radio.items[0]!.id, { radio: null });
  assert.equal(live.listChannels(admin, { kind: 'radio' }).total, 1);
});
