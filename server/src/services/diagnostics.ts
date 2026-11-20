/**
 * Admin → Activity & logs → Download diagnostics: one ZIP an admin can attach to a bug report.
 *
 * Everything in it goes through the redactors below: secrets (API keys, passwords, tokens, webhook URLs, MQTT and
 * CrowdSec passwords…) are removed by key name, URLs are cut down to scheme + host, and log lines lose tokens,
 * keys and credentials in query strings, headers and IPTV paths. Tables that hold credentials (users, API keys,
 * live sources, guide sources, linked accounts) are only counted, never dumped.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { isSea } from 'node:sea';
import { db } from '../db.js';
import { config } from '../config.js';
import { createZip, type ZipEntry } from '../util/zip.js';
import { cachedReport } from './hwdetect.js';
import { getNetwork, envTrustedProxies } from './network.js';
import { listSessions, transcodeCount } from './playback.js';
import { listTasks } from './tasks.js';
import { getBranding } from './branding.js';
import { getSettings, publicSettings } from './settings.js';
import { publicHaSettings } from './smarthome/homeassistant.js';
import { publicSecuritySettings } from './security/dashboard.js';

/** Settings keys whose own "public" view (the masked one the admin pages get) is used as the starting point. */
const PUBLIC_VIEWS: Record<string, () => unknown> = {
  server: () => publicSettings(getSettings()),
  homeAssistant: () => publicHaSettings(),
  securityDashboard: () => publicSecuritySettings(),
};

export const REDACTED = '[redacted]';

/** Setting keys that are dropped outright (signing secrets with no diagnostic value). */
const DROP_KEYS = new Set(['renderers.secret', 'arrWebhookToken', 'serverId']);
/** Object keys whose values are secrets. */
const SECRET_KEY = /(pass(word|wd|phrase)?|secret|token|key$|apikey|credential|hash|cookie|signature|^pin$|authorization|^auth$|auth[-_]?header|webhook[-_]?(url|id)?$|^dsn$)/i;
/** Long random-looking strings (tokens, keys) inside free text. */
const LONG_SECRET = /\b[A-Za-z0-9_-]{32,}={0,2}(?![A-Za-z0-9])/g;

/** Scheme + host (+ port) of a URL; path and query are hidden (they often carry tokens or IPTV credentials). */
export function redactUrl(value: string): string {
  return value.replace(/\b([a-z][a-z0-9+.-]{1,15}):\/\/([^\s"'<>]+)/gi, (_whole, scheme: string, rest: string) => {
    const end = rest.search(/[/?#]/);
    let authority = end < 0 ? rest : rest.slice(0, end);
    const tailPart = end < 0 ? '' : rest.slice(end);
    let user = '';
    const at = authority.lastIndexOf('@');
    if (at >= 0) {
      user = `${REDACTED}@`;
      authority = authority.slice(at + 1);
    }
    return `${scheme}://${user}${authority}${tailPart && tailPart !== '/' ? '/…' : tailPart}`;
  });
}

/** Deep copy of settings-like data with every secret removed. */
export function redactValue(v: unknown, key = '', depth = 0): unknown {
  if (depth > 12) return REDACTED;
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') {
    if (SECRET_KEY.test(key)) return v ? REDACTED : v;
    return redactText(v);
  }
  if (typeof v === 'number' || typeof v === 'boolean') return SECRET_KEY.test(key) && typeof v === 'number' ? REDACTED : v;
  if (Array.isArray(v)) return v.slice(0, 500).map((x) => redactValue(x, key, depth + 1));
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (SECRET_KEY.test(k) && x !== null && x !== '' && x !== undefined && typeof x !== 'boolean') out[k] = REDACTED;
      else out[k] = redactValue(x, k, depth + 1);
    }
    return out;
  }
  return REDACTED;
}

/** Free text (log lines, error messages): URLs, credentials in query strings, headers, IPTV paths, long tokens. */
export function redactText(text: string): string {
  return text
    .replace(/(authorization|x-api-key|x-mediamax-token|x-plex-token|cookie)(["']?\s*[:=]\s*["']?)(bearer\s+|basic\s+)?[^\s"',;}]+/gi, `$1$2${REDACTED}`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, `$1 ${REDACTED}`)
    .replace(/([?&;](?:token|access_token|refresh_token|api_key|apikey|key|password|pass|pwd|passwd|secret|sig|signature|auth|u|p|t|s|username|user|code|state)=)[^&\s"'#]*/gi, `$1${REDACTED}`)
    .replace(/(["']?(?:password|passwd|secret|token|api[_-]?key|apikey|client[_-]?secret|shared[_-]?secret)["']?\s*[:=]\s*["']?)[^"'\s,;}&]+/gi, `$1${REDACTED}`)
    .replace(/\/(live|movie|series|timeshift)\/[^/\s?"']+\/[^/\s?"']+\//gi, `/$1/${REDACTED}/${REDACTED}/`)
    .replace(/(\b[a-z][a-z0-9+.-]{1,15}:\/\/)[^\s/@"']+@/gi, `$1${REDACTED}@`)
    .replace(LONG_SECRET, REDACTED);
}

/** The last `maxBytes` of a file, starting at a line boundary. */
export function tail(file: string, maxBytes: number): string {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (size > len) text = text.slice(text.indexOf('\n') + 1);
    return text;
  } catch {
    return '';
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

function toolVersion(bin: string): string {
  try {
    const r = spawnSync(bin, ['-hide_banner', '-version'], { timeout: 5000, encoding: 'utf8' });
    if (r.status !== 0) return `not available (${r.error?.message ?? `exit ${r.status}`})`;
    return r.stdout.split('\n').slice(0, 3).join('\n').trim();
  } catch (e) {
    return `not available (${(e as Error).message})`;
  }
}

function diskInfo(p: string) {
  try {
    const s = fs.statfsSync(p);
    return { path: p, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch (e) {
    return { path: p, error: (e as Error).message };
  }
}

const count = (sql: string, ...args: unknown[]) => {
  try {
    return db.get<{ n: number }>(sql, ...(args as never[]))?.n ?? 0;
  } catch {
    return null;
  }
};

function systemInfo() {
  const cpus = os.cpus();
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!/^(MEDIAMAX_|NODE_ENV$|TZ$|PUID$|PGID$|NVIDIA_)/.test(k) || v === undefined) continue;
    env[k] = SECRET_KEY.test(k) ? REDACTED : redactText(redactUrl(v));
  }
  return {
    generatedAt: new Date().toISOString(),
    product: getBranding().serverName,
    version: config.version,
    build: { node: process.version, standalone: isSea(), docker: fs.existsSync('/.dockerenv') || fs.existsSync('/run/.containerenv'), execPath: process.execPath },
    os: { platform: process.platform, arch: process.arch, release: os.release(), type: os.type(), version: typeof os.version === 'function' ? os.version() : null },
    cpu: { model: cpus[0]?.model ?? null, cores: cpus.length, loadAverage: os.loadavg() },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), processRssBytes: process.memoryUsage().rss },
    uptime: { systemSeconds: Math.round(os.uptime()), serverSeconds: Math.round((Date.now() - config.startedAt) / 1000) },
    paths: { data: config.dataDir, transcodes: config.transcodeDir, recordings: config.recordingsDir, logs: config.logDir, web: config.webDir, help: config.helpDir, ffmpeg: config.ffmpeg, ffprobe: config.ffprobe },
    disks: [config.dataDir, config.transcodeDir, config.recordingsDir].filter((p, i, a) => a.indexOf(p) === i).map(diskInfo),
    environment: env,
  };
}

function libraryInfo() {
  const libs = db.all<{ id: string; name: string; type: string; paths: string; last_scan_at: string | null }>('SELECT id, name, type, paths, last_scan_at FROM libraries ORDER BY sort_order, name');
  const byType = db.all<{ library_id: string; type: string; n: number }>('SELECT library_id, type, COUNT(*) n FROM items GROUP BY library_id, type');
  return {
    libraries: libs.map((l) => {
      let folders: string[] = [];
      try {
        folders = JSON.parse(l.paths);
      } catch {
        /* ignore */
      }
      return {
        name: l.name, type: l.type, folders: folders.map((f) => redactUrl(String(f))), lastScanAt: l.last_scan_at,
        items: Object.fromEntries(byType.filter((x) => x.library_id === l.id).map((x) => [x.type, x.n])),
      };
    }),
    totals: {
      users: count('SELECT COUNT(*) n FROM users WHERE parent_user_id IS NULL'),
      profiles: count('SELECT COUNT(*) n FROM users WHERE parent_user_id IS NOT NULL'),
      admins: count('SELECT COUNT(*) n FROM users WHERE is_admin = 1'),
      channels: count('SELECT COUNT(*) n FROM channels'),
      programs: count('SELECT COUNT(*) n FROM programs'),
      recordingsScheduled: count("SELECT COUNT(*) n FROM recordings WHERE status IN ('scheduled','recording')"),
      requestsPending: count("SELECT COUNT(*) n FROM media_requests WHERE status = 'pending'"),
      apiKeys: count('SELECT COUNT(*) n FROM api_keys'),
      activeSessions: listSessions().length,
      activeTranscodes: transcodeCount(),
    },
    liveSources: db.all<{ name: string; type: string; enabled: number; last_refresh_at: string | null; last_error: string | null }>('SELECT name, type, enabled, last_refresh_at, last_error FROM live_sources')
      .map((s) => ({ name: s.name, type: s.type, enabled: !!s.enabled, lastRefreshAt: s.last_refresh_at, lastError: s.last_error ? redactText(redactUrl(s.last_error)) : null })),
  };
}

function settingsDump() {
  const rows = db.all<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
  const out: Record<string, unknown> = {};
  for (const r of rows) {
    if (DROP_KEYS.has(r.key) || SECRET_KEY.test(r.key)) continue;
    let v: unknown;
    try {
      // Reuse the existing write-only masking first, then redact by key name on top (belt and braces).
      v = PUBLIC_VIEWS[r.key] ? PUBLIC_VIEWS[r.key]() : JSON.parse(r.value);
    } catch {
      v = r.value;
    }
    out[r.key] = redactUrlsDeep(redactValue(v, r.key));
  }
  return out;
}

/** After key-based redaction, strip paths/queries from every URL-looking string. */
function redactUrlsDeep(v: unknown): unknown {
  if (typeof v === 'string') return /:\/\//.test(v) ? redactUrl(v) : v;
  if (Array.isArray(v)) return v.map(redactUrlsDeep);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactUrlsDeep(x)]));
  return v;
}

const LOG_LIMITS: Record<string, number> = { 'mediamax.log': 5 * 1024 * 1024 };
const OTHER_LOG_LIMIT = 1024 * 1024;

function logEntries(): ZipEntry[] {
  let files: string[] = [];
  try {
    files = fs.readdirSync(config.logDir).filter((f) => /\.log(\.\d+)?$/.test(f)).sort();
  } catch {
    return [];
  }
  return files.slice(0, 20).map((f) => {
    const text = tail(path.join(config.logDir, f), LOG_LIMITS[f] ?? OTHER_LOG_LIMIT);
    return { name: `logs/${f}`, data: text.split('\n').map(redactText).join('\n') };
  });
}

function safeJson(label: string, fn: () => unknown): string {
  try {
    return JSON.stringify(fn(), null, 2);
  } catch (e) {
    return JSON.stringify({ error: `${label} unavailable: ${(e as Error).message}` }, null, 2);
  }
}

export function diagnosticsZip(): Buffer {
  const hw = cachedReport();
  const net = getNetwork();
  const entries: ZipEntry[] = [
    {
      name: 'README.txt',
      data: [
        `${getBranding().serverName} diagnostics, ${new Date().toISOString()}`,
        '',
        'system.json     version, OS, CPU, memory, disks, MEDIAMAX_* environment (secrets removed)',
        'ffmpeg.txt      ffmpeg / ffprobe versions',
        'hardware.json   the last "Detect hardware" report (Admin > Server settings > Transcoding), if it ran',
        'network.json    connection mode (Admin > Network & HTTPS)',
        'library.json    libraries, item counts, live TV sources (no credentials)',
        'settings.json   stored settings with every key, password, token and webhook URL removed',
        'tasks.json      scheduled tasks and their last results',
        'logs/           recent server logs; tokens, keys and credentials removed',
        '',
        'Passwords, API keys, tokens and URL paths/queries are replaced by [redacted]. Check the files before sharing them.',
      ].join('\n'),
    },
    { name: 'system.json', data: safeJson('system', systemInfo) },
    { name: 'ffmpeg.txt', data: `ffmpeg (${config.ffmpeg}):\n${redactText(toolVersion(config.ffmpeg))}\n\nffprobe (${config.ffprobe}):\n${redactText(toolVersion(config.ffprobe))}\n` },
    { name: 'hardware.json', data: hw ? JSON.stringify(redactValue(hw), null, 2) : JSON.stringify({ note: 'Hardware detection has not run since the server started (Admin > Server settings > Transcoding > Detect hardware).' }, null, 2) },
    { name: 'network.json', data: safeJson('network', () => redactUrlsDeep(redactValue({ ...net, envTrustedProxies: envTrustedProxies() }))) },
    { name: 'library.json', data: safeJson('library', libraryInfo) },
    { name: 'settings.json', data: safeJson('settings', settingsDump) },
    { name: 'tasks.json', data: safeJson('tasks', () => redactValue(listTasks())) },
    ...logEntries(),
  ];
  return createZip(entries);
}
