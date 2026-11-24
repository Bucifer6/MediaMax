/**
 * HTTP for tuner boxes on the LAN (TVHeadend, OpenWebif, SAT>IP description files): Basic and Digest
 * authentication (RFC 7616: MD5, MD5-sess, SHA-256, qop=auth), timeouts and friendly errors.
 *
 * Node's fetch rejects URLs with credentials, so credentials travel separately and are applied here.
 */
import crypto from 'node:crypto';

export type AuthType = 'auto' | 'basic' | 'digest';

export interface TunerCreds {
  username?: string | null;
  password?: string | null;
  authType?: AuthType | null;
}

export class TunerHttpError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message);
  }
}

interface DigestChallenge {
  realm: string;
  nonce: string;
  qop: string | null;
  opaque: string | null;
  algorithm: string;
}

export function parseChallenge(header: string): DigestChallenge | null {
  const m = header.match(/Digest\s+(.*)$/is);
  if (!m) return null;
  const params: Record<string, string> = {};
  for (const p of m[1].matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) params[p[1].toLowerCase()] = p[2] ?? p[3];
  if (!params.nonce) return null;
  const qops = (params.qop ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return { realm: params.realm ?? '', nonce: params.nonce, qop: qops.includes('auth') ? 'auth' : qops[0] ?? null, opaque: params.opaque ?? null, algorithm: params.algorithm ?? 'MD5' };
}

const hashFn = (alg: string) => (s: string) => crypto.createHash(/sha-?256/i.test(alg) ? 'sha256' : 'md5').update(s).digest('hex');

/** Build the Authorization header for one request (exported for tests). */
export function digestHeader(c: DigestChallenge, user: string, pass: string, method: string, uri: string, nc: number, cnonce = crypto.randomBytes(8).toString('hex')): string {
  const H = hashFn(c.algorithm);
  let ha1 = H(`${user}:${c.realm}:${pass}`);
  if (/-sess$/i.test(c.algorithm)) ha1 = H(`${ha1}:${c.nonce}:${cnonce}`);
  const ha2 = H(`${method}:${uri}`);
  const ncs = nc.toString(16).padStart(8, '0');
  const response = c.qop ? H(`${ha1}:${c.nonce}:${ncs}:${cnonce}:${c.qop}:${ha2}`) : H(`${ha1}:${c.nonce}:${ha2}`);
  const parts = [`username="${user}"`, `realm="${c.realm}"`, `nonce="${c.nonce}"`, `uri="${uri}"`, `algorithm=${c.algorithm}`, `response="${response}"`];
  if (c.qop) parts.push(`qop=${c.qop}`, `nc=${ncs}`, `cnonce="${cnonce}"`);
  if (c.opaque) parts.push(`opaque="${c.opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

export const basicHeader = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

/** Normalise "192.168.1.5:9981" → "http://192.168.1.5:9981" and drop a trailing slash. */
export function baseUrl(url: string): string {
  let u = (url ?? '').trim();
  if (!u) throw new TunerHttpError('Enter the device address');
  if (!/^https?:\/\//i.test(u)) u = 'http://' + u;
  const parsed = new URL(u);
  return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}`;
}

/** Put credentials into a URL (for FFmpeg, which handles Basic and Digest itself). */
export function withUserInfo(url: string, user?: string | null, pass?: string | null): string {
  if (!user) return url;
  const u = new URL(url);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(pass ?? '');
  return u.toString();
}

/** Split credentials out of a URL. */
export function splitUserInfo(url: string): { url: string; username: string | null; password: string | null } {
  const u = new URL(url);
  if (!u.username) return { url, username: null, password: null };
  const username = decodeURIComponent(u.username);
  const password = decodeURIComponent(u.password);
  u.username = '';
  u.password = '';
  return { url: u.toString(), username, password };
}

function friendly(e: unknown, url: string): TunerHttpError {
  if (e instanceof TunerHttpError) return e;
  const err = e as Error & { cause?: { code?: string; errors?: { code?: string }[] } };
  const code = err.cause?.code ?? err.cause?.errors?.[0]?.code ?? (err.name === 'TimeoutError' ? 'ETIMEDOUT' : '');
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  if ((err.cause as { message?: string } | undefined)?.message === 'bad port') return new TunerHttpError(`${host}: this port is blocked for HTTP by the runtime (use the device's web port)`);
  if (code === 'ECONNREFUSED') return new TunerHttpError(`Connection refused by ${host} — is the service running and the port right?`);
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return new TunerHttpError(`Host ${host} not found`);
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT' || err.name === 'TimeoutError' || err.name === 'AbortError') return new TunerHttpError(`No answer from ${host} (timed out)`);
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return new TunerHttpError(`${host} is unreachable from the Vibe server`);
  return new TunerHttpError(`${host}: ${err.message}`);
}

/**
 * One client per device: remembers the Digest challenge so repeated calls (EPG paging) authenticate in one round trip.
 */
export class TunerHttp {
  private challenge: DigestChallenge | null = null;
  private nc = 0;
  private scheme: 'none' | 'basic' | 'digest' | null = null;
  requests = 0;

  constructor(readonly creds: TunerCreds = {}, readonly userAgent = 'Kinora/1.0') {}

  get hasCreds() {
    return !!this.creds.username;
  }

  private authFor(method: string, url: string): string | null {
    const { username, password } = this.creds;
    if (!username) return null;
    if (this.scheme === 'digest' && this.challenge) {
      const u = new URL(url);
      return digestHeader(this.challenge, username, password ?? '', method, u.pathname + u.search, ++this.nc);
    }
    if (this.scheme === 'basic' || this.creds.authType === 'basic') return basicHeader(username, password ?? '');
    return null;
  }

  /** fetch with auth: an anonymous (or cached-scheme) attempt first, then the server's challenge. */
  async fetch(url: string, init: { method?: string; timeoutMs?: number; signal?: AbortSignal; headers?: Record<string, string> } = {}): Promise<Response> {
    const method = init.method ?? 'GET';
    const signal = init.signal ?? AbortSignal.timeout(init.timeoutMs ?? 20000);
    const attempt = (auth: string | null) => {
      this.requests++;
      return fetch(url, { method, signal, redirect: 'follow', headers: { 'User-Agent': this.userAgent, ...(init.headers ?? {}), ...(auth ? { Authorization: auth } : {}) } });
    };
    try {
      let res = await attempt(this.authFor(method, url));
      if (res.status === 401 && this.creds.username) {
        const www = res.headers.get('www-authenticate') ?? '';
        const dig = parseChallenge(www);
        await res.body?.cancel().catch(() => undefined);
        if (dig && this.creds.authType !== 'basic') {
          this.challenge = dig;
          this.nc = 0;
          this.scheme = 'digest';
        } else if (/basic/i.test(www) || this.creds.authType === 'basic' || !www) {
          if (this.scheme === 'basic') throw new TunerHttpError('Wrong username or password', 401);
          this.scheme = 'basic';
        }
        res = await attempt(this.authFor(method, url));
      }
      if (res.status === 401) {
        await res.body?.cancel().catch(() => undefined);
        throw new TunerHttpError(this.creds.username ? 'Wrong username or password' : 'This device needs a username and password', 401);
      }
      if (res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new TunerHttpError('Access denied — the user has no permission for this (check its access rights on the device)', 403);
      }
      return res;
    } catch (e) {
      throw friendly(e, url);
    }
  }

  async json<T>(url: string, timeoutMs = 30000): Promise<T> {
    const res = await this.fetch(url, { timeoutMs, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TunerHttpError(`${new URL(url).pathname} returned HTTP ${res.status}`, res.status);
    }
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new TunerHttpError(`${new URL(url).pathname} did not return JSON — is this the right address and port?`);
    }
  }

  async text(url: string, timeoutMs = 30000): Promise<string> {
    const res = await this.fetch(url, { timeoutMs });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      throw new TunerHttpError(`${new URL(url).pathname} returned HTTP ${res.status}`, res.status);
    }
    return res.text();
  }
}
