import { securityEvent } from './util/securityLog.js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceInfo } from '@mediamax/shared';
import { authenticate, authenticateApiKey, type AuthContext } from './services/auth.js';
import { forbidden, HttpError, unauthorized } from './util/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

/**
 * A client header by its short name (e.g. `device-id`): `X-Kinora-<name>` wins, the original `X-MediaMax-<name>` is
 * still accepted (older clients, scripts and integrations keep working).
 */
export function clientHeader(req: Pick<FastifyRequest, 'headers'>, name: string): string | undefined {
  for (const prefix of ['x-kinora-', 'x-mediamax-']) {
    const v = req.headers[prefix + name];
    const s = Array.isArray(v) ? v[0] : v;
    if (typeof s === 'string' && s) return s;
  }
  return undefined;
}

export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const x = clientHeader(req, 'token');
  if (x) return x;
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

export async function authHook(req: FastifyRequest) {
  // Repeated headers/params arrive as arrays: only a single string is a key (anything else falls back to token auth).
  const h = req.headers['x-api-key'];
  const q = (req.query as Record<string, unknown> | undefined)?.api_key;
  const apiKey = typeof h === 'string' && h ? h : typeof q === 'string' && q ? q : undefined;
  req.auth = apiKey ? authenticateApiKey(apiKey) : authenticate(extractToken(req));
  // A wrong API key is a guessing attempt worth banning for; expired session tokens are normal and are not logged.
  if (apiKey && !req.auth) securityEvent('AUTH_FAIL', req.ip, { reason: 'api_key' });
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
}

/**
 * Account-level actions (security, API keys, device linking, managing profiles): the account owner's own session
 * only, never a profile session, even when the owner is an administrator.
 */
export function requireAccountOwner(req: FastifyRequest): AuthContext {
  const a = requireUser(req);
  if (a.user.parentUserId) throw new HttpError(403, 'Switch to the account owner\'s profile to do this', 'profile_session');
  return a;
}

/**
 * Credential-level actions (approving device links, two-factor, API keys, password/PIN): the account owner signed in
 * on a real device. An API key acts as its owner for integrations, but must never mint sessions, manage keys or lock
 * the owner out with 2FA.
 */
export function requireDeviceSession(req: FastifyRequest): AuthContext {
  const a = requireAccountOwner(req);
  if (a.deviceRowId.startsWith('apikey:')) throw new HttpError(403, 'API keys cannot do this; sign in on a device', 'api_key_not_allowed');
  return a;
}

export function requireAdmin(req: FastifyRequest): AuthContext {
  const a = requireUser(req);
  if (!a.user.isAdmin) throw forbidden('Administrator access required');
  return a;
}

export function deviceFromRequest(req: FastifyRequest, body: Partial<DeviceInfo> = {}): Partial<DeviceInfo> {
  const h = req.headers;
  const ua = String(h['user-agent'] ?? '');
  // Body fields are untyped JSON: only strings count (an object would otherwise reach the database).
  body = Object.fromEntries(Object.entries(body ?? {}).filter(([k, v]) => !['deviceId', 'deviceName', 'platform', 'appVersion'].includes(k) || typeof v === 'string'));
  return {
    deviceId: body.deviceId ?? clientHeader(req, 'device-id'),
    deviceName: body.deviceName ?? clientHeader(req, 'device-name') ?? guessDevice(ua),
    platform: body.platform ?? (clientHeader(req, 'platform') as DeviceInfo['platform'] | undefined) ?? 'web',
    appVersion: body.appVersion ?? clientHeader(req, 'version'),
  };
}

function guessDevice(ua: string): string {
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'Browser';
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} on ${os}` : browser;
}

/** Client address as resolved by Fastify's trusted-proxy rules (never the raw, spoofable header). */
export const remoteAddr = (req: FastifyRequest) => req.ip ?? null;

/** What the dashboard shows about a client's connection: User-Agent, HTTP version and whether it came over HTTPS. */
export const clientHints = (req: FastifyRequest) => ({
  userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 400) : null,
  httpVersion: req.raw.httpVersion ?? null,
  secure: req.protocol === 'https',
});

export function noCache(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
}
