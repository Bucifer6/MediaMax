import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from './errors.js';

/**
 * Outbound fetch for URLs that come from untrusted content (podcast feeds, their artwork and
 * enclosures). Refuses private, loopback, link-local, CGNAT, ULA and metadata addresses, re-checks
 * every redirect hop, and caps the number of redirects. Admin-configured URLs (IPTV providers,
 * webhooks, HDHomeRun) legitimately live on the LAN and use plain fetch instead.
 */
export function isPrivateAddress(ip: string): boolean {
  const v = ip.replace(/^::ffff:/i, '');
  if (net.isIPv4(v)) {
    const [a, b] = v.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  if (net.isIPv6(v)) {
    const s = v.toLowerCase();
    return s === '::' || s === '::1' || s.startsWith('fc') || s.startsWith('fd') || s.startsWith('fe8') || s.startsWith('fe9') || s.startsWith('fea') || s.startsWith('feb') || s.startsWith('ff');
  }
  return true;
}

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL', 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http(s) URLs are allowed', 'bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true }).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `Cannot resolve ${host}`, 'bad_url');
  // Escape hatch for LAN-hosted feeds (e.g. self-hosted podcast servers): MEDIAMAX_ALLOW_PRIVATE_URLS=1.
  if (process.env.MEDIAMAX_ALLOW_PRIVATE_URLS !== '1' && addrs.some(isPrivateAddress)) throw new HttpError(400, 'That address is not allowed (private or local network)', 'blocked_url');
  return u;
}

export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertPublicUrl(current);
    const res = await fetch(current, { ...init, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(502, 'Too many redirects', 'too_many_redirects');
}
