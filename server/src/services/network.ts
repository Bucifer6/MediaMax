/**
 * Networking modes:
 *  - direct:  clients connect straight to Vibe (LAN, VPN, port forward).
 *  - proxy:   behind the admin's own reverse proxy. Only the listed proxies' X-Forwarded-* headers are believed,
 *             and the list can be changed live from Admin → Network (no restart).
 *  - builtin: Vibe runs Caddy as a child process for automatic HTTPS (Let's Encrypt), proxying to itself.
 *             Off unless the admin turns it on.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import proxyAddr from '@fastify/proxy-addr';
import type { NetworkSettings } from '@mediamax/shared';
import { config } from '../config.js';
import { getKv, setKv } from './settings.js';
import { badRequest } from '../util/errors.js';
import { logger } from '../util/log.js';
import { checkCertificate } from './security/dashboard.js';

const log = logger('network');
const KV = 'network';
const DEFAULT_TRUST = ['loopback', 'linklocal', 'uniquelocal'];

export const DEFAULT_NETWORK: NetworkSettings = {
  mode: 'direct',
  trustedProxies: DEFAULT_TRUST,
  builtinHttps: { domain: null, email: null, httpPort: 80, httpsPort: 443, staging: false, hsts: true },
};

export const envTrustedProxies = (): string[] | null =>
  process.env.MEDIAMAX_TRUSTED_PROXIES ? process.env.MEDIAMAX_TRUSTED_PROXIES.split(',').map((s) => s.trim()).filter(Boolean) : null;

export function getNetwork(): NetworkSettings {
  const s = getKv<Partial<NetworkSettings>>(KV, {});
  return { ...DEFAULT_NETWORK, ...s, builtinHttps: { ...DEFAULT_NETWORK.builtinHttps, ...(s.builtinHttps ?? {}) } };
}

/* --------------------------- trusted proxies (live) --------------------------- */

let trustFn: (addr: string, hop: number) => boolean = proxyAddr.compile(DEFAULT_TRUST);

function compileTrust() {
  // Direct: nobody is in front of Vibe, so X-Forwarded-For is believed from no one but this machine.
  // Built-in HTTPS: Caddy connects over loopback. Behind your proxy: the list from Admin → Network.
  const s = getNetwork();
  const list = envTrustedProxies() ?? (s.mode === 'proxy' ? s.trustedProxies : ['loopback']);
  try {
    trustFn = proxyAddr.compile(list.length ? list : ['loopback']);
  } catch (e) {
    log.warn(`Invalid trusted proxy list, falling back to loopback only: ${(e as Error).message}`);
    trustFn = proxyAddr.compile(['loopback']);
  }
}

/** Passed to Fastify as `trustProxy`; reads the current list every time, so changes apply immediately. */
export const trustProxy = (addr: string, hop: number) => trustFn(addr, hop);

function validateTrust(list: string[]) {
  for (const entry of list) {
    try {
      proxyAddr.compile([entry]);
    } catch {
      throw badRequest(`"${entry}" isn't an IP address, CIDR range or one of: loopback, linklocal, uniquelocal`);
    }
  }
}

export function saveNetwork(patch: Partial<NetworkSettings>): NetworkSettings {
  const cur = getNetwork();
  const next: NetworkSettings = {
    mode: patch.mode && ['direct', 'proxy', 'builtin'].includes(patch.mode) ? patch.mode : cur.mode,
    trustedProxies: Array.isArray(patch.trustedProxies) ? patch.trustedProxies.map((s) => String(s).trim()).filter(Boolean).slice(0, 50) : cur.trustedProxies,
    builtinHttps: { ...cur.builtinHttps, ...(patch.builtinHttps ?? {}) },
  };
  validateTrust(next.trustedProxies);
  const b = next.builtinHttps;
  b.domain = b.domain ? String(b.domain).trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') || null : null;
  b.email = b.email ? String(b.email).trim() || null : null;
  b.httpPort = Math.max(1, Math.min(65535, Number(b.httpPort) || 80));
  b.httpsPort = Math.max(1, Math.min(65535, Number(b.httpsPort) || 443));
  if (next.mode === 'builtin') {
    if (!b.domain || !/^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(b.domain)) throw badRequest('Built-in HTTPS needs a public domain name that points at this server, e.g. media.example.com');
    if (b.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.email)) throw badRequest('That e-mail address doesn\'t look right');
    if (!findCaddy()) throw badRequest('Caddy isn\'t available on this server. The Docker image and release builds include it; otherwise install Caddy or set KINORA_CADDY.');
  }
  setKv(KV, next);
  compileTrust();
  void applyBuiltin();
  return next;
}

/* ------------------------------ built-in HTTPS ------------------------------ */

let caddyPath: string | null | undefined;
let caddyVersion: string | null = null;

export function findCaddy(): string | null {
  if (caddyPath !== undefined) return caddyPath;
  const exe = process.platform === 'win32' ? 'caddy.exe' : 'caddy';
  const candidates = [
    process.env.MEDIAMAX_CADDY,
    path.join(path.dirname(process.execPath), exe), // next to a standalone release binary
    '/usr/local/bin/caddy', '/usr/bin/caddy',
  ].filter(Boolean) as string[];
  for (const c of candidates) if (fs.existsSync(c)) return (caddyPath = c);
  const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', [exe], { encoding: 'utf8' });
  caddyPath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() || null : null;
  return caddyPath;
}

function version(bin: string) {
  if (caddyVersion) return caddyVersion;
  const r = spawnSync(bin, ['version'], { encoding: 'utf8', timeout: 5000 });
  caddyVersion = r.status === 0 ? r.stdout.trim().split(/\s+/)[0] || null : null;
  return caddyVersion;
}

const caddyDir = () => {
  const d = path.join(config.dataDir, 'caddy');
  fs.mkdirSync(d, { recursive: true });
  return d;
};
export const builtinAccessLog = () => path.join(config.logDir, 'caddy-access.log');

/**
 * Credentials that can appear in a request URL: session token, API key (?api_key=, OpenSubsonic ?apiKey=), Subsonic
 * password / token / salt (p, t, s) and the device-link poll token. Access logs replace their values.
 */
export const LOG_REDACT_QUERY = ['token', 'api_key', 'apiKey', 'pollToken', 'p', 't', 's'];
export const LOG_REDACT_HEADERS = ['X-Api-Key', 'X-Kinora-Token', 'X-Mediamax-Token'];

/** The Caddyfile Vibe generates for built-in HTTPS (exported for tests). */
export function caddyfile(s: NetworkSettings, upstreamPort = config.port, accessLog = builtinAccessLog()): string {
  const b = s.builtinHttps;
  const lines = [
    '# Generated by Vibe (Admin → Network → Built-in HTTPS). Changes here are overwritten.',
    '{',
    '\tadmin off',
    `\thttp_port ${b.httpPort}`,
    `\thttps_port ${b.httpsPort}`,
    ...(b.email ? [`\temail ${b.email}`] : []),
    ...(b.staging ? ['\tacme_ca https://acme-staging-v02.api.letsencrypt.org/directory'] : []),
    '}',
    '',
    `${b.domain} {`,
    '\theader {',
    ...(b.hsts ? ['\t\tStrict-Transport-Security "max-age=31536000"'] : []),
    '\t\tX-Content-Type-Options nosniff',
    '\t\tReferrer-Policy strict-origin-when-cross-origin',
    '\t\t-Server',
    '\t}',
    '\trequest_body {',
    '\t\tmax_size 4GB',
    '\t}',
    '\t# Compress text only; media, HLS and live TV streams pass through untouched.',
    '\tencode {',
    '\t\tzstd',
    '\t\tgzip 5',
    '\t\tminimum_length 1024',
    '\t\tmatch {',
    ...['text/html*', 'text/css*', 'text/plain*', 'text/javascript*', 'application/javascript*', 'application/json*', 'application/xml*', 'image/svg+xml*'].map((t) => `\t\t\theader Content-Type ${t}`),
    '\t\t}',
    '\t}',
    `\treverse_proxy 127.0.0.1:${upstreamPort} {`,
    '\t\tflush_interval -1',
    '\t\tstream_close_delay 5m',
    '\t\tlb_try_duration 30s',
    '\t}',
    '\tlog {',
    `\t\toutput file ${JSON.stringify(accessLog)} {`,
    '\t\t\troll_size 50MiB',
    '\t\t\troll_keep 3',
    '\t\t}',
    '\t\tformat filter {',
    '\t\t\trequest>uri query {',
    ...LOG_REDACT_QUERY.map((k) => `\t\t\t\treplace ${k} REDACTED`),
    '\t\t\t}',
    // Caddy hides Authorization and Cookie itself; these are Vibe's own credential headers.
    ...LOG_REDACT_HEADERS.map((h) => `\t\t\trequest>headers>${h} delete`),
    '\t\t\twrap json',
    '\t\t}',
    '\t}',
    '}',
    '',
  ];
  return lines.join('\n');
}

let child: ChildProcess | null = null;
let lastError: string | null = null;
const recent: string[] = [];
let restarts = 0;
let stopping = false;

function remember(line: string) {
  // Caddy logs JSON lines; keep the human part.
  let msg = line.trim();
  if (!msg) return;
  try {
    const j = JSON.parse(msg) as { level?: string; msg?: string; error?: string; identifiers?: string[] };
    msg = `${j.level ?? ''} ${j.msg ?? ''}${j.identifiers ? ` ${j.identifiers.join(',')}` : ''}${j.error ? `: ${j.error}` : ''}`.trim();
    if (j.level === 'error' || j.level === 'fatal') lastError = msg;
  } catch {
    /* not JSON */
  }
  recent.push(msg.slice(0, 400));
  if (recent.length > 60) recent.shift();
}

async function stopCaddy() {
  if (!child) return;
  stopping = true;
  const c = child;
  child = null;
  await new Promise<void>((resolve) => {
    const t = setTimeout(() => {
      c.kill('SIGKILL');
      resolve();
    }, 5000);
    c.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    c.kill('SIGTERM');
  });
  stopping = false;
}

function startCaddy(s: NetworkSettings) {
  const bin = findCaddy();
  if (!bin) {
    lastError = 'Caddy is not installed';
    return;
  }
  const dir = caddyDir();
  const file = path.join(dir, 'Caddyfile');
  fs.writeFileSync(file, caddyfile(s));
  // Certificates and ACME accounts live in the data folder, so they survive upgrades and are backed up.
  const env = { ...process.env, XDG_DATA_HOME: path.join(dir, 'data'), XDG_CONFIG_HOME: path.join(dir, 'config'), HOME: dir };
  const v = spawnSync(bin, ['validate', '--config', file, '--adapter', 'caddyfile'], { encoding: 'utf8', env, timeout: 20000 });
  if (v.status !== 0) {
    lastError = `Caddy rejected the configuration: ${(v.stderr || v.stdout).trim().split('\n').slice(-2).join(' ')}`;
    remember(lastError);
    return;
  }
  lastError = null;
  const c = spawn(bin, ['run', '--config', file, '--adapter', 'caddyfile'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  child = c;
  let buf = '';
  const onData = (d: Buffer) => {
    buf += d.toString();
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      remember(buf.slice(0, i));
      buf = buf.slice(i + 1);
    }
  };
  c.stdout?.on('data', onData);
  c.stderr?.on('data', onData);
  c.on('error', (e) => {
    lastError = `Caddy could not start: ${e.message}`;
    remember(lastError);
  });
  c.on('exit', (code, signal) => {
    if (child === c) child = null;
    if (stopping) return;
    const why = `Caddy stopped (${signal ?? `exit ${code}`})`;
    lastError = lastError ? `${why}: ${lastError}` : why;
    remember(why);
    // Bind failures (port in use / not permitted) won't fix themselves; other crashes get a few retries.
    if (getNetwork().mode === 'builtin' && restarts < 5 && !/bind|permission denied|address already in use/i.test(lastError)) {
      restarts++;
      setTimeout(() => void applyBuiltin(), 2000 * restarts);
    }
  });
  log.info(`Built-in HTTPS: Caddy started for ${s.builtinHttps.domain} (ports ${s.builtinHttps.httpPort}/${s.builtinHttps.httpsPort})`);
}

let applying: Promise<void> = Promise.resolve();
/** Start, restart or stop Caddy to match the settings. */
export function applyBuiltin(): Promise<void> {
  applying = applying.then(async () => {
    const s = getNetwork();
    await stopCaddy();
    if (s.mode === 'builtin' && s.builtinHttps.domain) {
      startCaddy(s);
    } else restarts = 0;
  });
  return applying;
}

export async function builtinStatus() {
  const s = getNetwork();
  const bin = findCaddy();
  const running = !!child && child.exitCode === null;
  const certificate = s.mode === 'builtin' && s.builtinHttps.domain && running
    ? await checkCertificate(s.builtinHttps.domain, s.builtinHttps.httpsPort, '127.0.0.1').catch(() => null)
    : null;
  return { available: !!bin, binary: bin, version: bin ? version(bin) : null, running, error: lastError, log: recent.slice(-25), certificate };
}

/** Called once at startup. */
export function initNetwork() {
  compileTrust();
  if (getNetwork().mode === 'builtin') void applyBuiltin();
  process.once('exit', () => child?.kill('SIGTERM'));
}

export const stopNetwork = () => stopCaddy();
