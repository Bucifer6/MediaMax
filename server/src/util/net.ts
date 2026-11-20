import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { HttpError } from './errors.js';

/**
 * Outbound fetch for URLs that come from untrusted content (podcast feeds, their artwork and
 * enclosures, a user's self-hosted ListenBrainz). Refuses private, loopback, link-local, CGNAT, ULA and
 * metadata addresses, re-checks every redirect hop, pins the checked address for the connection (no DNS
 * rebinding), and caps the number of redirects. Admin-configured URLs (IPTV providers, webhooks, HDHomeRun)
 * legitimately live on the LAN and use plain fetch instead.
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
    // "::…" covers the unspecified, loopback and IPv4-compatible (::127.0.0.1) forms; fc/fd ULA, fe8–feb link-local,
    // fec–fef site-local, ff multicast, 64:ff9b:: NAT64 (maps onto IPv4, including private ranges).
    return s.startsWith('::') || /^f[c-f]/.test(s) || s.startsWith('64:ff9b:');
  }
  return true;
}

/** DNS resolution used by the SSRF guard (replaceable in tests to simulate DNS rebinding). */
type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;
const systemResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
let resolver: Resolver = systemResolver;
/** Tests only. */
export const setResolverForTests = (r: Resolver | null) => {
  resolver = r ?? systemResolver;
};

const privateAllowed = () => process.env.MEDIAMAX_ALLOW_PRIVATE_URLS === '1';
const blocked = () => new HttpError(400, 'That address is not allowed (private or local network)', 'blocked_url');

export async function assertPublicUrl(raw: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, 'Invalid URL', 'bad_url');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new HttpError(400, 'Only http(s) URLs are allowed', 'bad_url');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [host] : (await resolver(host).catch(() => [])).map((a) => a.address);
  if (!addrs.length) throw new HttpError(400, `Cannot resolve ${host}`, 'bad_url');
  // Escape hatch for LAN-hosted feeds (e.g. self-hosted podcast servers): MEDIAMAX_ALLOW_PRIVATE_URLS=1.
  if (!privateAllowed() && addrs.some(isPrivateAddress)) throw blocked();
  return u;
}

/**
 * Socket lookup that checks the addresses it is about to connect to. The connection uses exactly the addresses
 * that were checked, so a hostname that resolves to a public address for the check and to a private one a moment
 * later (DNS rebinding) can't reach the LAN.
 */
function guardedLookup(hostname: string, options: dns.LookupOptions | number, cb: (err: Error | null, address?: unknown, family?: number) => void) {
  const opts: dns.LookupOptions = typeof options === 'number' ? { family: options } : options ?? {};
  resolver(hostname).then((all) => {
    const list = opts.family ? all.filter((a) => a.family === opts.family) : all;
    if (!list.length) return cb(Object.assign(new Error(`Cannot resolve ${hostname}`), { code: 'ENOTFOUND' }));
    if (!privateAllowed() && list.some((a) => isPrivateAddress(a.address))) return cb(blocked());
    if (opts.all) cb(null, list);
    else cb(null, list[0].address, list[0].family);
  }, (e: Error) => cb(e));
}

/** One HTTP(S) request (redirects are not followed) over a connection whose address passed the guard. */
function guardedRequest(url: URL, init: RequestInit): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = { 'accept-encoding': 'gzip, deflate, br' };
    new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
    let body: Buffer | null = null;
    if (init.body != null) {
      if (typeof init.body === 'string') body = Buffer.from(init.body);
      else if (init.body instanceof URLSearchParams) {
        body = Buffer.from(init.body.toString());
        headers['content-type'] ??= 'application/x-www-form-urlencoded;charset=UTF-8';
      } else if (init.body instanceof Uint8Array) body = Buffer.from(init.body);
      else if (init.body instanceof ArrayBuffer) body = Buffer.from(new Uint8Array(init.body));
      else return reject(new Error('Unsupported request body'));
      headers['content-length'] = String(body.length);
    }
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, { method: init.method ?? 'GET', headers, lookup: guardedLookup as never, signal: init.signal ?? undefined }, (res) => {
      const h = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v == null) continue;
        for (const x of Array.isArray(v) ? v : [v]) h.append(k, x);
      }
      const status = res.statusCode ?? 502;
      if (init.method === 'HEAD' || status === 204 || status === 304 || status < 200) {
        res.resume();
        return resolve(new Response(null, { status: status < 200 ? 502 : status, statusText: res.statusMessage, headers: h }));
      }
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase().trim();
      let stream: Readable = res;
      if (enc === 'gzip' || enc === 'x-gzip') stream = res.pipe(zlib.createGunzip());
      else if (enc === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (enc === 'br') stream = res.pipe(zlib.createBrotliDecompress());
      if (stream !== res) {
        res.on('error', (e) => stream.destroy(e));
        h.delete('content-encoding');
        h.delete('content-length');
      }
      resolve(new Response(Readable.toWeb(stream) as ReadableStream, { status, statusText: res.statusMessage, headers: h }));
    });
    req.setTimeout(120000, () => req.destroy(new Error('Request timed out')));
    req.on('error', reject);
    req.end(body ?? undefined);
  });
}

export async function safeFetch(url: string, init: RequestInit = {}, maxRedirects = 5): Promise<Response> {
  let current = url;
  let req: RequestInit = { ...init };
  for (let i = 0; i <= maxRedirects; i++) {
    const u = await assertPublicUrl(current);
    const res = await guardedRequest(u, req);
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      await res.body?.cancel().catch(() => undefined);
      current = new URL(res.headers.get('location')!, current).toString();
      // Like fetch: a 303 (or a 301/302 answering a POST) continues as a GET without the body.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && (req.method ?? 'GET').toUpperCase() === 'POST')) {
        const hs = new Headers(req.headers ?? {});
        hs.delete('content-type');
        req = { ...req, method: 'GET', body: undefined, headers: hs };
      }
      continue;
    }
    return res;
  }
  throw new HttpError(502, 'Too many redirects', 'too_many_redirects');
}
