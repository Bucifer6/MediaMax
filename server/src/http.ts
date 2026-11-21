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

export function extractToken(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  if (h?.startsWith('Bearer ')) return h.slice(7).trim();
  const x = req.headers['x-mediamax-token'];
  if (typeof x === 'string' && x) return x;
  const q = (req.query as Record<string, unknown> | undefined)?.token;
  if (typeof q === 'string' && q) return q;
  return null;
}

export async function authHook(req: FastifyRequest) {
  const apiKey = (req.headers['x-api-key'] as string | undefined) ?? ((req.query as Record<string, unknown> | undefined)?.api_key as string | undefined);
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

export function requireAdmin(req: FastifyRequest): AuthContext {
  const a = requireUser(req);
  if (!a.user.isAdmin) throw forbidden('Administrator access required');
  return a;
}

export function deviceFromRequest(req: FastifyRequest, body: Partial<DeviceInfo> = {}): Partial<DeviceInfo> {
  const h = req.headers;
  const ua = String(h['user-agent'] ?? '');
  return {
    deviceId: body.deviceId ?? (h['x-mediamax-device-id'] as string | undefined),
    deviceName: body.deviceName ?? (h['x-mediamax-device-name'] as string | undefined) ?? guessDevice(ua),
    platform: body.platform ?? (h['x-mediamax-platform'] as DeviceInfo['platform'] | undefined) ?? 'web',
    appVersion: body.appVersion ?? (h['x-mediamax-version'] as string | undefined),
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
