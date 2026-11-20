/**
 * Home Assistant over MQTT: discovery configs for server sensors, per-device now-playing sensors, a "someone is
 * watching" binary sensor, recently added, a Scan libraries button and a playback event entity. State is pushed on
 * playback events (and every 15 s while something plays); nothing is sent while the server is idle except keep-alives.
 */
import type { HomeAssistantSettings, HomeAssistantStatus, HomeAssistantTestResult, NowPlayingEntry } from '@mediamax/shared';
import { config } from '../../config.js';
import { getKv, getSettings, serverId, setKv, SECRET_MASK } from '../settings.js';
import { bus } from '../events.js';
import { logger } from '../../util/log.js';
import { MqttClient } from './mqtt.js';
import { nowPlaying, recentlyAdded, sessionEntry } from './nowplaying.js';
import type { PlaySession } from '../playback.js';

const log = logger('homeassistant');

export const DEFAULT_HA_SETTINGS: HomeAssistantSettings = {
  mqtt: {
    enabled: false, brokerUrl: 'mqtt://homeassistant.local:1883', username: null, password: null, tls: false, tlsInsecure: false,
    baseTopic: 'mediamax', discoveryPrefix: 'homeassistant', perDeviceSensors: true,
  },
};

const KV = 'homeAssistant';
const PLAYERS_KV = 'homeAssistant:players';

export function getHaSettings(): HomeAssistantSettings {
  const s = getKv<Partial<HomeAssistantSettings>>(KV, {});
  return { mqtt: { ...DEFAULT_HA_SETTINGS.mqtt, ...(s.mqtt ?? {}) } };
}

export function publicHaSettings(s = getHaSettings()): HomeAssistantSettings {
  return { mqtt: { ...s.mqtt, password: s.mqtt.password ? SECRET_MASK : null } };
}

const topicPart = (v: unknown, fallback: string) => {
  const t = String(v ?? '').trim().replace(/^\/+|\/+$/g, '');
  return t && !/[#+\0]/.test(t) ? t.slice(0, 120) : fallback;
};

/** Validate a settings patch from the admin UI; "••••" keeps the stored password. */
export function normaliseHaSettings(patch: Partial<HomeAssistantSettings> | undefined, cur = getHaSettings()): HomeAssistantSettings {
  const m = { ...cur.mqtt, ...(patch?.mqtt ?? {}) };
  const url = String(m.brokerUrl ?? '').trim();
  return {
    mqtt: {
      enabled: !!m.enabled,
      brokerUrl: url.slice(0, 500),
      username: typeof m.username === 'string' && m.username.trim() ? m.username.trim().slice(0, 200) : null,
      password: m.password === SECRET_MASK ? cur.mqtt.password : typeof m.password === 'string' && m.password ? m.password.slice(0, 500) : null,
      tls: !!m.tls,
      tlsInsecure: !!m.tlsInsecure,
      baseTopic: topicPart(m.baseTopic, 'mediamax'),
      discoveryPrefix: topicPart(m.discoveryPrefix, 'homeassistant'),
      perDeviceSensors: m.perDeviceSensors !== false,
    },
  };
}

export function validateBrokerUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!['mqtt:', 'mqtts:', 'tcp:', 'ssl:', 'tls:'].includes(u.protocol)) return 'Broker URL must start with mqtt:// or mqtts://';
    if (!u.hostname) return 'Broker URL needs a host name';
    return null;
  } catch {
    return 'Broker URL is not valid (example: mqtt://192.168.1.10:1883)';
  }
}

/* ------------------------------ topics ------------------------------ */

const slug = (s: string) => s.replace(/[^a-zA-Z0-9_-]+/g, '_').slice(0, 64);

export function topics(s: HomeAssistantSettings['mqtt'], sid = serverId()) {
  const node = `mediamax_${slug(sid).slice(0, 12)}`;
  const root = `${s.baseTopic}/${slug(sid).slice(0, 12)}`;
  return {
    node,
    root,
    availability: `${root}/availability`,
    server: `${root}/server`,
    recent: `${root}/recently_added`,
    event: `${root}/event`,
    player: (pid: string) => `${root}/player/${slug(pid)}`,
    command: (name: string) => `${root}/command/${name}`,
    config: (component: string, object: string) => `${s.discoveryPrefix}/${component}/${node}/${object}/config`,
    haStatus: `${s.discoveryPrefix}/status`,
  };
}

interface KnownPlayer { user: string; device: string; platform: string; lastSeen: string }

/** Discovery messages (topic → retained JSON config). Exported for tests. */
export function discoveryConfigs(s: HomeAssistantSettings['mqtt'], players: Record<string, KnownPlayer>, sid = serverId()): { topic: string; payload: Record<string, unknown> }[] {
  const t = topics(s, sid);
  const serverName = getSettings().serverName;
  const device = { identifiers: [t.node], name: serverName, manufacturer: 'MediaMax', model: 'Media server', sw_version: config.version, ...(getSettings().publicUrl ? { configuration_url: getSettings().publicUrl } : {}) };
  const origin = { name: 'MediaMax', sw: config.version, url: 'https://github.com/' };
  const base = (object: string, name: string, extra: Record<string, unknown>) => ({
    topic: '',
    object,
    payload: {
      name, unique_id: `${t.node}_${object}`, object_id: `${slug(serverName).toLowerCase()}_${object}`,
      availability_topic: t.availability, payload_available: 'online', payload_not_available: 'offline',
      device, origin, ...extra,
    } as Record<string, unknown>,
  });
  const out: { component: string; object: string; payload: Record<string, unknown> }[] = [];
  const add = (component: string, x: ReturnType<typeof base>) => out.push({ component, object: x.object, payload: x.payload });

  add('sensor', base('active_streams', 'Active streams', { state_topic: t.server, value_template: '{{ value_json.active_streams }}', state_class: 'measurement', icon: 'mdi:play-network', json_attributes_topic: t.server, json_attributes_template: '{{ {"sessions": value_json.sessions} | tojson }}' }));
  add('sensor', base('transcodes', 'Transcodes', { state_topic: t.server, value_template: '{{ value_json.transcodes }}', state_class: 'measurement', icon: 'mdi:cog-transfer' }));
  add('sensor', base('bandwidth', 'Streaming bandwidth', { state_topic: t.server, value_template: '{{ value_json.bandwidth_kbps }}', unit_of_measurement: 'kbit/s', device_class: 'data_rate', state_class: 'measurement' }));
  add('sensor', base('now_playing', 'Now playing', { state_topic: t.server, value_template: '{{ value_json.state }}', icon: 'mdi:television-play', json_attributes_topic: t.server, json_attributes_template: '{{ value_json.current | tojson }}' }));
  add('binary_sensor', base('watching', 'Someone is watching', { state_topic: t.server, value_template: "{{ 'ON' if value_json.watching else 'OFF' }}", payload_on: 'ON', payload_off: 'OFF', icon: 'mdi:sofa' }));
  add('sensor', base('recently_added', 'Recently added', { state_topic: t.recent, value_template: '{{ value_json.title }}', json_attributes_topic: t.recent, json_attributes_template: '{{ {"items": value_json.items} | tojson }}', icon: 'mdi:new-box' }));
  add('button', base('scan_libraries', 'Scan libraries', { command_topic: t.command('scan_libraries'), payload_press: 'PRESS', icon: 'mdi:folder-refresh' }));
  add('event', base('playback', 'Playback', { state_topic: t.event, event_types: ['started', 'paused', 'resumed', 'stopped', 'ended'], icon: 'mdi:play-pause' }));

  if (s.perDeviceSensors) {
    for (const [pid, p] of Object.entries(players)) {
      const object = `player_${slug(pid)}`;
      out.push({
        component: 'sensor', object,
        payload: {
          name: 'Now playing', unique_id: `${t.node}_${object}`, object_id: `${slug(serverName).toLowerCase()}_${slug(p.device).toLowerCase()}_${slug(p.user).toLowerCase()}`,
          state_topic: t.player(pid), value_template: '{{ value_json.state }}', json_attributes_topic: t.player(pid),
          availability_topic: t.availability, payload_available: 'online', payload_not_available: 'offline', icon: 'mdi:television-play',
          device: { identifiers: [`${t.node}_${slug(pid)}`], name: `${p.device} (${p.user})`, manufacturer: 'MediaMax', model: p.platform, via_device: t.node },
          origin,
        },
      });
    }
  }
  return out.map((o) => ({ topic: t.config(o.component, o.object), payload: o.payload }));
}

/** JSON the per-device sensors and webhook-like consumers read. */
export function playerState(e: NowPlayingEntry | null, p: KnownPlayer) {
  if (!e) return { state: 'idle', user: p.user, client: p.device, platform: p.platform };
  return {
    state: e.state === 'paused' ? 'paused' : 'playing',
    title: e.title, series: e.series, season: e.season, episode: e.episode, year: e.year, media_type: e.mediaType,
    poster_url: e.posterUrl, progress: e.progressPercent, position: e.positionSeconds, duration: e.durationSeconds,
    client: e.device, platform: e.platform, user: e.user, transcode: e.transcode, method: e.method, hdr: e.hdr,
    bitrate_kbps: e.bitrateKbps, session_id: e.sessionId, item_id: e.itemId,
  };
}

/* ------------------------------ runtime ----------------------------- */

let client: MqttClient | null = null;
let generation = 0;
let reconnectTimer: NodeJS.Timeout | null = null;
let tickTimer: NodeJS.Timeout | null = null;
let backoff = 2000;
const status: HomeAssistantStatus['mqtt'] = { state: 'disabled', error: null, connectedAt: null, lastPublishAt: null, lastDiscoveryAt: null, entities: 0, availabilityTopic: null };
let lastPlayerStates = new Map<string, string>();
let lastServerState = '';

const players = () => getKv<Record<string, KnownPlayer>>(PLAYERS_KV, {});

export function haStatus(): HomeAssistantStatus {
  return { mqtt: { ...status }, restPath: '/api/v1/status/now-playing' };
}

async function pub(topic: string, payload: unknown, retain = true) {
  if (!client?.connected) return;
  await client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { retain, qos: 0 });
  status.lastPublishAt = new Date().toISOString();
}

export async function publishDiscovery(): Promise<number> {
  const s = getHaSettings().mqtt;
  if (!client?.connected) throw new Error('Not connected to the MQTT broker');
  const t = topics(s);
  const known = players();
  // Forget players not seen for 60 days (and remove their entities from Home Assistant).
  const cutoff = Date.now() - 60 * 86400000;
  for (const [pid, p] of Object.entries(known)) {
    if (Date.parse(p.lastSeen) < cutoff) {
      await pub(t.config('sensor', `player_${slug(pid)}`), '', true);
      delete known[pid];
      setKv(PLAYERS_KV, known);
    }
  }
  const configs = discoveryConfigs(s, known);
  for (const c of configs) await pub(c.topic, c.payload, true);
  status.entities = configs.length;
  status.lastDiscoveryAt = new Date().toISOString();
  lastPlayerStates.clear();
  lastServerState = '';
  await publishState(true);
  await publishRecent();
  return configs.length;
}

/** Current server-wide state plus the per-device sensors (only changed payloads are sent). */
export async function publishState(force = false) {
  if (!client?.connected) return;
  const s = getHaSettings().mqtt;
  const t = topics(s);
  const np = nowPlaying();
  const current = np.sessions.find((x) => x.state !== 'paused') ?? np.sessions[0] ?? null;
  const serverPayload = JSON.stringify({
    state: current ? (current.state === 'paused' ? 'paused' : 'playing') : 'idle',
    watching: np.watching, active_streams: np.activeStreams, transcodes: np.transcodes, direct_streams: np.directStreams, bandwidth_kbps: np.bandwidthKbps,
    current: current ? playerState(current, { user: current.user, device: current.device, platform: current.platform, lastSeen: '' }) : { state: 'idle' },
    sessions: np.sessions.map((x) => ({ user: x.user, client: x.device, title: x.title, state: x.state, transcode: x.transcode, progress: x.progressPercent })),
  });
  if (force || serverPayload !== lastServerState) {
    lastServerState = serverPayload;
    await pub(t.server, serverPayload);
  }
  if (!s.perDeviceSensors) return;
  const known = players();
  let added = false;
  for (const e of np.sessions) {
    if (!known[e.deviceId]) added = true;
    known[e.deviceId] = { user: e.user, device: e.device, platform: e.platform, lastSeen: new Date().toISOString() };
  }
  if (added || np.sessions.length) setKv(PLAYERS_KV, known);
  if (added) {
    // A device we haven't announced yet: publish its discovery config first.
    for (const c of discoveryConfigs(s, known)) if (c.topic.includes('/player_')) await pub(c.topic, c.payload, true);
    status.entities = discoveryConfigs(s, known).length;
  }
  for (const [pid, p] of Object.entries(known)) {
    const e = np.sessions.find((x) => x.deviceId === pid) ?? null;
    const payload = JSON.stringify(playerState(e, p));
    if (force || lastPlayerStates.get(pid) !== payload) {
      lastPlayerStates.set(pid, payload);
      await pub(t.player(pid), payload);
    }
  }
}

async function publishRecent() {
  const t = topics(getHaSettings().mqtt);
  const items = recentlyAdded(5);
  const first = items[0];
  await pub(t.recent, { title: first ? (first.series ? `${first.series} – ${first.title}` : first.title) : 'Nothing yet', items });
}

export type PlaybackAction = 'started' | 'paused' | 'resumed' | 'stopped' | 'ended';

export function eventPayload(action: PlaybackAction, e: NowPlayingEntry) {
  return {
    event_type: action, user: e.user, client: e.device, platform: e.platform, title: e.title, series: e.series, season: e.season, episode: e.episode,
    media_type: e.mediaType, poster_url: e.posterUrl, progress: e.progressPercent, transcode: e.transcode, hdr: e.hdr, session_id: e.sessionId, item_id: e.itemId,
  };
}

/** Stopped near the end (≥ 90 %) counts as "ended". */
export const stopAction = (e: NowPlayingEntry): PlaybackAction => (e.progressPercent != null && e.progressPercent >= 90 ? 'ended' : 'stopped');

let stateTimer: NodeJS.Timeout | null = null;
function scheduleState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    void publishState().catch((e) => log.debug(`State publish failed: ${(e as Error).message}`));
  }, 400);
}

function onPlayback(action: PlaybackAction | 'stop') {
  return (s: PlaySession) => {
    if (!client?.connected || s.preview) return;
    const e = sessionEntry(s);
    const a = action === 'stop' ? stopAction(e) : action;
    void pub(topics(getHaSettings().mqtt).event, eventPayload(a, e), false).catch(() => {});
    scheduleState();
  };
}

function startTicker() {
  if (tickTimer) return;
  // Progress updates while something plays; idle servers send nothing.
  tickTimer = setInterval(() => {
    // Only changed payloads are published, so an idle server stays silent.
    if (client?.connected) scheduleState();
  }, 15000);
  tickTimer.unref();
}

function clientFor(s: HomeAssistantSettings['mqtt'], withWill: boolean): MqttClient {
  const t = topics(s);
  return new MqttClient({
    url: s.brokerUrl, clientId: `${t.node}_${process.pid.toString(36)}${withWill ? '' : '_test'}`.slice(0, 23),
    username: s.username, password: s.password, keepalive: 60, tls: s.tls, rejectUnauthorized: !s.tlsInsecure,
    will: withWill ? { topic: t.availability, payload: 'offline', retain: true, qos: 1 } : undefined,
  });
}

async function connect(gen: number) {
  const s = getHaSettings().mqtt;
  if (gen !== generation || !s.enabled) return;
  const err = validateBrokerUrl(s.brokerUrl);
  if (err) {
    status.state = 'error';
    status.error = err;
    return;
  }
  status.state = 'connecting';
  status.availabilityTopic = topics(s).availability;
  const c = clientFor(s, true);
  try {
    await c.connect();
  } catch (e) {
    if (gen !== generation) return;
    status.state = 'error';
    status.error = (e as Error).message;
    log.warn(`MQTT connection failed: ${status.error} (retrying in ${Math.round(backoff / 1000)}s)`);
    scheduleReconnect(gen);
    return;
  }
  if (gen !== generation) {
    void c.end();
    return;
  }
  client = c;
  backoff = 2000;
  status.state = 'connected';
  status.error = null;
  status.connectedAt = new Date().toISOString();
  log.info(`Connected to MQTT broker ${s.brokerUrl.replace(/\/\/[^@/]*@/, '//')}`);
  const t = topics(s);
  c.on('message', (topic: string, payload: Buffer) => {
    const text = payload.toString('utf8');
    if (topic === t.haStatus && text === 'online') {
      // Home Assistant restarted: re-announce everything.
      void publishDiscovery().catch((e) => log.debug(`Discovery failed: ${(e as Error).message}`));
    } else if (topic === t.command('scan_libraries')) {
      log.info('Home Assistant asked for a library scan');
      void import('../tasks.js').then((m) => m.runTask('scan-libraries')).catch((e) => log.warn(`Scan from Home Assistant failed: ${(e as Error).message}`));
    }
  });
  c.on('error', (e: Error) => log.debug(`MQTT error: ${e.message}`));
  c.on('close', () => {
    if (client !== c) return;
    client = null;
    status.state = 'disconnected';
    status.error = 'Connection lost';
    log.warn('MQTT connection lost, reconnecting');
    scheduleReconnect(gen);
  });
  try {
    await c.publish(t.availability, 'online', { retain: true, qos: 1 });
    await c.subscribe([t.haStatus, t.command('#')]);
    await publishDiscovery();
    startTicker();
  } catch (e) {
    log.warn(`MQTT setup failed: ${(e as Error).message}`);
  }
}

function scheduleReconnect(gen: number) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect(gen);
  }, backoff);
  reconnectTimer.unref();
  backoff = Math.min(backoff * 2, 5 * 60000);
}

/** (Re)apply settings: disconnect and connect again with the stored config. */
export async function restartHomeAssistant() {
  generation++;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  backoff = 2000;
  const old = client;
  client = null;
  if (old?.connected) {
    try {
      // Announce a clean shutdown (the will only fires on unexpected drops).
      await old.publish(status.availabilityTopic ?? topics(getHaSettings().mqtt).availability, 'offline', { retain: true, qos: 1 });
    } catch {
      /* ignore */
    }
    await old.end().catch(() => {});
  }
  const s = getHaSettings().mqtt;
  Object.assign(status, { state: s.enabled ? 'connecting' : 'disabled', error: null, connectedAt: null, entities: 0, availabilityTopic: s.enabled ? topics(s).availability : null });
  if (s.enabled) await connect(generation);
}

export async function stopHomeAssistant() {
  generation++;
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  const old = client;
  client = null;
  if (old?.connected) {
    await old.publish(status.availabilityTopic ?? topics(getHaSettings().mqtt).availability, 'offline', { retain: true, qos: 1 }).catch(() => {});
    await old.end().catch(() => {});
  }
  status.state = 'disabled';
}

export async function saveHaSettings(patch: Partial<HomeAssistantSettings>): Promise<HomeAssistantSettings> {
  const next = normaliseHaSettings(patch);
  if (next.mqtt.enabled) {
    const err = validateBrokerUrl(next.mqtt.brokerUrl);
    if (err) throw Object.assign(new Error(err), { statusCode: 400 });
  }
  setKv(KV, next);
  await restartHomeAssistant();
  return next;
}

/** Try a connection with (possibly unsaved) settings without touching the live one. */
export async function testMqtt(patch?: Partial<HomeAssistantSettings>): Promise<HomeAssistantTestResult> {
  const s = normaliseHaSettings(patch).mqtt;
  const err = validateBrokerUrl(s.brokerUrl);
  if (err) return { ok: false, message: err, latencyMs: null };
  const c = clientFor(s, false);
  const started = Date.now();
  try {
    await c.connect();
    await c.subscribe([`${s.baseTopic}/#`]);
    const ms = Date.now() - started;
    await c.end();
    return { ok: true, message: `Connected to ${new URL(s.brokerUrl).host} and subscribed in ${ms} ms`, latencyMs: ms };
  } catch (e) {
    c.destroy();
    return { ok: false, message: (e as Error).message, latencyMs: null };
  }
}

let inited = false;
export function initHomeAssistant() {
  if (!inited) {
    inited = true;
    bus.on('playback.start', onPlayback('started'));
    bus.on('playback.pause', onPlayback('paused'));
    bus.on('playback.resume', onPlayback('resumed'));
    bus.on('playback.stop', onPlayback('stop'));
    bus.on('library.new', () => {
      if (client?.connected) void publishRecent().catch(() => {});
    });
  }
  void restartHomeAssistant().catch((e) => log.warn(`Home Assistant start failed: ${(e as Error).message}`));
}
