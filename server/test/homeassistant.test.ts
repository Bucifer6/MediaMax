import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/* ------------------------------------------------------------------ */
/* A tiny in-process MQTT 3.1.1 broker (independent of the client's    */
/* own encoder): CONNECT/auth, retained PUBLISH, SUBSCRIBE (# and +),  */
/* PINGREQ, last will on unclean disconnect.                           */
/* ------------------------------------------------------------------ */

interface Conn { sock: net.Socket; clientId: string; subs: string[]; will: { topic: string; payload: Buffer; retain: boolean } | null; clean: boolean }

function matches(filter: string, topic: string) {
  const f = filter.split('/');
  const t = topic.split('/');
  for (let i = 0; i < f.length; i++) {
    if (f[i] === '#') return true;
    if (f[i] !== '+' && f[i] !== t[i]) return false;
  }
  return f.length === t.length;
}

function frame(type: number, flags: number, body: Buffer) {
  const len: number[] = [];
  let n = body.length;
  do {
    let b = n & 0x7f;
    n >>= 7;
    if (n) b |= 0x80;
    len.push(b);
  } while (n);
  return Buffer.concat([Buffer.from([(type << 4) | flags, ...len]), body]);
}

const s16 = (s: string | Buffer) => {
  const b = Buffer.isBuffer(s) ? s : Buffer.from(s);
  return Buffer.concat([Buffer.from([b.length >> 8, b.length & 0xff]), b]);
};

function startBroker(auth = { username: 'ha', password: 'secret' }) {
  const retained = new Map<string, Buffer>();
  const log: { topic: string; payload: string; retain: boolean }[] = [];
  const conns = new Set<Conn>();
  const deliver = (topic: string, payload: Buffer, retain: boolean) => {
    log.push({ topic, payload: payload.toString(), retain });
    if (retain) {
      if (payload.length) retained.set(topic, payload);
      else retained.delete(topic);
    }
    for (const c of conns) if (c.subs.some((f) => matches(f, topic))) c.sock.write(frame(3, 0, Buffer.concat([s16(topic), payload])));
  };
  const server = net.createServer((sock) => {
    const c: Conn = { sock, clientId: '', subs: [], will: null, clean: false };
    let buf = Buffer.alloc(0);
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        let len = 0;
        let mul = 1;
        let i = 1;
        while (i < buf.length) {
          len += (buf[i] & 0x7f) * mul;
          mul *= 128;
          if (!(buf[i++] & 0x80)) break;
        }
        if (buf.length < 2 || i + len > buf.length || (buf[i - 1] & 0x80)) return;
        const type = buf[0] >> 4;
        const flags = buf[0] & 15;
        const body = buf.subarray(i, i + len);
        buf = buf.subarray(i + len);
        let o = 0;
        const rs = () => {
          const n = body.readUInt16BE(o);
          const v = body.subarray(o + 2, o + 2 + n);
          o += 2 + n;
          return v;
        };
        if (type === 1) {
          assert.equal(rs().toString(), 'MQTT');
          assert.equal(body[o++], 4, 'protocol level 4 (3.1.1)');
          const cf = body[o++];
          o += 2;
          c.clientId = rs().toString();
          if (cf & 0x04) c.will = { topic: rs().toString(), payload: Buffer.from(rs()), retain: !!(cf & 0x20) };
          const user = cf & 0x80 ? rs().toString() : null;
          const pass = cf & 0x40 ? rs().toString() : null;
          if (user !== auth.username || pass !== auth.password) {
            sock.end(frame(2, 0, Buffer.from([0, 5])));
            return;
          }
          conns.add(c);
          sock.write(frame(2, 0, Buffer.from([0, 0])));
        } else if (type === 3) {
          const topic = rs().toString();
          const qos = (flags >> 1) & 3;
          if (qos) {
            const id = body.readUInt16BE(o);
            o += 2;
            sock.write(frame(4, 0, Buffer.from([id >> 8, id & 0xff])));
          }
          deliver(topic, Buffer.from(body.subarray(o)), !!(flags & 1));
        } else if (type === 8) {
          const id = body.readUInt16BE(0);
          o = 2;
          const granted: number[] = [];
          const fresh: string[] = [];
          while (o < body.length) {
            const f = rs().toString();
            o++;
            c.subs.push(f);
            fresh.push(f);
            granted.push(0);
          }
          sock.write(frame(9, 0, Buffer.from([id >> 8, id & 0xff, ...granted])));
          for (const [t, p] of retained) if (fresh.some((f) => matches(f, t))) sock.write(frame(3, 1, Buffer.concat([s16(t), p])));
        } else if (type === 12) sock.write(frame(13, 0, Buffer.alloc(0)));
        else if (type === 14) c.clean = true;
      }
    });
    const gone = () => {
      if (!conns.delete(c)) return;
      if (!c.clean && c.will) deliver(c.will.topic, c.will.payload, c.will.retain);
    };
    sock.on('close', gone);
    sock.on('error', gone);
  });
  return new Promise<{ url: string; retained: Map<string, Buffer>; log: typeof log; conns: Set<Conn>; publish: (t: string, p: string) => void; close: () => void }>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `mqtt://127.0.0.1:${port}`, retained, log, conns,
        publish: (t, p) => deliver(t, Buffer.from(p), false),
        close: () => {
          for (const c of conns) c.sock.destroy();
          server.close();
        },
      });
    });
  });
}

const waitFor = async (fn: () => boolean, ms = 3000, what = 'condition') => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
};

const broker = await startBroker();
after(() => broker.close());

const { MqttClient } = await import('../src/services/smarthome/mqtt.ts');
const { db } = await import('../src/db.ts');
const settings = await import('../src/services/settings.ts');
const { createUser, createApiKey, issueToken } = await import('../src/services/auth.ts');
const ha = await import('../src/services/smarthome/homeassistant.ts');
const playback = await import('../src/services/playback.ts');
const { initWebhooks } = await import('../src/services/webhooks.ts');
const { haWebhookUrl } = await import('../src/services/smarthome/hawebhook.ts');
const { nowIso } = await import('../src/util/misc.ts');

const admin = createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
const viewer = createUser({ username: 'viewer', password: 'pass1234' });

// A show with one episode, for rich now-playing payloads.
db.insert('libraries', { id: 'lib-tv', name: 'TV', type: 'shows', paths: '["/media/tv"]', created_at: nowIso() });
const item = (id: string, type: string, title: string, extra: Record<string, unknown> = {}) =>
  db.insert('items', { id, library_id: 'lib-tv', type, title, sort_title: title, added_at: nowIso(), updated_at: nowIso(), ...extra });
item('show1', 'show', 'The Expanse');
item('season1', 'season', 'Season 2', { parent_id: 'show1', idx: 2 });
item('ep1', 'episode', 'Static', { parent_id: 'season1', grandparent_id: 'show1', idx: 3, parent_idx: 2, year: 2017 });
db.insert('media', { id: 'm1', item_id: 'ep1', path: '/media/tv/expanse/s02e03.mkv', duration_ms: 3_000_000, bitrate: 12000, hdr: 1 });

const ctxFor = (u: typeof admin, deviceRowId: string, deviceName: string) =>
  ({ user: u, deviceRowId, token: 't', device: { deviceId: deviceRowId, deviceName, platform: 'web' as const } });

test('MQTT client: auth, retained publish, subscribe, inbound messages, last will', async () => {
  const bad = new MqttClient({ url: broker.url, clientId: 'bad', username: 'ha', password: 'wrong' });
  await assert.rejects(bad.connect(), /not authorised/);

  const c = new MqttClient({ url: broker.url, clientId: 'unit', username: 'ha', password: 'secret', will: { topic: 'unit/avail', payload: 'offline', retain: true } });
  await c.connect();
  await c.publish('unit/avail', 'online', { retain: true, qos: 1 });
  await c.publish('unit/big', 'x'.repeat(200_000), { retain: true });
  await waitFor(() => broker.retained.get('unit/big')?.length === 200_000, 3000, 'large retained payload');
  const got: string[] = [];
  c.on('message', (t: string, p: Buffer) => got.push(`${t}=${p}`));
  assert.deepEqual(await c.subscribe(['unit/cmd/#']), [0]);
  broker.publish('unit/cmd/go', 'PRESS');
  await waitFor(() => got.includes('unit/cmd/go=PRESS'), 2000, 'inbound message');
  // Unclean drop → the broker publishes the will.
  (c as any).sock.destroy();
  await waitFor(() => broker.retained.get('unit/avail')?.toString() === 'offline', 2000, 'last will');
});

test('Home Assistant: discovery, availability, server + per-device state, events, button, HA restart', async () => {
  await ha.saveHaSettings({ mqtt: { ...ha.DEFAULT_HA_SETTINGS.mqtt, enabled: true, brokerUrl: broker.url, username: 'ha', password: 'secret' } });
  ha.initHomeAssistant();
  await waitFor(() => ha.haStatus().mqtt.state === 'connected' && ha.haStatus().mqtt.entities > 0, 4000, 'HA connected');
  const t = ha.topics(ha.getHaSettings().mqtt);
  await waitFor(() => broker.retained.has(t.recent) && broker.retained.has(t.config('event', 'playback')), 2000, 'discovery delivered');
  assert.equal(broker.retained.get(t.availability)?.toString(), 'online');

  const cfg = (component: string, object: string) => JSON.parse(broker.retained.get(t.config(component, object))!.toString());
  for (const [component, object] of [['sensor', 'active_streams'], ['sensor', 'transcodes'], ['sensor', 'bandwidth'], ['sensor', 'now_playing'],
    ['binary_sensor', 'watching'], ['sensor', 'recently_added'], ['button', 'scan_libraries'], ['event', 'playback']]) {
    const c = cfg(component, object);
    assert.equal(c.availability_topic, t.availability, `${object} availability`);
    assert.ok(c.unique_id.endsWith(object));
    assert.deepEqual(c.device.identifiers, [t.node]);
  }
  assert.deepEqual(cfg('event', 'playback').event_types, ['started', 'paused', 'resumed', 'stopped', 'ended']);
  assert.equal(cfg('button', 'scan_libraries').command_topic, t.command('scan_libraries'));
  assert.equal(JSON.parse(broker.retained.get(t.server)!.toString()).state, 'idle');
  assert.match(JSON.parse(broker.retained.get(t.recent)!.toString()).title, /Expanse – Static/);

  // Playback starts on a new device → event, per-device discovery + state, server sensors.
  const s = playback.registerSession({
    ctx: ctxFor(viewer, 'dev-living', 'Living Room TV') as any, itemId: 'ep1', channelId: null, mediaId: 'm1', method: 'direct', job: null,
    title: 'Static', subtitle: 'S02E03', posterUrl: '/api/v1/images/abc', durationMs: 3_000_000, remoteAddr: '127.0.0.1',
  });
  const events = () => broker.log.filter((m) => m.topic === t.event).map((m) => JSON.parse(m.payload));
  await waitFor(() => events().some((e) => e.event_type === 'started'), 2000, 'started event');
  const started = events().find((e) => e.event_type === 'started');
  assert.equal(started.series, 'The Expanse');
  assert.equal(started.season, 2);
  assert.equal(started.episode, 3);
  assert.equal(started.client, 'Living Room TV');
  assert.equal(started.hdr, true);
  await waitFor(() => broker.retained.has(t.config('sensor', 'player_dev-living')), 2000, 'player discovery');
  const pcfg = JSON.parse(broker.retained.get(t.config('sensor', 'player_dev-living'))!.toString());
  assert.equal(pcfg.state_topic, t.player('dev-living'));
  assert.equal(pcfg.device.via_device, t.node);
  await waitFor(() => JSON.parse(broker.retained.get(t.player('dev-living'))?.toString() ?? '{}').state === 'playing', 2000, 'player state');
  const server = JSON.parse(broker.retained.get(t.server)!.toString());
  assert.equal(server.active_streams, 1);
  assert.equal(server.watching, true);
  assert.equal(server.bandwidth_kbps, 12000);
  assert.equal(server.current.title, 'Static');

  // Pause → paused event + state; stop near the end → "ended" and idle.
  playback.sessionProgress(ctxFor(viewer, 'dev-living', 'Living Room TV') as any, s.id, 600_000, 'paused');
  await waitFor(() => events().some((e) => e.event_type === 'paused'), 2000, 'paused event');
  await waitFor(() => JSON.parse(broker.retained.get(t.server)!.toString()).watching === false, 2000, 'not watching while paused');
  playback.sessionProgress(ctxFor(viewer, 'dev-living', 'Living Room TV') as any, s.id, 2_900_000, 'stopped');
  await waitFor(() => events().some((e) => e.event_type === 'ended'), 2000, 'ended event');
  await waitFor(() => JSON.parse(broker.retained.get(t.player('dev-living'))!.toString()).state === 'idle', 2000, 'player idle');

  // The Scan libraries button runs the task.
  settings.setKv('task:scan-libraries', { lastRunAt: null, lastDurationMs: null, lastResult: null, lastError: null });
  broker.publish(t.command('scan_libraries'), 'PRESS');
  await waitFor(() => !!settings.getKv<any>('task:scan-libraries', {}).lastRunAt, 4000, 'scan task run');

  // Home Assistant restarting (birth message) → discovery is re-published.
  const before = broker.log.filter((m) => m.topic.endsWith('/config')).length;
  broker.publish(`${ha.getHaSettings().mqtt.discoveryPrefix}/status`, 'online');
  await waitFor(() => broker.log.filter((m) => m.topic.endsWith('/config')).length >= before + 9, 2000, 'rediscovery');

  // Clean shutdown announces offline.
  await ha.stopHomeAssistant();
  assert.equal(broker.retained.get(t.availability)?.toString(), 'offline');
});

test('Home Assistant settings: password is write-only and kept with the mask; bad URLs rejected', async () => {
  const pub = ha.publicHaSettings();
  assert.equal(pub.mqtt.password, '••••');
  const next = ha.normaliseHaSettings({ mqtt: { ...pub.mqtt, enabled: false } });
  assert.equal(next.mqtt.password, 'secret');
  assert.equal(ha.normaliseHaSettings({ mqtt: { ...pub.mqtt, baseTopic: 'bad/#' } }).mqtt.baseTopic, 'mediamax');
  assert.match(ha.validateBrokerUrl('http://x') ?? '', /mqtt:\/\//);
  assert.equal(ha.validateBrokerUrl('mqtts://broker.lan:8883'), null);
  const r = await ha.testMqtt({ mqtt: { ...pub.mqtt, brokerUrl: broker.url } });
  assert.equal(r.ok, true, r.message);
  const r2 = await ha.testMqtt({ mqtt: { ...pub.mqtt, brokerUrl: broker.url, password: 'nope' } });
  assert.equal(r2.ok, false);
  assert.match(r2.message, /not authorised/);
});

test('Home Assistant webhook preset: flat payload for /api/webhook/<id>, plus REST now-playing with an API key', async () => {
  assert.equal(haWebhookUrl('http://ha.local:8123/', 'mediamax_hook'), 'http://ha.local:8123/api/webhook/mediamax_hook');
  assert.throws(() => haWebhookUrl('http://ha.local:8123', 'bad id!'));

  const received: { url: string; body: any }[] = [];
  const recv = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => (b += d));
    req.on('end', () => {
      received.push({ url: req.url!, body: JSON.parse(b) });
      res.end('ok');
    });
  });
  await new Promise<void>((r) => recv.listen(0, '127.0.0.1', r));
  const port = (recv.address() as AddressInfo).port;
  after(() => recv.close());

  const { buildApp } = await import('../src/app.ts');
  const app = await buildApp();
  try {
    const token = issueToken(admin.id, { deviceId: 'adm', deviceName: 'Admin browser', platform: 'web' }).token;
    const add = await app.inject({ method: 'POST', url: '/api/v1/integrations/home-assistant/webhook', headers: { authorization: `Bearer ${token}` }, payload: { haUrl: `http://127.0.0.1:${port}`, webhookId: 'mm_lights' } });
    assert.equal(add.statusCode, 200, add.body);
    assert.equal(add.json().webhook.format, 'home-assistant');
    const forbidden = await app.inject({ method: 'POST', url: '/api/v1/integrations/home-assistant/webhook', headers: { authorization: `Bearer ${issueToken(viewer.id, { deviceId: 'v', deviceName: 'v', platform: 'web' }).token}` }, payload: { haUrl: 'http://x', webhookId: 'y' } });
    assert.equal(forbidden.statusCode, 403);
    const test1 = await app.inject({ method: 'POST', url: '/api/v1/integrations/home-assistant/webhook/test', headers: { authorization: `Bearer ${token}` }, payload: { url: `http://127.0.0.1:${port}/api/webhook/mm_lights` } });
    assert.equal(test1.json().ok, true);
    await waitFor(() => received.some((r) => r.body.action === 'test'), 2000, 'test webhook');

    initWebhooks();
    const s = playback.registerSession({
      ctx: ctxFor(viewer, 'dev-bed', 'Bedroom') as any, itemId: 'ep1', channelId: null, mediaId: 'm1', method: 'transcode', job: null,
      title: 'Static', subtitle: null, posterUrl: '/api/v1/images/abc', durationMs: 3_000_000, remoteAddr: '127.0.0.1',
    });
    await waitFor(() => received.some((r) => r.body.action === 'started'), 2000, 'started webhook');
    const body = received.find((r) => r.body.action === 'started')!;
    assert.equal(body.url, '/api/webhook/mm_lights');
    assert.equal(body.body.event, 'playback.start');
    assert.equal(body.body.state, 'playing');
    assert.equal(body.body.media_type, 'episode');
    assert.equal(body.body.is_video, true);
    assert.equal(body.body.series, 'The Expanse');
    assert.equal(body.body.device, 'Bedroom');
    assert.equal(body.body.transcode, true);

    // REST endpoint for HA's REST sensor / dashboards: API key auth; non-admins only see their own streams.
    const adminKey = createApiKey(admin.id, 'Home Assistant').key;
    const np = await app.inject({ method: 'GET', url: '/api/v1/status/now-playing', headers: { 'x-api-key': adminKey } });
    assert.equal(np.statusCode, 200);
    const j = np.json();
    assert.equal(j.activeStreams, 1);
    assert.equal(j.transcodes, 1);
    assert.equal(j.watching, true);
    assert.equal(j.sessions[0].series, 'The Expanse');
    assert.equal(j.sessions[0].user, viewer.displayName);
    const viaQuery = await app.inject({ method: 'GET', url: `/api/v1/status/now-playing?api_key=${createApiKey(admin.id, 'q').key}` });
    assert.equal(viaQuery.json().activeStreams, 1);
    const otherKey = createApiKey(createUser({ username: 'other', password: 'pass1234' }).id, 'w').key;
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/status/now-playing', headers: { 'x-api-key': otherKey } })).json().activeStreams, 0);
    assert.equal((await app.inject({ method: 'GET', url: '/api/v1/status/now-playing' })).statusCode, 401);

    playback.sessionProgress(ctxFor(viewer, 'dev-bed', 'Bedroom') as any, s.id, 600_000, 'paused');
    await waitFor(() => received.some((r) => r.body.action === 'paused'), 2000, 'paused webhook');
    playback.stopSession(s.id);
    await waitFor(() => received.some((r) => r.body.action === 'stopped'), 2000, 'stopped webhook');
  } finally {
    await app.close();
  }
});
