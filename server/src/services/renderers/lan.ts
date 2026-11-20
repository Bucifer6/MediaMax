import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns/promises';
import { isPrivateAddress } from '../../util/net.js';
import { HttpError } from '../../util/errors.js';

/**
 * Network guard rails for renderer control. The server only ever talks to devices on the LAN:
 * discovered devices must answer from a private address and keep every control URL on that same
 * host; manual devices (admin-only) must resolve to private addresses unless the admin explicitly
 * allows public hosts. Fetches never follow redirects, so a device can't bounce us elsewhere.
 */

const isLoopback = (ip: string) => /^127\./.test(ip.replace(/^::ffff:/i, '')) || ip === '::1';

/** Private / link-local / loopback — but not multicast, broadcast or "this network". */
export function isLanAddress(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '');
  if (!net.isIP(v)) return false;
  if (net.isIPv4(v)) {
    const [a] = v.split('.').map(Number);
    if (a === 0 || a >= 224) return false;
  } else if (v.toLowerCase().startsWith('ff') || v === '::') return false;
  return isPrivateAddress(v);
}

/** Resolve a host and check it's on the LAN (or allowed). Returns the first address. */
export async function resolveLanHost(host: string, allowPublic = false): Promise<string> {
  const h = host.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(h) ? [h] : (await dns.lookup(h, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `Cannot resolve ${host}`, 'bad_host');
  if (!allowPublic && !addrs.every(isLanAddress)) throw new HttpError(400, 'Only devices on your local network can be added (private addresses). An administrator can allow other addresses in Play to devices settings.', 'blocked_host');
  return addrs[0];
}

export interface DeviceFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}

/**
 * Fetch from a renderer. `allowedHost` pins the request to the device's own host, so a description
 * or control URL that points somewhere else is refused (SSRF guard).
 */
export async function deviceFetch(url: string, allowedHost: string, o: DeviceFetchOptions = {}): Promise<Response> {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid device URL: ${url}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Device URLs must be http(s)');
  if (u.hostname.replace(/^\[|\]$/g, '').toLowerCase() !== allowedHost.replace(/^\[|\]$/g, '').toLowerCase()) throw new Error(`Device URL ${u.host} is not on the device's host ${allowedHost}`);
  const res = await fetch(u, { method: o.method ?? 'GET', headers: o.headers, body: o.body, redirect: 'manual', signal: AbortSignal.timeout(o.timeoutMs ?? 5000) });
  if (res.status >= 300 && res.status < 400) throw new Error('Device redirected the request (refused)');
  return res;
}

function ipv4ToInt(ip: string) {
  return ip.split('.').reduce((a, b) => ((a << 8) | Number(b)) >>> 0, 0);
}

/** This server's address on the same subnet as `host` (so the device can reach our stream URLs). */
export function localAddressFor(host: string): string {
  const target = host.replace(/^::ffff:/i, '');
  const ifs = Object.values(os.networkInterfaces()).flat().filter((a): a is os.NetworkInterfaceInfo => !!a && a.family === 'IPv4');
  if (net.isIPv4(target)) {
    if (isLoopback(target)) return '127.0.0.1';
    const t = ipv4ToInt(target);
    for (const a of ifs) {
      if (a.internal) continue;
      const mask = ipv4ToInt(a.netmask);
      if ((ipv4ToInt(a.address) & mask) === (t & mask)) return a.address;
    }
  }
  return ifs.find((a) => !a.internal)?.address ?? '127.0.0.1';
}
