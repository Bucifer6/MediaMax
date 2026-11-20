import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import tls from 'node:tls';
import type { SecurityBanRequest, SecurityCount, SecurityDashboardSettings, SecurityOverview } from '@mediamax/shared';
import { config } from '../../config.js';
import { getKv, setKv } from '../settings.js';
import { badRequest } from '../../util/errors.js';
import { csBan, csOverview, csUnban, type CsConfig } from './crowdsec.js';
import { f2bBan, f2bStatus, f2bUnban } from './fail2ban.js';

const MASK = '••••';
const KV = 'securityDashboard';

/** Settings: what the admin saved, falling back to what the deploy installer put in the environment. */
export function getSecuritySettings(): SecurityDashboardSettings {
  const saved = getKv<Partial<SecurityDashboardSettings>>(KV, {});
  const env = process.env;
  const kind = (saved.proxy?.kind ?? env.MEDIAMAX_PROXY_KIND ?? 'none') as SecurityDashboardSettings['proxy']['kind'];
  return {
    proxy: { kind: ['caddy', 'nginx'].includes(kind) ? kind : 'none', accessLog: saved.proxy?.accessLog ?? env.MEDIAMAX_PROXY_LOG ?? null },
    publicHost: saved.publicHost ?? env.MEDIAMAX_PUBLIC_HOST ?? null,
    crowdsec: {
      url: saved.crowdsec?.url ?? env.MEDIAMAX_CROWDSEC_URL ?? null,
      machineId: saved.crowdsec?.machineId ?? env.MEDIAMAX_CROWDSEC_MACHINE_ID ?? null,
      password: saved.crowdsec?.password ?? env.MEDIAMAX_CROWDSEC_PASSWORD ?? null,
    },
    fail2banSocket: saved.fail2banSocket ?? env.MEDIAMAX_FAIL2BAN_SOCKET ?? null,
  };
}

export function publicSecuritySettings(): SecurityDashboardSettings {
  const s = getSecuritySettings();
  return { ...s, crowdsec: { ...s.crowdsec, password: s.crowdsec.password ? MASK : null } };
}

export function saveSecuritySettings(patch: Partial<SecurityDashboardSettings>): SecurityDashboardSettings {
  const cur = getKv<Partial<SecurityDashboardSettings>>(KV, {});
  const curFull = getSecuritySettings();
  const pw = patch.crowdsec?.password === MASK ? curFull.crowdsec.password : patch.crowdsec?.password;
  const clean = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 500) : null);
  const next: Partial<SecurityDashboardSettings> = {
    ...cur,
    ...(patch.proxy ? { proxy: { kind: ['caddy', 'nginx'].includes(patch.proxy.kind) ? patch.proxy.kind : 'none', accessLog: clean(patch.proxy.accessLog) } } : {}),
    ...(patch.publicHost !== undefined ? { publicHost: clean(patch.publicHost) } : {}),
    ...(patch.crowdsec ? { crowdsec: { url: clean(patch.crowdsec.url), machineId: clean(patch.crowdsec.machineId), password: pw ?? null } } : {}),
    ...(patch.fail2banSocket !== undefined ? { fail2banSocket: clean(patch.fail2banSocket) } : {}),
  };
  setKv(KV, next);
  cache = null;
  return publicSecuritySettings();
}

/* ------------------------------ log reading ------------------------------ */

/** The last `maxBytes` of a file (plus its rotated `.1` when the current one is small), as lines. */
function tailLines(file: string, maxBytes = 16 * 1024 * 1024): string[] {
  const read = (f: string, budget: number) => {
    try {
      const st = fs.statSync(f);
      const len = Math.min(st.size, budget);
      const fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const text = buf.toString('utf8');
      return { lines: (len < st.size ? text.slice(text.indexOf('\n') + 1) : text).split('\n').filter(Boolean), size: len };
    } catch {
      return { lines: [], size: 0 };
    }
  };
  const cur = read(file, maxBytes);
  const old = cur.size < maxBytes ? read(`${file}.1`, maxBytes - cur.size) : { lines: [] };
  return [...old.lines, ...cur.lines];
}

const top = (m: Map<string, number>, n = 10, extra?: Map<string, string>): SecurityCount[] =>
  [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, n).map(([key, count]) => ({ key, count, extra: extra?.get(key) ?? null }));
const bump = (m: Map<string, number>, k: string, by = 1) => m.set(k, (m.get(k) ?? 0) + by);

const SEC_LINE = /^(\S+) mediamax\[security\] (AUTH_FAIL|AUTH_LOCKED|AUTH_OK) ip=(\S+)(.*)$/;
function field(rest: string, k: string): string | null {
  const m = new RegExp(`\\b${k}=(?:"([^"]*)"|(\\S+))`).exec(rest);
  return m ? m[1] ?? m[2] : null;
}

export function signInStats(now = Date.now()): SecurityOverview['signIns'] {
  const lines = tailLines(path.join(config.logDir, 'security.log'), 8 * 1024 * 1024);
  const day = now - 86400000;
  const week = now - 7 * 86400000;
  const byReason = new Map<string, number>();
  const ips = new Map<string, number>();
  const users = new Map<string, number>();
  const hourly = Array<number>(24).fill(0);
  let f24 = 0;
  let f7 = 0;
  let locks = 0;
  let ok24 = 0;
  const recent: SecurityOverview['signIns']['recent'] = [];
  for (const line of lines) {
    const m = SEC_LINE.exec(line);
    if (!m) continue;
    const t = Date.parse(m[1]);
    if (!(t > week)) continue;
    const [, at, event, ip, rest] = m;
    const user = field(rest, 'user');
    const reason = field(rest, 'reason');
    if (event === 'AUTH_FAIL') {
      f7++;
      if (t > day) {
        f24++;
        bump(byReason, reason ?? 'unknown');
        bump(ips, ip);
        if (user) bump(users, user);
        hourly[Math.min(23, Math.max(0, 23 - Math.floor((now - t) / 3600000)))]++;
      }
    } else if (event === 'AUTH_LOCKED' && t > day) locks++;
    else if (event === 'AUTH_OK' && t > day) ok24++;
    if (event !== 'AUTH_OK') recent.push({ at, event, ip, user, reason });
  }
  return { failures24h: f24, failures7d: f7, lockouts24h: locks, successes24h: ok24, byReason: top(byReason), topIps: top(ips), topUsers: top(users), hourly, recent: recent.slice(-50).reverse() };
}

const NGINX_LINE = /^(\S+) \S+ \S+ \[([^\]]+)\] "(\S+) (\S+)[^"]*" (\d{3}) (\d+)/;
const MONTHS: Record<string, number> = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function nginxTime(s: string): number {
  const m = /^(\d{2})\/(\w{3})\/(\d{4}):(\d{2}):(\d{2}):(\d{2}) ([+-]\d{2})(\d{2})$/.exec(s);
  if (!m) return NaN;
  const sign = m[7].startsWith('-') ? -1 : 1;
  const off = sign * (Math.abs(Number(m[7])) * 60 + Number(m[8])) * 60000;
  return Date.UTC(+m[3], MONTHS[m[2]] ?? 0, +m[1], +m[4], +m[5], +m[6]) - off;
}

export function proxyStats(kind: 'caddy' | 'nginx', file: string, now = Date.now()): NonNullable<SecurityOverview['proxy']> {
  const base = { kind, ok: false, error: null as string | null, lastRequestAt: null as string | null, requests24h: 0, uniqueIps24h: 0, bytes24h: 0, status: { s2xx: 0, s3xx: 0, s4xx: 0, s5xx: 0 }, hourly: Array<number>(24).fill(0), topIps: [] as SecurityCount[], topErrors: [] as SecurityCount[] };
  if (!fs.existsSync(file)) return { ...base, error: `Access log not found at ${file}` };
  const day = now - 86400000;
  const ips = new Map<string, number>();
  const ipErrors = new Map<string, number>();
  const errs = new Map<string, number>();
  let last = 0;
  for (const line of tailLines(file)) {
    let t: number;
    let ip: string;
    let uri: string;
    let status: number;
    let size: number;
    if (kind === 'caddy') {
      if (line[0] !== '{') continue;
      let j: { ts?: number; status?: number; size?: number; request?: { client_ip?: string; remote_ip?: string; uri?: string } };
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (typeof j.ts !== 'number' || typeof j.status !== 'number') continue;
      t = j.ts * 1000;
      ip = j.request?.client_ip || j.request?.remote_ip || '?';
      uri = j.request?.uri ?? '';
      status = j.status;
      size = j.size ?? 0;
    } else {
      const m = NGINX_LINE.exec(line);
      if (!m) continue;
      t = nginxTime(m[2]);
      ip = m[1];
      uri = m[4];
      status = Number(m[5]);
      size = Number(m[6]);
    }
    if (!(t > day)) continue;
    last = Math.max(last, t);
    base.requests24h++;
    base.bytes24h += size;
    bump(ips, ip);
    const cls = Math.floor(status / 100);
    if (cls === 2) base.status.s2xx++;
    else if (cls === 3) base.status.s3xx++;
    else if (cls === 4) base.status.s4xx++;
    else if (cls === 5) base.status.s5xx++;
    if (status >= 400) {
      bump(ipErrors, ip);
      // Group by path without the query string (which may hold tokens; the proxies redact them, but be safe).
      bump(errs, `${status} ${uri.split('?')[0].slice(0, 120)}`);
    }
    base.hourly[Math.min(23, Math.max(0, 23 - Math.floor((now - t) / 3600000)))]++;
  }
  const errText = new Map([...ipErrors].map(([k, v]) => [k, `${v} errors`]));
  return { ...base, ok: true, lastRequestAt: last ? new Date(last).toISOString() : null, uniqueIps24h: ips.size, topIps: top(ips, 10, errText), topErrors: top(errs) };
}

/** Check the public HTTPS certificate (expiry, issuer, whether it validates). */
export function checkCertificate(host: string, port = 443): Promise<NonNullable<SecurityOverview['certificate']>> {
  return new Promise((resolve) => {
    const done = (v: NonNullable<SecurityOverview['certificate']>) => {
      sock.destroy();
      resolve(v);
    };
    const sock = tls.connect({ host, port, ...(net.isIP(host) ? {} : { servername: host }), rejectUnauthorized: false, timeout: 6000 }, () => {
      const c = sock.getPeerCertificate();
      const validTo = c?.valid_to ? new Date(c.valid_to) : null;
      const days = validTo ? Math.floor((validTo.getTime() - Date.now()) / 86400000) : null;
      const issuer = c?.issuer ? [c.issuer.O, c.issuer.CN].filter(Boolean).join(' · ') : null;
      done({ host, ok: sock.authorized, error: sock.authorized ? null : String(sock.authorizationError ?? 'not trusted'), validTo: validTo?.toISOString() ?? null, daysLeft: days, issuer });
    });
    sock.on('timeout', () => done({ host, ok: false, error: 'Timed out connecting on port 443', validTo: null, daysLeft: null, issuer: null }));
    sock.on('error', (e) => done({ host, ok: false, error: e.message, validTo: null, daysLeft: null, issuer: null }));
  });
}

/* ------------------------------- overview ------------------------------- */

let cache: { at: number; v: SecurityOverview } | null = null;

const csCfg = (s: SecurityDashboardSettings): CsConfig | null =>
  s.crowdsec.url && s.crowdsec.machineId && s.crowdsec.password ? { url: s.crowdsec.url, machineId: s.crowdsec.machineId, password: s.crowdsec.password } : null;

export async function securityOverview(force = false): Promise<SecurityOverview> {
  if (!force && cache && Date.now() - cache.at < 15000) return cache.v;
  const s = getSecuritySettings();
  const cs = csCfg(s);
  const [certificate, crowdsec, fail2ban] = await Promise.all([
    s.publicHost ? checkCertificate(s.publicHost) : Promise.resolve(null),
    cs
      ? csOverview(cs).then(
          (o) => ({ ok: true, error: null, decisions: o.decisions, alerts: o.alerts.slice(0, 50).map((a) => ({ id: a.id, scenario: a.scenario, at: a.at, ip: a.ip, country: a.country, events: a.events })) }),
          (e: Error) => ({ ok: false, error: e.message, decisions: [], alerts: [] }),
        )
      : Promise.resolve(null),
    s.fail2banSocket
      ? f2bStatus(s.fail2banSocket).then((o) => ({ ok: true, error: null, jails: o.jails }), (e: Error) => ({ ok: false, error: (e as NodeJS.ErrnoException).code === 'EACCES' ? 'Permission denied on the fail2ban socket — use the MediaMax bridge (see docs/DEPLOY.md)' : e.message, jails: [] }))
      : Promise.resolve(null),
  ]);
  const v: SecurityOverview = {
    generatedAt: new Date().toISOString(),
    signIns: signInStats(),
    proxy: s.proxy.kind !== 'none' && s.proxy.accessLog ? proxyStats(s.proxy.kind, s.proxy.accessLog) : null,
    certificate, crowdsec, fail2ban,
  };
  cache = { at: Date.now(), v };
  return v;
}

/* ----------------------------- ban / unban ----------------------------- */

function validIp(ip: string) {
  const [addr, bits] = ip.trim().split('/');
  const fam = net.isIP(addr);
  if (!fam) return false;
  if (bits === undefined) return true;
  const n = Number(bits);
  return Number.isInteger(n) && n >= (fam === 4 ? 8 : 16) && n <= (fam === 4 ? 32 : 128);
}

export async function ban(req: SecurityBanRequest, requesterIp: string | null) {
  const ip = String(req.ip ?? '').trim();
  if (!validIp(ip)) throw badRequest('Enter an IP address or range (e.g. 203.0.113.9 or 203.0.113.0/24)');
  if (requesterIp && (ip === requesterIp || ip === requesterIp.replace(/^::ffff:/, ''))) throw badRequest("That's the address you're using right now — banning it would lock you out");
  const s = getSecuritySettings();
  const reason = (req.reason ?? 'manual ban').slice(0, 120);
  if (req.tool === 'fail2ban') {
    if (!s.fail2banSocket) throw badRequest('fail2ban is not connected');
    await f2bBan(s.fail2banSocket, req.jail || 'mediamax', ip);
  } else {
    const cs = csCfg(s);
    if (!cs) throw badRequest('CrowdSec is not connected');
    const d = String(req.duration ?? '4h');
    if (!/^\d{1,4}[smhd]$/.test(d)) throw badRequest('Duration like 30m, 4h or 7d');
    await csBan(cs, ip, d.endsWith('d') ? `${Number.parseInt(d, 10) * 24}h` : d, reason);
  }
  cache = null;
}

/** Unban an IP; without a tool, everywhere it's banned. Returns where it was removed. */
export async function unban(req: SecurityBanRequest): Promise<string[]> {
  const ip = String(req.ip ?? '').trim();
  if (!validIp(ip)) throw badRequest('Invalid IP address');
  const s = getSecuritySettings();
  const done: string[] = [];
  const cs = csCfg(s);
  if (cs && (!req.tool || req.tool === 'crowdsec')) {
    if ((await csUnban(cs, ip)) > 0) done.push('CrowdSec');
  }
  if (s.fail2banSocket && (!req.tool || req.tool === 'fail2ban')) {
    const st = await f2bStatus(s.fail2banSocket).catch(() => ({ jails: [] }));
    for (const j of st.jails) {
      if ((req.jail && j.name !== req.jail) || !j.bannedIps.includes(ip)) continue;
      await f2bUnban(s.fail2banSocket, j.name, ip);
      done.push(`fail2ban (${j.name})`);
    }
  }
  cache = null;
  return done;
}
