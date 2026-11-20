import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const xml = await import('../src/services/renderers/xml.ts');
const stream = await import('../src/services/renderers/stream.ts');
const ssdp = await import('../src/services/renderers/ssdp.ts');
const mdns = await import('../src/services/renderers/mdns.ts');
const lan = await import('../src/services/renderers/lan.ts');

/* ------------------------------- pure helpers ------------------------------ */

test('xml: escaping and DIDL-Lite generation', () => {
  assert.equal(xml.xmlEscape(`Tom & Jerry <"Live"> 'n'\u0001`), 'Tom &amp; Jerry &lt;&quot;Live&quot;&gt; &apos;n&apos;');
  const didl = xml.didlLite({
    id: 'mediamax:1', title: 'Fast & <Furious>', upnpClass: 'object.item.videoItem.movie', artUrl: 'http://10.0.0.2:8484/api/v1/images/a?w=600&x=1',
    res: { url: 'http://10.0.0.2:8484/s/a.mp4?x=1&y=2', protocolInfo: xml.protocolInfo('video/mp4', xml.dlnaFeatures({ pn: 'AVC_MP4_MP_HD_AAC', transcoded: false })), durationMs: 3723004, size: 1234, resolution: '1920x1080' },
    subtitleUrl: 'http://10.0.0.2:8484/s/a.srt',
  });
  assert.match(didl, /<dc:title>Fast &amp; &lt;Furious&gt;<\/dc:title>/);
  assert.match(didl, /protocolInfo="http-get:\*:video\/mp4:DLNA\.ORG_PN=AVC_MP4_MP_HD_AAC;DLNA\.ORG_OP=01;DLNA\.ORG_CI=0;DLNA\.ORG_FLAGS=01700000000000000000000000000000"/);
  assert.match(didl, /duration="1:02:03\.004"/);
  assert.match(didl, />http:\/\/10\.0\.0\.2:8484\/s\/a\.mp4\?x=1&amp;y=2<\/res>/);
  assert.match(didl, /<sec:CaptionInfoEx sec:type="srt">http:\/\/10\.0\.0\.2:8484\/s\/a\.srt<\/sec:CaptionInfoEx>/);
  assert.match(didl, /xmlns:sec="http:\/\/www\.sec\.co\.kr\/"/);
  assert.ok(!/<[^>]*Furious/.test(didl.replace(/&lt;Furious&gt;/, '')), 'no raw markup from the title');

  // Inside SOAP the whole DIDL document is escaped once more and must round-trip exactly.
  const env = xml.soapEnvelope('urn:schemas-upnp-org:service:AVTransport:1', 'SetAVTransportURI', [['InstanceID', 0], ['CurrentURI', 'http://h/a?b=1&c=2'], ['CurrentURIMetaData', didl]]);
  assert.ok(!env.includes('<DIDL-Lite'), 'DIDL is escaped inside the envelope');
  assert.equal(xml.xmlText(env, 'CurrentURIMetaData'), didl);
  assert.equal(xml.xmlText(env, 'CurrentURI'), 'http://h/a?b=1&c=2');
});

test('xml: H:MM:SS formatting/parsing and SOAP faults', () => {
  assert.equal(xml.formatHms(0), '0:00:00');
  assert.equal(xml.formatHms(3_723_004), '1:02:03');
  assert.equal(xml.formatHms(61_500, true), '0:01:01.500');
  assert.equal(xml.parseHms('1:02:03'), 3_723_000);
  assert.equal(xml.parseHms('00:00:07.250'), 7250);
  assert.equal(xml.parseHms('NOT_IMPLEMENTED'), null);
  assert.equal(xml.parseHms(''), null);
  const fault = '<s:Envelope><s:Body><s:Fault><faultstring>UPnPError</faultstring><detail><UPnPError><errorCode>701</errorCode><errorDescription>Transition not available</errorDescription></UPnPError></detail></s:Fault></s:Body></s:Envelope>';
  assert.deepEqual(xml.soapFault(fault), { code: 701, description: 'Transition not available' });
  assert.equal(xml.soapFault('<ok/>'), null);
});

test('stream: format choice from the renderer Sink list', () => {
  const video = { container: 'mkv', videoCodec: 'h264', audioCodec: 'aac', isAudio: false, nonDefaultAudio: false, remote: false };
  const mkvSink = 'http-get:*:video/x-matroska:*,http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_AAC,http-get:*:audio/mpeg:DLNA.ORG_PN=MP3';
  assert.equal(stream.chooseFormat('dlna', mkvSink, video).method, 'direct');
  assert.equal(stream.chooseFormat('dlna', mkvSink, video).mime, 'video/x-matroska');
  // No MKV in the list → MPEG-TS transcode, keeping H.264 video.
  const ts = stream.chooseFormat('dlna', 'http-get:*:video/mp4:*,http-get:*:video/mpeg:DLNA.ORG_PN=AVC_TS_MP_HD_AAC_MULT5_ISO', video);
  assert.equal(ts.method, 'transcode');
  assert.equal(ts.f, 'ts');
  assert.equal(ts.copyVideo, true);
  assert.equal(ts.pn, 'AVC_TS_MP_HD_AAC_MULT5_ISO');
  assert.match(ts.protocolInfo, /DLNA\.ORG_OP=00;DLNA\.ORG_CI=1/);
  // HEVC only direct when the device mentions it; DTS audio always converts.
  assert.equal(stream.chooseFormat('dlna', mkvSink, { ...video, videoCodec: 'hevc' }).method, 'transcode');
  assert.equal(stream.chooseFormat('dlna', mkvSink + ',http-get:*:video/x-matroska:DLNA.ORG_PN=HEVC_MKV', { ...video, videoCodec: 'hevc' }).method, 'direct');
  assert.equal(stream.chooseFormat('dlna', mkvSink, { ...video, audioCodec: 'dts' }).method, 'transcode');
  // Only MP4 listed → fragmented MP4.
  assert.equal(stream.chooseFormat('dlna', 'http-get:*:video/mp4:*', { ...video, videoCodec: 'vp9' }).f, 'mp4');
  // Kodi always gets the original.
  assert.equal(stream.chooseFormat('kodi', '', { ...video, videoCodec: 'av1', audioCodec: 'truehd' }).method, 'direct');
  // Audio: FLAC direct when listed; lossless → FLAC, otherwise MP3; Sonos native formats.
  const flac = { container: 'flac', videoCodec: null, audioCodec: 'flac', isAudio: true, nonDefaultAudio: false, remote: false };
  assert.equal(stream.chooseFormat('dlna', 'http-get:*:audio/flac:*', flac).method, 'direct');
  assert.equal(stream.chooseFormat('dlna', 'http-get:*:audio/mpeg:*,http-get:*:audio/x-flac:*', { ...flac, container: 'wav', audioCodec: 'pcm_s16le' }).f, 'flac');
  assert.equal(stream.chooseFormat('dlna', 'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3', { ...flac, container: 'ogg', audioCodec: 'vorbis' }).f, 'mp3');
  assert.equal(stream.chooseFormat('dlna', 'http-get:*:audio/mpeg:DLNA.ORG_PN=MP3', { ...flac, container: 'ogg', audioCodec: 'vorbis' }).pn, 'MP3');
  assert.equal(stream.chooseFormat('sonos', 'http-get:*:audio/flac:*', flac).method, 'direct');
  assert.equal(stream.chooseFormat('sonos', 'http-get:*:*:*', { ...flac, container: 'opus', audioCodec: 'opus' }).f, 'mp3');
  // Empty / unknown Sink list: DLNA baseline.
  assert.equal(stream.chooseFormat('dlna', '', { ...video, container: 'mp4' }).method, 'direct');
  assert.equal(stream.chooseFormat('dlna', '', video).f, 'ts');
});

test('stream: signed URLs are tamper-proof and expire', () => {
  const c = { s: 'sess', m: 'media1', f: 'direct' as const, t: 0, a: null, x: Math.floor(Date.now() / 1000) + 60 };
  const tok = stream.signStream(c);
  assert.deepEqual(stream.verifyStream(tok), c);
  const [body, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ ...c, m: 'other' })).toString('base64url');
  assert.equal(stream.verifyStream(`${forged}.${sig}`), null);
  assert.equal(stream.verifyStream(`${body}.${sig.slice(0, -2)}AA`), null);
  assert.equal(stream.verifyStream(`${body}`), null);
  assert.equal(stream.verifyStream(stream.signStream({ ...c, x: Math.floor(Date.now() / 1000) - 1 })), null);
  assert.ok(stream.streamExpiry(2 * 3600_000) - Date.now() / 1000 >= 4 * 3600 - 1);
});

test('stream: ffmpeg args and subtitle conversion', () => {
  const ts = stream.transcodeArgs({ input: '/m/a.mkv', f: 'ts', startSec: 90, audioIndex: 2, copyVideo: false, bitrate: 8000, sourceHeight: 2160, hdr: true, toneMap: 'tm' });
  assert.deepEqual(ts.slice(ts.indexOf('-ss'), ts.indexOf('-ss') + 4), ['-ss', '90', '-i', '/m/a.mkv']);
  assert.ok(ts.includes('0:2'));
  assert.ok(ts.join(' ').includes('tm,scale=-2:1080,format=yuv420p'));
  assert.equal(ts.at(-1), 'pipe:1');
  assert.ok(ts.includes('mpegts'));
  const mp3 = stream.transcodeArgs({ input: '/m/a.ogg', f: 'mp3', startSec: 0, audioIndex: null, copyVideo: false, bitrate: 0, sourceHeight: null, hdr: false });
  assert.ok(mp3.includes('libmp3lame') && mp3.includes('-vn') && !mp3.includes('-ss'));
  const srt = stream.vttToSrt('WEBVTT\n\n00:00:05.000 --> 00:00:07.500\nOld\n\n01:00:10.000 --> 01:00:12.000\n<i>Hello</i>\n', 3_600_000);
  assert.equal(srt, '1\n00:00:10,000 --> 00:00:12,000\nHello\n');
});

test('ssdp: SSDP headers and a Sonos-style description with embedded MediaRenderer', () => {
  const h = ssdp.parseSsdp('HTTP/1.1 200 OK\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nLocation: http://192.168.1.20:1400/xml/device_description.xml\r\n\r\n');
  assert.equal(h.location, 'http://192.168.1.20:1400/xml/device_description.xml');
  const desc = `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType><friendlyName>Kitchen &amp; Dining</friendlyName><manufacturer>Sonos, Inc.</manufacturer><modelName>Sonos One</modelName>
    <UDN>uuid:RINCON_000E58AABBCC01400</UDN><iconList><icon><mimetype>image/png</mimetype><url>/img/icon.png</url></icon></iconList>
    <deviceList><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:RINCON_000E58AABBCC01400_MR</UDN>
      <serviceList>
        <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/MediaRenderer/RenderingControl/Control</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/MediaRenderer/ConnectionManager/Control</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/MediaRenderer/AVTransport/Control</controlURL></service>
        <service><serviceType>urn:schemas-upnp-org:service:GroupRenderingControl:1</serviceType><controlURL>/MediaRenderer/GroupRenderingControl/Control</controlURL></service>
      </serviceList></device></deviceList></device></root>`;
  const d = ssdp.parseDescription(desc, 'http://192.168.1.20:1400/xml/device_description.xml')!;
  assert.equal(d.friendlyName, 'Kitchen & Dining');
  assert.equal(d.isSonos, true);
  assert.equal(d.rinconId, 'RINCON_000E58AABBCC01400');
  assert.equal(d.avTransport?.controlUrl, 'http://192.168.1.20:1400/MediaRenderer/AVTransport/Control');
  assert.equal(d.groupRenderingControl?.controlUrl, 'http://192.168.1.20:1400/MediaRenderer/GroupRenderingControl/Control');
  assert.equal(d.iconUrl, 'http://192.168.1.20:1400/img/icon.png');
  assert.equal(ssdp.parseDescription('<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType></device></root>', 'http://x/'), null);
});

test('mdns: PTR query encoding and SRV/A answer parsing', () => {
  const q = mdns.encodeQuery('_xbmc-jsonrpc-h._tcp.local');
  assert.equal(q.readUInt16BE(4), 1);
  assert.equal(q.subarray(12, 13)[0], '_xbmc-jsonrpc-h'.length);
  // Build an answer: PTR → "Living Room._xbmc-jsonrpc-h._tcp.local", SRV port 8080 → kodi.local, A 192.168.1.30.
  const name = (n: string) => Buffer.concat([...n.split('.').map((l) => Buffer.concat([Buffer.from([Buffer.byteLength(l)]), Buffer.from(l)])), Buffer.from([0])]);
  const rr = (n: string, type: number, rdata: Buffer) => Buffer.concat([name(n), Buffer.from([0, type, 0, 1, 0, 0, 0, 120, rdata.length >> 8, rdata.length & 0xff]), rdata]);
  const svc = '_xbmc-jsonrpc-h._tcp.local';
  const inst = `Living Room.${svc}`;
  const pkt = Buffer.concat([
    Buffer.from([0, 0, 0x84, 0, 0, 0, 0, 1, 0, 0, 0, 2]),
    rr(svc, 12, name(inst)),
    rr(inst, 33, Buffer.concat([Buffer.from([0, 0, 0, 0, 0x1f, 0x90]), name('kodi.local')])),
    rr('kodi.local', 1, Buffer.from([192, 168, 1, 30])),
  ]);
  const recs = mdns.parseRecords(pkt);
  assert.equal(recs[0].data.ptr, inst);
  assert.equal(recs[1].data.port, 8080);
  assert.equal(recs[1].data.target, 'kodi.local');
  assert.equal(recs[2].data.address, '192.168.1.30');
});

test('lan: only private addresses; device fetches pinned to the device host', async () => {
  assert.equal(lan.isLanAddress('192.168.1.5'), true);
  assert.equal(lan.isLanAddress('10.1.2.3'), true);
  assert.equal(lan.isLanAddress('8.8.8.8'), false);
  assert.equal(lan.isLanAddress('239.255.255.250'), false);
  assert.equal(lan.isLanAddress('169.254.169.254'), true); // link-local is LAN, but cloud metadata isn't reachable through a renderer
  await assert.rejects(lan.resolveLanHost('8.8.8.8'), /local network/);
  assert.equal(await lan.resolveLanHost('8.8.8.8', true), '8.8.8.8');
  await assert.rejects(lan.deviceFetch('http://10.0.0.9/x', '10.0.0.8'), /not on the device's host/);
  await assert.rejects(lan.deviceFetch('file:///etc/passwd', '10.0.0.8'), /http/);
});

/* ------------------------------ mock devices ------------------------------- */

interface Call { action: string; body: string }

function mockRenderer() {
  const calls: Call[] = [];
  const st = { transport: 'NO_MEDIA_PRESENT', rel: '0:00:00', dur: '0:00:00', uri: '' };
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const port = (server.address() as AddressInfo).port;
      if (req.url === '/desc.xml') {
        res.setHeader('Content-Type', 'text/xml');
        return res.end(`<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major></specVersion><device>
          <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>Mock TV</friendlyName><manufacturer>Samsung Electronics</manufacturer><modelName>UE55</modelName>
          <UDN>uuid:mock-tv-${port}</UDN><serviceList>
          <service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/upnp/control/AVTransport1</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType><controlURL>/upnp/control/RenderingControl1</controlURL></service>
          <service><serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType><controlURL>/upnp/control/ConnectionManager1</controlURL></service>
          </serviceList></device></root>`);
      }
      const action = String(req.headers.soapaction ?? '').replace(/"/g, '').split('#')[1] ?? '';
      calls.push({ action, body });
      const out: Record<string, string> = {};
      if (action === 'SetAVTransportURI') {
        st.uri = xml.xmlText(body, 'CurrentURI') ?? '';
        st.transport = 'STOPPED';
      }
      if (action === 'Play') st.transport = 'PLAYING';
      if (action === 'Pause') st.transport = 'PAUSED_PLAYBACK';
      if (action === 'Stop') st.transport = 'STOPPED';
      if (action === 'Seek') st.rel = xml.xmlText(body, 'Target') ?? st.rel;
      if (action === 'GetProtocolInfo') {
        out.Source = '';
        out.Sink = 'http-get:*:video/mp4:DLNA.ORG_PN=AVC_MP4_MP_HD_AAC,http-get:*:video/mpeg:*,http-get:*:audio/mpeg:DLNA.ORG_PN=MP3';
      }
      if (action === 'GetTransportInfo') Object.assign(out, { CurrentTransportState: st.transport, CurrentTransportStatus: 'OK', CurrentSpeed: '1' });
      if (action === 'GetPositionInfo') Object.assign(out, { Track: '1', TrackDuration: st.dur, TrackURI: st.uri, RelTime: st.rel, AbsTime: 'NOT_IMPLEMENTED' });
      if (action === 'GetVolume') out.CurrentVolume = '25';
      if (action === 'GetMute') out.CurrentMute = '0';
      res.setHeader('Content-Type', 'text/xml; charset="utf-8"');
      res.end(`<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="x">${Object.entries(out).map(([k, v]) => `<${k}>${xml.xmlEscape(v)}</${k}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`);
    });
  });
  return { server, calls, st };
}

function mockKodi() {
  const calls: { method: string; params: any }[] = [];
  const st = { playing: false, speed: 1, time: 0, file: '', volume: 60, muted: false };
  const t = (ms: number) => ({ hours: Math.floor(ms / 3600000), minutes: Math.floor(ms / 60000) % 60, seconds: Math.floor(ms / 1000) % 60, milliseconds: ms % 1000 });
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const j = JSON.parse(body);
      calls.push({ method: j.method, params: j.params });
      let result: unknown = 'OK';
      switch (j.method) {
        case 'Player.Open': st.playing = true; st.file = j.params.item.file; st.time = 0; break;
        case 'Player.GetActivePlayers': result = st.playing ? [{ playerid: 1, type: 'video' }] : []; break;
        case 'Player.GetProperties': result = { time: t(st.time), totaltime: t(7_200_000), speed: st.speed }; break;
        case 'Player.GetItem': result = { item: { file: st.file } }; break;
        case 'Player.PlayPause': st.speed = j.params.play ? 1 : 0; result = { speed: st.speed }; break;
        case 'Player.Stop': st.playing = false; break;
        case 'Player.Seek': st.time = ((j.params.value.time.hours * 60 + j.params.value.time.minutes) * 60 + j.params.value.time.seconds) * 1000; break;
        case 'Application.GetProperties': result = { volume: st.volume, muted: st.muted, name: 'Kodi' }; break;
        case 'Application.SetVolume': st.volume = j.params.volume; result = st.volume; break;
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: j.id, result }));
    });
  });
  return { server, calls, st };
}

const listen = (s: http.Server) => new Promise<number>((r) => s.listen(0, '127.0.0.1', () => r((s.address() as AddressInfo).port)));

/* ---------------------------- end-to-end via API ---------------------------- */

const { db } = await import('../src/db.ts');
const { createUser, issueToken } = await import('../src/services/auth.ts');
const { setKv } = await import('../src/services/settings.ts');
const { listSessions } = await import('../src/services/playback.ts');
const renderers = await import('../src/services/renderers/index.ts');
const { buildApp } = await import('../src/app.ts');

const tv = mockRenderer();
const kodi = mockKodi();
const tvPort = await listen(tv.server);
const kodiPort = await listen(kodi.server);
// SSDP responder for the mock TV (unicast on loopback, the discovery target is configurable for tests).
const ssdpSock = dgram.createSocket('udp4');
await new Promise<void>((r) => ssdpSock.bind(0, '127.0.0.1', () => r()));
ssdpSock.on('message', (msg, rinfo) => {
  if (!msg.toString().includes('MediaRenderer:1')) return;
  ssdpSock.send(`HTTP/1.1 200 OK\r\nCACHE-CONTROL: max-age=1800\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nUSN: uuid:mock-tv::urn:schemas-upnp-org:device:MediaRenderer:1\r\nLOCATION: http://127.0.0.1:${tvPort}/desc.xml\r\n\r\n`, rinfo.port, rinfo.address);
});
process.env.MEDIAMAX_RENDERER_SSDP_ADDR = '127.0.0.1';
process.env.MEDIAMAX_RENDERER_SSDP_PORT = String((ssdpSock.address() as AddressInfo).port);
setKv('renderers.settings', { enabled: true, mdns: false, allowPublicHosts: false, streamBaseUrl: null });

const app = await buildApp();
after(async () => {
  renderers._test.reset();
  await app.close();
  tv.server.close();
  kodi.server.close();
  ssdpSock.close();
});

const now = new Date().toISOString();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-renderer-'));
const file = path.join(dir, 'movie.mp4');
fs.writeFileSync(file, Buffer.alloc(4096, 7));
db.insert('libraries', { id: 'lib-r', name: 'Movies', type: 'movies', paths: '[]', created_at: now });
db.insert('items', { id: 'mov-r', library_id: 'lib-r', type: 'movie', title: 'Tom & Jerry <Live>', sort_title: 'tom', year: 2020, added_at: now, updated_at: now });
db.insert('media', { id: 'med-r', item_id: 'mov-r', path: file, container: 'mp4', duration_ms: 7_200_000, size: 4096, width: 1920, height: 1080, video_codec: 'h264', audio: JSON.stringify([{ index: 1, codec: 'aac', channels: 2, default: true, language: 'en' }]), subs: '[]' });
const alice = createUser({ username: 'ralice', password: 'pass1234' });
const bob = createUser({ username: 'rbob', password: 'pass1234', allowTranscode: false });
const admin = createUser({ username: 'radmin', password: 'pass1234', isAdmin: true });
const aliceTok = issueToken(alice.id, { deviceId: 'a1', platform: 'web' }).token;
const bobTok = issueToken(bob.id, { deviceId: 'b1', platform: 'web' }).token;
const adminTok = issueToken(admin.id, { deviceId: 'ad1', platform: 'web' }).token;
const auth = (t: string) => ({ authorization: `Bearer ${t}` });

test('DLNA renderer: SSDP discovery, play with DIDL metadata, signed stream, progress, controls', async () => {
  const found = await app.inject({ method: 'POST', url: '/api/v1/renderers/discover', headers: auth(aliceTok) });
  assert.equal(found.statusCode, 200);
  const tvDev = found.json().find((r: any) => r.name === 'Mock TV');
  assert.ok(tvDev, 'mock TV discovered over SSDP');
  assert.equal(tvDev.kind, 'dlna');
  assert.equal(tvDev.supportsVideo, true);

  const play = await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/play`, headers: auth(aliceTok), payload: { itemId: 'mov-r', startMs: 5000 } });
  assert.equal(play.statusCode, 200, play.body);
  assert.equal(play.json().method, 'direct');
  const set = tv.calls.find((c) => c.action === 'SetAVTransportURI')!;
  const uri = xml.xmlText(set.body, 'CurrentURI')!;
  const meta = xml.xmlText(set.body, 'CurrentURIMetaData')!;
  assert.match(uri, /^http:\/\/127\.0\.0\.1:\d+\/api\/v1\/renderers\/stream\/[\w-]+\/[\w-]+\.[\w-]+\.mp4$/);
  assert.match(meta, /<dc:title>Tom &amp; Jerry &lt;Live&gt;<\/dc:title>/);
  assert.match(meta, /protocolInfo="http-get:\*:video\/mp4:DLNA\.ORG_PN=AVC_MP4_MP_HD_AAC;DLNA\.ORG_OP=01/);
  assert.match(meta, /<upnp:class>object\.item\.videoItem\.movie<\/upnp:class>/);
  assert.deepEqual(tv.calls.filter((c) => ['Stop', 'SetAVTransportURI', 'Play'].includes(c.action)).map((c) => c.action).slice(0, 3), ['Stop', 'SetAVTransportURI', 'Play']);
  assert.equal(xml.xmlText(tv.calls.find((c) => c.action === 'Seek')!.body, 'Target'), '0:00:05', 'resume position sent with REL_TIME');

  // The device fetches the signed URL without a login; tampering or leaving the LAN is refused.
  const p = new URL(uri).pathname;
  const res = await app.inject({ method: 'GET', url: p, headers: { range: 'bytes=0-99' } });
  assert.equal(res.statusCode, 206);
  assert.equal(res.rawPayload.length, 100);
  assert.match(String(res.headers['contentfeatures.dlna.org']), /DLNA\.ORG_OP=01/);
  assert.equal((await app.inject({ method: 'GET', url: p.replace(/\.([\w-]+)\.mp4$/, '.AAAA$1.mp4') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: p, remoteAddress: '203.0.113.9' })).statusCode, 403);

  // Shows up as a normal session (admin dashboard, stream limits).
  const sess = listSessions().find((s) => s.itemId === 'mov-r');
  assert.equal(sess?.deviceName, 'Mock TV');
  assert.equal(sess?.userId, alice.id);

  // Polling turns the device position into watch progress.
  tv.st.rel = '0:10:00';
  tv.st.dur = '2:00:00';
  await renderers.poll(renderers._test.session(tvDev.id)!);
  const ud = db.get('SELECT position_ms FROM user_data WHERE user_id = ? AND item_id = ?', alice.id, 'mov-r');
  assert.equal(ud.position_ms, 600_000);
  const state = await app.inject({ method: 'GET', url: `/api/v1/renderers/${tvDev.id}/state`, headers: auth(aliceTok) });
  assert.equal(state.json().state, 'playing');
  assert.equal(state.json().positionMs, 600_000);
  assert.equal(state.json().volume, 25);

  // Other users can't control it.
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/pause`, headers: auth(bobTok) })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/play`, headers: auth(bobTok), payload: { itemId: 'mov-r' } })).statusCode, 409);

  const pause = await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/pause`, headers: auth(aliceTok) });
  assert.equal(pause.json().state, 'paused');
  await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/seek`, headers: auth(aliceTok), payload: { positionMs: 1_234_000 } });
  assert.equal(xml.xmlText(tv.calls.filter((c) => c.action === 'Seek').at(-1)!.body, 'Target'), '0:20:34');
  await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/volume`, headers: auth(aliceTok), payload: { volume: 30 } });
  const sv = tv.calls.filter((c) => c.action === 'SetVolume').at(-1)!;
  assert.equal(xml.xmlText(sv.body, 'DesiredVolume'), '30');
  assert.equal(xml.xmlText(sv.body, 'Channel'), 'Master');

  const stop = await app.inject({ method: 'POST', url: `/api/v1/renderers/${tvDev.id}/stop`, headers: auth(aliceTok) });
  assert.equal(stop.json().state, 'stopped');
  assert.equal(tv.calls.at(-1)!.action, 'Stop');
  assert.equal(listSessions().some((s) => s.itemId === 'mov-r'), false, 'session closed');
  assert.equal((await app.inject({ method: 'GET', url: p })).statusCode, 404, 'stopping revokes the stream URL');
});

test('DLNA renderer: unsupported container needs transcoding permission', async () => {
  db.insert('items', { id: 'mkv-r', library_id: 'lib-r', type: 'movie', title: 'MKV', sort_title: 'mkv', added_at: now, updated_at: now });
  const mkv = path.join(dir, 'movie.mkv');
  fs.writeFileSync(mkv, 'x');
  db.insert('media', { id: 'med-mkv', item_id: 'mkv-r', path: mkv, container: 'mkv', duration_ms: 60_000, size: 4096, width: 1920, height: 1080, video_codec: 'hevc', audio: JSON.stringify([{ index: 1, codec: 'dts', default: true }]), subs: '[]' });
  const id = renderers.listRenderers().find((r) => r.name === 'Mock TV')!.id;
  const r = await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/play`, headers: auth(bobTok), payload: { itemId: 'mkv-r' } });
  assert.equal(r.statusCode, 403);
  assert.match(r.json().message, /transcode/);
});

test('Kodi renderer: JSON-RPC open, notification, progress, pause, volume, stop', async () => {
  const id = renderers._test.addKodi('127.0.0.1', kodiPort, 'Living Room Kodi');
  const play = await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/play`, headers: auth(aliceTok), payload: { itemId: 'mov-r', startMs: 0 } });
  assert.equal(play.statusCode, 200, play.body);
  const open = kodi.calls.find((c) => c.method === 'Player.Open')!;
  assert.match(open.params.item.file, /\/api\/v1\/renderers\/stream\/.+\.mp4$/);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(kodi.calls.some((c) => c.method === 'GUI.ShowNotification' && /Tom & Jerry/.test(c.params.message)));

  kodi.st.time = 1_800_000;
  await renderers.poll(renderers._test.session(id)!);
  assert.equal(db.get('SELECT position_ms FROM user_data WHERE user_id = ? AND item_id = ?', alice.id, 'mov-r').position_ms, 1_800_000);

  await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/pause`, headers: auth(aliceTok) });
  assert.deepEqual(kodi.calls.filter((c) => c.method === 'Player.PlayPause').at(-1)!.params, { playerid: 1, play: false });
  await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/seek`, headers: auth(aliceTok), payload: { positionMs: 3_661_000 } });
  assert.deepEqual(kodi.calls.filter((c) => c.method === 'Player.Seek').at(-1)!.params.value.time, { hours: 1, minutes: 1, seconds: 1, milliseconds: 0 });
  const vol = await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/volume`, headers: auth(aliceTok), payload: { volume: 42 } });
  assert.equal(vol.json().volume, 42);
  assert.equal(kodi.st.volume, 42);

  // Playback stopped on the device itself → session ends with the last position.
  kodi.st.playing = false;
  await renderers.poll(renderers._test.session(id)!);
  assert.equal(renderers._test.session(id)?.state, 'stopped');
  assert.equal(listSessions().some((s) => s.deviceName === 'Living Room Kodi'), false);
});

test('admin: manual devices are admin-only and LAN-only (SSRF guard)', async () => {
  const asUser = await app.inject({ method: 'POST', url: '/api/v1/admin/renderers/manual', headers: auth(aliceTok), payload: { kind: 'kodi', host: '127.0.0.1', port: kodiPort } });
  assert.equal(asUser.statusCode, 403);
  const pub = await app.inject({ method: 'POST', url: '/api/v1/admin/renderers/manual', headers: auth(adminTok), payload: { kind: 'dlna', descriptionUrl: 'http://8.8.8.8/desc.xml' } });
  assert.equal(pub.statusCode, 400);
  assert.match(pub.json().message, /local network/);
  const ok = await app.inject({ method: 'POST', url: '/api/v1/admin/renderers/manual', headers: auth(adminTok), payload: { kind: 'kodi', host: '127.0.0.1', port: kodiPort, name: 'Bedroom' } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().manual.some((m: any) => m.name === 'Bedroom' && m.kind === 'kodi' && !('password' in m)));
  const dl = await app.inject({ method: 'POST', url: '/api/v1/admin/renderers/manual', headers: auth(adminTok), payload: { kind: 'dlna', descriptionUrl: `http://127.0.0.1:${tvPort}/desc.xml`, name: 'Manual TV' } });
  assert.equal(dl.statusCode, 200, dl.body);
  assert.ok(dl.json().renderers.some((r: any) => r.name === 'Manual TV' && r.manual));
  const id = ok.json().manual.find((m: any) => m.name === 'Bedroom').id;
  const del = await app.inject({ method: 'DELETE', url: `/api/v1/admin/renderers/manual/${id}`, headers: auth(adminTok) });
  assert.equal(del.json().manual.some((m: any) => m.id === id), false);
  // Turning the feature off hides everything.
  await app.inject({ method: 'PUT', url: '/api/v1/admin/renderers/settings', headers: auth(adminTok), payload: { enabled: false } });
  assert.deepEqual((await app.inject({ method: 'GET', url: '/api/v1/renderers', headers: auth(aliceTok) })).json(), []);
  await app.inject({ method: 'PUT', url: '/api/v1/admin/renderers/settings', headers: auth(adminTok), payload: { enabled: true, mdns: false } });
});

test('Sonos: queue playback with AddURIToQueue, mp3 radio URIs and group volume', async () => {
  const { UpnpDriver } = await import('../src/services/renderers/upnp.ts');
  const base = `http://127.0.0.1:${tvPort}`;
  const svc = (name: string, type = name) => ({ serviceType: `urn:schemas-upnp-org:service:${type}:1`, controlUrl: `${base}/MediaRenderer/${name}/Control` });
  const d = new UpnpDriver({
    udn: 'uuid:RINCON_000E58AABBCC01400', friendlyName: 'Kitchen', manufacturer: 'Sonos, Inc.', modelName: 'One', deviceType: 'urn:schemas-upnp-org:device:MediaRenderer:1', iconUrl: null,
    avTransport: svc('AVTransport'), renderingControl: svc('RenderingControl'), connectionManager: svc('ConnectionManager'), groupRenderingControl: svc('GroupRenderingControl'),
    isSonos: true, rinconId: 'RINCON_000E58AABBCC01400',
  });
  const track = (n: number, seekable: boolean) => ({
    url: `http://10.0.0.2:8484/api/v1/renderers/stream/k/t${n}.${seekable ? 'flac' : 'mp3'}`, mime: seekable ? 'audio/flac' : 'audio/mpeg', protocolInfo: 'http-get:*:audio/mpeg:*',
    didl: { id: `t${n}`, title: `Track ${n}`, upnpClass: 'object.item.audioItem.musicTrack', artist: 'A & B', album: 'Album', res: { url: 'u', protocolInfo: 'http-get:*:audio/mpeg:*' } },
    title: `Track ${n}`, subtitle: null, artUrl: null, durationMs: 200_000, startMs: 0, isAudio: true, seekable, subtitleUrl: null,
  });
  tv.calls.length = 0;
  await d.loadQueue([track(1, true), track(2, false)], 1);
  const acts = tv.calls.map((c) => c.action);
  assert.deepEqual(acts, ['Stop', 'RemoveAllTracksFromQueue', 'AddURIToQueue', 'AddURIToQueue', 'SetAVTransportURI', 'Seek', 'Play']);
  const adds = tv.calls.filter((c) => c.action === 'AddURIToQueue');
  assert.match(xml.xmlText(adds[0].body, 'EnqueuedURI')!, /^http:\/\/.*\.flac$/);
  assert.match(xml.xmlText(adds[1].body, 'EnqueuedURI')!, /^x-rincon-mp3radio:\/\/10\.0\.0\.2:8484\//);
  assert.match(xml.xmlText(adds[0].body, 'EnqueuedURIMetaData')!, /<upnp:artist>A &amp; B<\/upnp:artist>/);
  assert.equal(xml.xmlText(tv.calls[4].body, 'CurrentURI'), 'x-rincon-queue:RINCON_000E58AABBCC01400#0');
  assert.equal(xml.xmlText(tv.calls[5].body, 'Unit'), 'TRACK_NR');
  assert.equal(xml.xmlText(tv.calls[5].body, 'Target'), '2');
  await d.setVolume(55);
  assert.deepEqual(tv.calls.slice(-2).map((c) => c.action), ['SnapshotGroupVolume', 'SetGroupVolume']);
  assert.equal(xml.xmlText(tv.calls.at(-1)!.body, 'DesiredVolume'), '55');
});

test('DLNA renderer: live MPEG-TS transcode when the device lacks the container', async (t) => {
  const { execFileSync } = await import('node:child_process');
  const src = path.join(dir, 'clip.mkv');
  try {
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=25:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libx264', '-c:a', 'libvorbis', '-shortest', src]);
  } catch {
    t.skip('ffmpeg not available');
    return;
  }
  await renderers.discover(1500); // the admin test switched the feature off and on (the manual entry renamed it)
  db.insert('items', { id: 'clip-r', library_id: 'lib-r', type: 'movie', title: 'Clip', sort_title: 'clip', added_at: now, updated_at: now });
  db.insert('media', { id: 'med-clip', item_id: 'clip-r', path: src, container: 'mkv', duration_ms: 2000, size: fs.statSync(src).size, width: 320, height: 240, video_codec: 'h264', audio: JSON.stringify([{ index: 1, codec: 'vorbis', default: true }]), subs: '[]' });
  const id = renderers.listRenderers().find((r) => r.kind === 'dlna' && /TV/.test(r.name))!.id;
  tv.calls.length = 0;
  const play = await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/play`, headers: auth(aliceTok), payload: { itemId: 'clip-r', startMs: 0 } });
  assert.equal(play.statusCode, 200, play.body);
  assert.equal(play.json().method, 'transcode');
  const set = tv.calls.find((c) => c.action === 'SetAVTransportURI')!;
  const uri = xml.xmlText(set.body, 'CurrentURI')!;
  assert.match(uri, /\.ts$/);
  assert.match(xml.xmlText(set.body, 'CurrentURIMetaData')!, /protocolInfo="http-get:\*:video\/mpeg:DLNA\.ORG_OP=00;DLNA\.ORG_CI=1/);
  const res = await app.inject({ method: 'GET', url: new URL(uri).pathname });
  assert.equal(res.statusCode, 200);
  assert.equal(res.headers['content-type'], 'video/mpeg');
  assert.ok(res.rawPayload.length > 10_000, `got ${res.rawPayload.length} bytes`);
  assert.equal(res.rawPayload[0], 0x47, 'MPEG-TS sync byte');
  await app.inject({ method: 'POST', url: `/api/v1/renderers/${id}/stop`, headers: auth(aliceTok) });
});
