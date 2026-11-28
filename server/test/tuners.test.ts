/**
 * Hardware tuner / set-top-box live sources against mock devices that follow the documented APIs:
 * TVHeadend (Digest auth, channel grid, tags, inputs, EPG grid, recordings, streams, playlist fallback),
 * Enigma2/OpenWebif (Basic auth, bouquets, markers, picons, epgmulti + epgservice fallback, streamauth),
 * SAT>IP (FRITZ!Box lists, M3U with placeholders, X_SATIPCAP tuner count, SSDP discovery) and HDHomeRun UDP discovery.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tuners-'));
process.env.MEDIAMAX_DATA = path.join(tmp, 'data');

/* ------------------------------ mock servers ------------------------------ */

type Reply = { status?: number; type?: string; body: string | Buffer; headers?: Record<string, string> };
type Handler = (req: http.IncomingMessage, url: URL) => Reply | Promise<Reply>;
const servers: http.Server[] = [];
const sockets: dgram.Socket[] = [];
async function serve(h: Handler): Promise<string> {
  const s = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    try {
      const r = await h(req, url);
      res.writeHead(r.status ?? 200, { 'Content-Type': r.type ?? 'application/json', ...(r.headers ?? {}) });
      res.end(r.body);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e));
    }
  });
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', () => r()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}
after(() => {
  for (const s of servers) s.close();
  for (const s of sockets) s.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const json = (b: unknown, status = 200): Reply => ({ status, body: JSON.stringify(b) });
const H = 3600;
const now = Math.floor(Date.now() / 1000 / H) * H;
const TS = Buffer.alloc(188 * 50, 0x47);

/* TVHeadend: Digest auth (realm "tvheadend", qop=auth) like the real server. */
const TVH_USER = 'tvhuser';
const TVH_PASS = 'tvh-secret';
const tvh = { nonce: crypto.randomBytes(8).toString('hex'), gridForbidden: false, epgCalls: 0, streams: 0 };
const md5 = (s: string) => crypto.createHash('md5').update(s).digest('hex');
function digestOk(req: http.IncomingMessage): boolean {
  const a = req.headers.authorization ?? '';
  if (!a.startsWith('Digest ')) return false;
  const p: Record<string, string> = {};
  for (const m of a.slice(7).matchAll(/(\w+)=(?:"([^"]*)"|([^\s,]+))/g)) p[m[1]] = m[2] ?? m[3];
  if (p.username !== TVH_USER || p.nonce !== tvh.nonce || p.uri !== req.url) return false;
  const ha1 = md5(`${TVH_USER}:tvheadend:${TVH_PASS}`);
  const ha2 = md5(`${req.method}:${p.uri}`);
  return p.response === md5(`${ha1}:${p.nonce}:${p.nc}:${p.cnonce}:${p.qop}:${ha2}`);
}
const TVH_CHANNELS = [
  { uuid: 'a'.repeat(32), enabled: true, name: 'Das Erste HD', number: 1, icon_public_url: 'imagecache/1', tags: ['t-hd'] },
  { uuid: 'b'.repeat(32), enabled: true, name: 'ZDF HD', number: 2, icon_public_url: 'imagecache/2', tags: ['t-hd'] },
  { uuid: 'c'.repeat(32), enabled: true, name: 'arte', number: 3, icon: 'https://logos.example/arte.png', tags: ['t-sd', 't-internal'] },
  { uuid: 'd'.repeat(32), enabled: false, name: 'Disabled', number: 4, tags: [] },
];
const tvhUrl = await serve((req, url) => {
  if (!digestOk(req)) return { status: 401, body: 'auth', headers: { 'WWW-Authenticate': `Digest realm="tvheadend", qop="auth", nonce="${tvh.nonce}", opaque="${md5('o')}"` } };
  const start = Number(url.searchParams.get('start') ?? 0);
  const limit = Number(url.searchParams.get('limit') ?? 50);
  const page = <T,>(all: T[]) => ({ entries: all.slice(start, start + limit), total: all.length, totalCount: all.length });
  switch (url.pathname) {
    case '/api/serverinfo':
      return json({ sw_version: '4.3-2345', api_version: 19, name: 'Tvheadend', capabilities: ['caclient', 'tvadapters'] });
    case '/api/status/inputs':
      return json({ entries: [{ uuid: 'i1', input: 'Sony CXD2837 #0 : DVB-C #0', stream: 'DVB-C', subs: 0 }, { uuid: 'i2', input: 'Sony CXD2837 #1 : DVB-C #1', subs: 0 }], totalCount: 2 });
    case '/api/profile/list':
      return json({ entries: [{ key: 'p1', val: 'pass' }, { key: 'p2', val: 'matroska' }, { key: 'p3', val: 'htsp' }] });
    case '/api/channel/grid':
      if (tvh.gridForbidden) return { status: 403, body: 'Forbidden' };
      return json(page(TVH_CHANNELS));
    case '/api/channeltag/grid':
      return json(page([{ uuid: 't-sd', name: 'SD', enabled: true, index: 2 }, { uuid: 't-hd', name: 'HD', enabled: true, index: 1 }, { uuid: 't-internal', name: 'TV channels', enabled: true, internal: true }]));
    case '/api/epg/events/grid': {
      tvh.epgCalls++;
      const ev = [];
      for (const c of TVH_CHANNELS.slice(0, 3)) {
        for (let i = -1; i < 6; i++) ev.push({ eventId: ev.length, channelUuid: c.uuid, channelName: c.name, channelNumber: String(c.number), start: now + i * H, stop: now + (i + 1) * H, title: `${c.name} show ${i}`, subtitle: 'Folge', description: 'Beschreibung', genre: [0x23], episodeOnscreen: 'S02E05' });
      }
      return json(page(ev));
    }
    case '/api/dvr/entry/grid_finished':
      return json(page([{ uuid: 'e'.repeat(32), disp_title: 'Tatort', disp_subtitle: 'Folge 1', channelname: 'Das Erste HD', start: now - 7200, stop: now - 3600, filesize: 1234, status: 'Completed OK' }]));
    case '/playlist/channels.m3u':
      return { type: 'audio/x-mpegurl', body: `#EXTM3U\n#EXTINF:-1 logo="${'http://127.0.0.1/imagecache/1'}" tvg-id="${'a'.repeat(32)}" tvg-chno="1",Das Erste HD\nhttp://127.0.0.1/stream/channelid/1?ticket=ABC&profile=pass\n` };
  }
  if (url.pathname.startsWith('/imagecache/')) return { type: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') };
  if (url.pathname.startsWith('/dvrfile/')) return { type: 'video/mp2t', body: TS };
  const m = url.pathname.match(/^\/stream\/channel\/([0-9a-f]{32})$/);
  if (m) {
    tvh.streams++;
    assert.equal(url.searchParams.get('profile'), 'matroska');
    return { type: 'video/mp2t', body: TS };
  }
  return { status: 404, body: '{}' };
});

/* Enigma2 / OpenWebif: Basic auth. */
const E2_USER = 'root';
const E2_PASS = 'dreambox';
const B_FAV = '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.favourites.tv" ORDER BY bouquet';
const B_DE = '1:7:1:0:0:0:0:0:0:0:FROM BOUQUET "userbouquet.de.tv" ORDER BY bouquet';
const S_ARD = '1:0:19:283D:3FB:1:C00000:0:0:0:';
const S_ZDF = '1:0:19:2B66:3F3:1:C00000:0:0:0:';
const S_RTL = '1:0:19:2EE3:441:1:C00000:0:0:0:';
const e2 = { epgmulti: true, multiCalls: 0, serviceCalls: 0, streams: 0 };
const e2Url = await serve((req, url) => {
  const isStream = /^\/1:0:/.test(decodeURIComponent(url.pathname));
  if (req.headers.authorization !== `Basic ${Buffer.from(`${E2_USER}:${E2_PASS}`).toString('base64')}`) return { status: 401, body: 'auth', headers: { 'WWW-Authenticate': 'Basic realm="OpenWebif"' } };
  if (isStream) {
    e2.streams++;
    return { type: 'video/mp2t', body: TS };
  }
  const sRef = url.searchParams.get('sRef');
  const ev = (sref: string, name: string) => Array.from({ length: 5 }, (_, i) => ({ id: i, sref, sname: name, title: `${name} event ${i}`, shortdesc: 'Kurz', longdesc: 'Lang', begin_timestamp: now + (i - 1) * H, duration_sec: H, genre: 'Nachrichten' }));
  switch (url.pathname) {
    case '/api/deviceinfo':
      return json({ brand: 'Vu+', model: 'Uno 4K SE', imagever: 'OpenATV 7.4', webifver: 'OWIF 2.2.0', tuners: [{ name: 'Tuner A', type: 'DVB-S2X NIM' }, { name: 'Tuner B', type: 'DVB-C/T2' }] });
    case '/api/getservices':
      if (!sRef) return json({ services: [{ servicereference: B_FAV, servicename: 'Favourites (TV)' }, { servicereference: B_DE, servicename: 'Deutschland' }], pos: 0 });
      if (sRef === B_FAV) return json({ services: [{ servicereference: '1:64:1:0:0:0:0:0:0:0::--- News ---', servicename: '--- News ---' }, { servicereference: S_ARD, servicename: 'Das Erste HD', pos: 1 }, { servicereference: S_ZDF, servicename: 'ZDF HD', pos: 2 }] });
      if (sRef === B_DE) return json({ services: [{ servicereference: S_RTL, servicename: 'RTL', pos: 10 }, { servicereference: S_ARD, servicename: 'Das Erste HD', pos: 11 }] });
      return json({ services: [] });
    case '/api/epgmulti':
      e2.multiCalls++;
      if (!e2.epgmulti) return { status: 404, body: 'not found' };
      if (url.searchParams.get('bRef') === B_FAV) return json({ events: [...ev(S_ARD, 'Das Erste HD'), ...ev(S_ZDF, 'ZDF HD')], result: true });
      return json({ events: [], result: true });
    case '/api/epgservice':
      e2.serviceCalls++;
      return json({ events: ev(sRef!, sRef === S_RTL ? 'RTL' : 'X'), result: true });
  }
  if (url.pathname.startsWith('/picon/')) return { type: 'image/png', body: Buffer.from('89504e470d0a1a0a', 'hex') };
  return { status: 404, body: '{}' };
});

/* SAT>IP: a FRITZ!Box Cable (lists under /dvb/m3u/, description with X_SATIPCAP) and a generic server with an M3U. */
const desc = (name: string, maker: string, cap: string) => `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0"><device><deviceType>urn:ses-com:device:SatIPServer:1</deviceType>
<friendlyName>${name}</friendlyName><manufacturer>${maker}</manufacturer><modelName>Model X</modelName><modelNumber>7.57</modelNumber>
<satip:X_SATIPCAP xmlns:satip="urn:ses-com:satip">${cap}</satip:X_SATIPCAP></device></root>`;
const fritzUrl = await serve((_req, url) => {
  if (url.pathname === '/satipdesc.xml') return { type: 'text/xml', body: desc('FRITZ!Box 6591 Cable', 'AVM Berlin', 'DVBC-4') };
  if (url.pathname === '/dvb/m3u/tvhd.m3u') {
    return { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:0,Das Erste HD\n#EXTVLCOPT:network-caching=1000\nrtsp://192.168.178.1:554/?avm=1&freq=330&bw=8&msys=dvbc&mtype=256qam&sr=6900&specinv=0&pids=0,16,17,18,20,5100,5101\n#EXTINF:0,ZDF HD\nrtsp://192.168.178.1:554/?avm=1&freq=450&bw=8&msys=dvbc&mtype=256qam&sr=6900&specinv=0&pids=0,16,17,18,20,6100,6110\n' };
  }
  if (url.pathname === '/dvb/m3u/tvsd.m3u') return { type: 'audio/x-mpegurl', body: '#EXTM3U\n#EXTINF:0,arte\nrtsp://192.168.178.1:554/?avm=1&freq=346&msys=dvbc&pids=0,16,401,402\n' };
  if (url.pathname === '/dvb/m3u/radio.m3u') return { status: 404, body: '' };
  return { status: 404, body: '' };
});
let satipHttpStreams = 0;
const satipUrl = await serve((_req, url) => {
  if (url.pathname === '/desc.xml') return { type: 'text/xml', body: desc('Octopus NET', 'Digital Devices', 'DVBS2-2,DVBT-2') };
  if (url.pathname === '/channels.m3u') {
    return { type: 'audio/x-mpegurl', body: `#EXTM3U\n#EXTINF:-1 tvg-id="DasErste.de" group-title="Astra",Das Erste HD\nrtsp://sat.ip/?src=1&freq=11494&pol=h&ro=0.35&msys=dvbs2&mtype=8psk&plts=on&sr=22000&fec=23&pids=0,17,18,5100,5101\n#EXTINF:-1 group-title="Astra",ZDF HD\n?src=1&freq=11362&pol=h&msys=dvbs2&sr=22000&pids=0,17,18,6100,6110\n#EXTINF:-1 group-title="DVB-T2",HTTP channel\n${satipUrl}/?src=1&freq=11362\n` };
  }
  if (url.pathname === '/' && url.searchParams.get('src')) {
    satipHttpStreams++;
    return { type: 'video/mp2t', body: TS };
  }
  return { status: 404, body: '' };
});

/* ------------------------------ imports (after env) ------------------------------ */

const { db } = await import('../src/db.ts');
const live = await import('../src/services/livetv/livetv.ts');
const epg = await import('../src/services/livetv/epg/epg.ts');
const tuners = await import('../src/services/livetv/tuners/index.ts');
const { parseChallenge, digestHeader, TunerHttp } = await import('../src/services/livetv/tuners/http.ts');
const satip = await import('../src/services/livetv/tuners/satip.ts');
const { piconName, isMarker } = await import('../src/services/livetv/tuners/enigma2.ts');
const disc = await import('../src/services/livetv/tuners/discovery.ts');
const { updateSettings } = await import('../src/services/settings.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { buildApp } = await import('../src/app.ts');

const admin = await createUser({ username: 'tuneradmin', password: 'pw-123456', isAdmin: true });
const viewer = await createUser({ username: 'tunerviewer', password: 'pw-123456' });
const app = await buildApp();
after(() => app.close());
const tok = issueToken(admin.id, { deviceId: 'tuner-test', deviceName: 'test', platform: 'web' }).token;
const vtok = issueToken(viewer.id, { deviceId: 'tuner-test-v', deviceName: 'test', platform: 'web' }).token;
const req = async (method: string, url: string, body?: unknown, t = tok) => {
  const r = await app.inject({ method: method as any, url: `/api/v1${url}`, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, payload: body === undefined ? undefined : JSON.stringify(body) });
  let parsed: any = null;
  try {
    parsed = r.body ? JSON.parse(r.body) : null;
  } catch {
    parsed = null;
  }
  return { status: r.statusCode, json: parsed, raw: r.rawPayload, headers: r.headers };
};
const chans = (sourceId: string) => db.all('SELECT * FROM channels WHERE source_id = ? ORDER BY sort_order', sourceId);

/* ------------------------------ units ------------------------------ */

test('digest auth: RFC 2617 example and challenge parsing', () => {
  const c = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"')!;
  assert.equal(c.qop, 'auth');
  const h = digestHeader(c, 'Mufasa', 'Circle Of Life', 'GET', '/dir/index.html', 1, '0a4f113b');
  assert.match(h, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(h, /nc=00000001/);
  assert.equal(parseChallenge('Basic realm="x"'), null);
});

test('SAT>IP helpers: capabilities, placeholders, description, FFmpeg transport', () => {
  assert.deepEqual(satip.parseSatipCap('DVBS2-2,DVBT-2'), { total: 4, parts: ['DVB-S2 ×2', 'DVB-T ×2'] });
  assert.equal(satip.parseSatipCap('DVBC-4,DVBT2-2').total, 6);
  assert.equal(satip.parseSatipCap('').total, 0);
  assert.equal(satip.resolveSatipUrl('rtsp://sat.ip/?src=1&freq=11494', 'http://192.168.1.20'), 'rtsp://192.168.1.20/?src=1&freq=11494');
  assert.equal(satip.resolveSatipUrl('?src=1&freq=11494', '192.168.1.20:8080'), 'rtsp://192.168.1.20:554/?src=1&freq=11494');
  assert.equal(satip.resolveSatipUrl('http://10.0.0.5/?src=1', 'http://192.168.1.20'), 'http://10.0.0.5/?src=1');
  const d = satip.parseDescription(desc('FRITZ!Box 6591 Cable', 'AVM Berlin', 'DVBC-4'));
  assert.equal(d.tunerCount, 4);
  assert.equal(d.isFritzBox, true);
  assert.deepEqual(satip.ffmpegInputArgs('rtsp://x/?avm=1&freq=1', {}, false), ['-rtsp_transport', 'udp']);
  assert.deepEqual(satip.ffmpegInputArgs('rtsp://x/?src=1', {}, false), ['-rtsp_transport', 'tcp']);
  assert.deepEqual(satip.ffmpegInputArgs('rtsp://x/?src=1', { rtspTransport: 'udp' }, false), ['-rtsp_transport', 'udp']);
  assert.deepEqual(satip.ffmpegInputArgs('http://x/?src=1', {}, true), []);
});

test('Enigma2 helpers and option validation', () => {
  assert.equal(piconName(S_ARD), '1_0_19_283D_3FB_1_C00000_0_0_0');
  assert.ok(isMarker('1:64:1:0:0:0:0:0:0:0::--- News ---'));
  assert.ok(!isMarker(S_ARD));
  assert.throws(() => tuners.cleanOptions('enigma2', { streamPort: 70000 }), /Port/);
  assert.throws(() => tuners.cleanOptions('satip', { playlistUrl: 'file:///etc/passwd' }), /http/);
  assert.throws(() => tuners.cleanOptions('tvheadend', { profile: 'bad;rm' }), /profile/);
  assert.deepEqual(tuners.cleanOptions('satip', { fritzLists: ['tvhd', 'evil'] }).fritzLists, ['tvhd']);
  assert.equal(tuners.cleanOptions('tvheadend', { maxStreams: 2.4 }).maxStreams, 2);
});

/* ------------------------------ TVHeadend ------------------------------ */

let tvhId = '';

test('TVHeadend: test button reports tuners, channels, profiles; wrong password is a clear error', async () => {
  const bad = await req('POST', '/livetv/sources/test', { name: 'x', type: 'tvheadend', url: tvhUrl, username: TVH_USER, password: 'nope' });
  assert.equal(bad.status, 200);
  assert.equal(bad.json.ok, false);
  assert.match(bad.json.message, /Wrong username or password/);
  const closed = http.createServer();
  await new Promise<void>((r) => closed.listen(0, '127.0.0.1', () => r()));
  const closedPort = (closed.address() as AddressInfo).port;
  closed.close();
  const refused = await req('POST', '/livetv/sources/test', { name: 'x', type: 'tvheadend', url: `http://127.0.0.1:${closedPort}` });
  assert.equal(refused.json.ok, false);
  assert.match(refused.json.message, /refused/i);
  const ok = await req('POST', '/livetv/sources/test', { name: 'x', type: 'tvheadend', url: tvhUrl.replace('http://', ''), username: TVH_USER, password: TVH_PASS });
  assert.equal(ok.json.ok, true, ok.json.message);
  assert.equal(ok.json.tunerCount, 2);
  assert.equal(ok.json.liveCount, 3, 'disabled channels skipped');
  assert.deepEqual(ok.json.profiles, ['pass', 'matroska', 'htsp']);
  assert.match(ok.json.message, /4\.3-2345 · 2 tuners · 3 channels/);
  assert.equal((await req('POST', '/livetv/sources/test', { name: 'x', type: 'tvheadend', url: tvhUrl }, vtok)).status, 403);
});

test('TVHeadend: channels, tags, tuner limit, provider EPG matched by uuid, password write-only', async () => {
  const created = await req('POST', '/livetv/sources', { name: 'TVH', type: 'tvheadend', url: tvhUrl, username: TVH_USER, password: TVH_PASS, proxyStreams: false, options: { profile: 'matroska' } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  tvhId = created.json.id;
  assert.equal(created.json.password, '••••••••');
  assert.equal(created.json.proxyStreams, true, 'tuner sources are always restreamed');
  await live.refreshSource(tvhId);
  const s = live.listSources().find((x) => x.id === tvhId)!;
  assert.equal(s.lastError, null);
  assert.equal(s.channelCount, 3);
  assert.equal(s.maxConnections, 2);
  assert.equal(s.tunerCount, 2);
  assert.equal(s.deviceInfo?.tuners.length, 2);
  assert.equal(s.options?.profile, 'matroska');
  assert.ok(!JSON.stringify(live.listSources()).includes(TVH_PASS));
  const list = chans(tvhId);
  assert.deepEqual(list.map((c) => c.name), ['Das Erste HD', 'ZDF HD', 'arte']);
  assert.ok(!list.some((c) => c.stream_url.includes(TVH_PASS)), 'no credentials stored in channel rows');
  assert.equal(list[0].stream_url, `${tvhUrl}/stream/channel/${'a'.repeat(32)}?profile=matroska`);
  const cats = live.listCategories(admin, tvhId);
  assert.deepEqual(cats.map((c) => c.name), ['HD', 'SD'], 'internal tags hidden, ordered by index');
  // Guide: provider guide with the TVHeadend driver, priority 0, channels matched by id.
  const g = epg.listEpgSources().find((x) => x.ownerSourceId === tvhId)!;
  assert.equal(g.kind, 'provider');
  assert.equal(g.priority, 0);
  assert.equal(g.config.url, 'TVHeadend EPG API');
  assert.equal(g.report.channels, 3);
  const ard = list[0];
  assert.equal(ard.guide_status, 'auto');
  assert.equal(ard.guide_method, 'id');
  const progs = live.channelPrograms(admin, ard.id);
  assert.ok(progs.some((p) => p.title === 'Das Erste HD show 0' && p.category === 'News' && p.episodeNum === 'S02E05'));
  assert.ok(live.getChannel(admin, ard.id).nowPlaying?.title.startsWith('Das Erste HD show'));
  // Icons: imagecache URL with the login (fetched through the authenticating client).
  const logo = live.getChannel(admin, ard.id).logoUrl!;
  const img = await req('GET', logo.replace('/api/v1', ''));
  assert.equal(img.status, 200);
  assert.deepEqual([...img.raw], [...Buffer.from('89504e470d0a1a0a', 'hex')]);
});

test('TVHeadend: restream with Digest auth, profile, and recordings list', async () => {
  const ard = chans(tvhId)[0];
  assert.match(live.channelStreamUrl(ard), new RegExp(`^http://${TVH_USER}:${TVH_PASS}@127\\.0\\.0\\.1`), 'FFmpeg gets the login in the URL');
  const play = await req('POST', `/livetv/channels/${ard.id}/play`, { deviceProfile: { containers: ['ts'] } });
  assert.equal(play.status, 200, JSON.stringify(play.json));
  assert.match(play.json.url, /^\/api\/v1\/livetv\/stream\//);
  const st = await app.inject({ method: 'GET', url: play.json.url });
  assert.equal(st.statusCode, 200);
  assert.equal(st.headers['content-type'], 'video/mp2t');
  assert.equal(st.rawPayload.length, TS.length);
  assert.equal(tvh.streams, 1);
  const recs = await req('GET', `/livetv/sources/${tvhId}/recordings`);
  assert.equal(recs.status, 200);
  assert.equal(recs.json[0].title, 'Tatort');
  assert.equal(recs.json[0].channelName, 'Das Erste HD');
  const file = await req('GET', `/livetv/sources/${tvhId}/recordings/${recs.json[0].id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.raw.length, TS.length);
  assert.equal((await req('GET', `/livetv/sources/${tvhId}/recordings`, undefined, vtok)).status, 403);
});

test('TVHeadend: streaming-only user falls back to /playlist/channels.m3u', async () => {
  tvh.gridForbidden = true;
  try {
    const r = await tuners.syncTuner({ type: 'tvheadend', url: tvhUrl, username: TVH_USER, password: TVH_PASS, options: {} });
    assert.equal(r.channels.length, 1);
    assert.equal(r.channels[0].remoteId, 'a'.repeat(32));
    assert.equal(r.channels[0].streamUrl, `${tvhUrl}/stream/channel/${'a'.repeat(32)}?profile=pass`);
    assert.ok(r.warnings[0].includes('playlist'));
  } finally {
    tvh.gridForbidden = false;
  }
});

/* ------------------------------ Enigma2 ------------------------------ */

test('Enigma2: bouquets in the test result, bouquet selection, markers skipped, picons, EPG with fallback', async () => {
  const t = await req('POST', '/livetv/sources/test', { name: 'Vu', type: 'enigma2', url: e2Url, username: E2_USER, password: E2_PASS });
  assert.equal(t.json.ok, true, t.json.message);
  assert.equal(t.json.tunerCount, 2);
  assert.deepEqual(t.json.bouquets.map((b: any) => b.name), ['Favourites (TV)', 'Deutschland']);
  assert.equal(t.json.liveCount, 2, 'first bouquet by default, marker skipped');
  assert.equal((await req('POST', '/livetv/sources/test', { name: 'Vu', type: 'enigma2', url: e2Url })).json.ok, false);

  const port = Number(new URL(e2Url).port);
  const created = await req('POST', '/livetv/sources', { name: 'Vu+', type: 'enigma2', url: e2Url, username: E2_USER, password: E2_PASS, options: { bouquets: [B_FAV, B_DE], streamPort: port, streamAuth: true } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const id = created.json.id;
  await live.refreshSource(id);
  const s = live.listSources().find((x) => x.id === id)!;
  assert.equal(s.lastError, null);
  assert.equal(s.maxConnections, 2);
  const list = chans(id);
  assert.deepEqual(list.map((c) => c.name), ['Das Erste HD', 'ZDF HD', 'RTL'], 'duplicates across bouquets imported once');
  assert.equal(list[0].stream_url, `http://127.0.0.1:${port}/${S_ARD}`);
  assert.deepEqual(live.listCategories(admin, id).map((c) => c.name), ['Favourites (TV)', 'Deutschland']);
  // EPG: epgmulti covered ARD + ZDF; RTL came from epgservice.
  assert.equal(e2.serviceCalls, 1);
  const g = epg.listEpgSources().find((x) => x.ownerSourceId === id)!;
  assert.equal(g.config.url, 'OpenWebif EPG API');
  for (const c of list) assert.equal(c.guide_method, 'id', c.name);
  assert.ok(live.channelPrograms(admin, list[2].id).some((p) => p.title === 'RTL event 1'));
  // Picon through Basic auth.
  const logo = live.getChannel(admin, list[0].id).logoUrl!;
  assert.equal((await req('GET', logo.replace('/api/v1', ''))).status, 200);
  // Restream with streamauth.
  const play = await req('POST', `/livetv/channels/${list[1].id}/play`, { deviceProfile: { containers: ['ts'] } });
  const st = await app.inject({ method: 'GET', url: play.json.url });
  assert.equal(st.statusCode, 200);
  assert.equal(st.rawPayload.length, TS.length);
  assert.equal(e2.streams, 1);
  // Old OpenWebif without epgmulti: every service from epgservice.
  e2.epgmulti = false;
  e2.serviceCalls = 0;
  await epg.refreshEpgSource(g.id);
  assert.equal(e2.serviceCalls, 3);
  assert.ok(live.channelPrograms(admin, list[0].id).length >= 3);
  // Editing: the bouquet list changes, the password stays.
  const upd = await req('PATCH', `/livetv/sources/${id}`, { options: { bouquets: [B_DE] } });
  assert.equal(upd.status, 200);
  assert.deepEqual(upd.json.options.bouquets, [B_DE]);
  assert.equal(db.get('SELECT password FROM live_sources WHERE id = ?', id)!.password, E2_PASS);
  // Test from the edit form without retyping the password.
  const t2 = await req('POST', '/livetv/sources/test', { name: 'Vu', type: 'enigma2', url: e2Url, username: E2_USER, sourceId: id, options: { bouquets: [B_DE] } });
  assert.equal(t2.json.ok, true, t2.json.message);
  assert.equal(t2.json.liveCount, 2);
});

/* ------------------------------ SAT>IP ------------------------------ */

test('SAT>IP: FRITZ!Box preset lists, tuner count from X_SATIPCAP, UDP transport', async () => {
  const opts = { satipMode: 'fritzbox', fritzLists: ['tvhd', 'tvsd', 'radio'], descriptionUrl: `${fritzUrl}/satipdesc.xml` };
  const t = await req('POST', '/livetv/sources/test', { name: 'Fritz', type: 'satip', url: fritzUrl, options: opts });
  assert.equal(t.json.ok, true, t.json.message);
  assert.equal(t.json.tunerCount, 4);
  assert.equal(t.json.liveCount, 3);
  assert.ok(t.json.warnings.some((w: string) => w.startsWith('radio.m3u')));
  const created = await req('POST', '/livetv/sources', { name: 'FRITZ!Box', type: 'satip', url: fritzUrl, options: opts });
  const id = created.json.id;
  await live.refreshSource(id);
  const s = live.listSources().find((x) => x.id === id)!;
  assert.equal(s.lastError, null);
  assert.equal(s.maxConnections, 4);
  assert.equal(s.deviceInfo?.name, 'FRITZ!Box 6591 Cable');
  assert.deepEqual(live.listCategories(admin, id).map((c) => c.name), ['TV (HD)', 'TV (SD)']);
  const ard = chans(id)[0];
  assert.match(ard.stream_url, /^rtsp:\/\/192\.168\.178\.1:554\/\?avm=1&freq=330/);
  assert.deepEqual(live.channelInputArgs(ard).slice(0, 2), ['-rtsp_transport', 'udp']);
  assert.equal(epg.listEpgSources().filter((g) => g.ownerSourceId === id && g.managedBy === 'provider').length, 0, 'no provider guide: XMLTV guides are matched by name');
  // maxStreams overrides the tuner count.
  await req('PATCH', `/livetv/sources/${id}`, { options: { maxStreams: 1 } });
  await live.refreshSource(id);
  assert.equal(live.listSources().find((x) => x.id === id)!.maxConnections, 1);
});

test('SAT>IP: generic server with an M3U (sat.ip placeholder, bare queries), HTTP restream, RTSP errors', async () => {
  const created = await req('POST', '/livetv/sources', { name: 'Octopus', type: 'satip', url: satipUrl, options: { satipMode: 'm3u', playlistUrl: `${satipUrl}/channels.m3u`, descriptionUrl: `${satipUrl}/desc.xml` } });
  const id = created.json.id;
  await live.refreshSource(id);
  const s = live.listSources().find((x) => x.id === id)!;
  assert.equal(s.lastError, null);
  assert.equal(s.tunerCount, 4);
  const list = chans(id);
  assert.equal(list[0].stream_url, 'rtsp://127.0.0.1/?src=1&freq=11494&pol=h&ro=0.35&msys=dvbs2&mtype=8psk&plts=on&sr=22000&fec=23&pids=0,17,18,5100,5101');
  assert.equal(list[0].epg_channel_id, 'DasErste.de');
  assert.equal(list[1].stream_url, 'rtsp://127.0.0.1:554/?src=1&freq=11362&pol=h&msys=dvbs2&sr=22000&pids=0,17,18,6100,6110');
  assert.deepEqual(live.channelInputArgs(list[0]).slice(0, 2), ['-rtsp_transport', 'tcp']);
  // HTTP SAT>IP URL restreams directly.
  const play = await req('POST', `/livetv/channels/${list[2].id}/play`, { deviceProfile: { containers: ['ts'] } });
  const st = await app.inject({ method: 'GET', url: play.json.url });
  assert.equal(st.statusCode, 200);
  assert.equal(satipHttpStreams, 1);
  // RTSP: FFmpeg remux; a dead server becomes a readable 502, not an empty 200.
  // (Separate sources: in fallback mode another test source's copy of this channel would take over.)
  updateSettings({ liveTvSourceMode: 'separate' });
  db.run('UPDATE channels SET stream_url = ? WHERE id = ?', 'rtsp://127.0.0.1:1/?src=1&freq=1', list[0].id);
  const play2 = await req('POST', `/livetv/channels/${list[0].id}/play`, { deviceProfile: { containers: ['ts'] } });
  const st2 = await app.inject({ method: 'GET', url: play2.json.url });
  assert.equal(st2.statusCode, 502);
  assert.match(JSON.parse(st2.body).message ?? JSON.parse(st2.body).error, /tuner refused|FFmpeg/i);
  updateSettings({ liveTvSourceMode: 'failover' });
  // Missing playlist: a helpful error.
  const t = await req('POST', '/livetv/sources/test', { name: 'x', type: 'satip', url: 'http://127.0.0.1:1', options: { satipMode: 'm3u' } });
  assert.equal(t.json.ok, false);
  assert.match(t.json.message, /M3U/);
});

/* ------------------------------ discovery ------------------------------ */

test('SSDP discovery finds SAT>IP servers and reads their description', async () => {
  const sock = dgram.createSocket('udp4');
  sockets.push(sock);
  let searched = '';
  sock.on('message', (msg, rinfo) => {
    searched = msg.toString();
    const reply = ['HTTP/1.1 200 OK', 'CACHE-CONTROL: max-age=1800', `LOCATION: ${fritzUrl}/satipdesc.xml`, 'SERVER: Linux/2.6 UPnP/1.1 AVM FRITZ!Box/7.57', `ST: ${disc.SATIP_ST}`, 'USN: uuid:fa095ecc-e13e-40e7-8e6c-001A4FABCDEF::urn:ses-com:device:SatIPServer:1', '', ''].join('\r\n');
    sock.send(reply, rinfo.port, rinfo.address);
    // An unrelated UPnP device answering too.
    sock.send(['HTTP/1.1 200 OK', 'LOCATION: http://127.0.0.1:9/x.xml', 'ST: urn:schemas-upnp-org:device:MediaRenderer:1', '', ''].join('\r\n'), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  process.env.MEDIAMAX_SSDP_TARGET = `127.0.0.1:${(sock.address() as AddressInfo).port}`;
  const found = await disc.discoverSatip(800);
  assert.match(searched, /^M-SEARCH \* HTTP\/1\.1/);
  assert.match(searched, /ST: urn:ses-com:device:SatIPServer:1/);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'FRITZ!Box 6591 Cable');
  assert.equal(found[0].tunerCount, 4);
  assert.equal(found[0].isFritzBox, true);
  assert.equal(found[0].address, 'http://127.0.0.1');
  assert.equal(found[0].descriptionUrl, `${fritzUrl}/satipdesc.xml`);
  assert.equal(found[0].deviceId, 'fa095ecc-e13e-40e7-8e6c-001A4FABCDEF');
});

test('HDHomeRun UDP discovery packet and reply parsing; discover endpoint', async () => {
  const pkt = disc.hdhrDiscoverPacket();
  assert.equal(pkt.readUInt16BE(0), 2);
  assert.equal(disc.crc32(Buffer.from('123456789')), 0xcbf43926);
  const sock = dgram.createSocket('udp4');
  sockets.push(sock);
  sock.on('message', (msg, rinfo) => {
    if (msg.readUInt16BE(0) !== 2) return;
    const url = Buffer.from('http://127.0.0.1:5004');
    const payload = Buffer.concat([Buffer.from([0x01, 4, 0, 0, 0, 1, 0x02, 4, 0x10, 0x5a, 0x3b, 0x1c, 0x10, 1, 4, 0x2a, url.length]), url]);
    const head = Buffer.alloc(4);
    head.writeUInt16BE(3, 0);
    head.writeUInt16BE(payload.length, 2);
    const body = Buffer.concat([head, payload]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32LE(disc.crc32(body), 0);
    sock.send(Buffer.concat([body, crc]), rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  process.env.MEDIAMAX_HDHR_DISCOVER_TARGET = `127.0.0.1:${(sock.address() as AddressInfo).port}`;
  const found = await disc.discoverHdhomerun(500);
  assert.equal(found.length, 1);
  assert.equal(found[0].deviceId, '105A3B1C');
  assert.equal(found[0].tunerCount, 4);
  assert.equal(found[0].address, 'http://127.0.0.1:5004');
  const r = await req('GET', '/livetv/tuners/discover');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.map((d: any) => d.kind).sort(), ['hdhomerun', 'satip']);
  assert.equal((await req('GET', '/livetv/tuners/discover', undefined, vtok)).status, 403);
});

test('TunerHttp caches the Digest challenge (one round trip per request after the first)', async () => {
  const c = new TunerHttp({ username: TVH_USER, password: TVH_PASS });
  await c.json(`${tvhUrl}/api/serverinfo`);
  const after1 = c.requests;
  await c.json(`${tvhUrl}/api/serverinfo`);
  assert.equal(after1, 2);
  assert.equal(c.requests, 3);
});
