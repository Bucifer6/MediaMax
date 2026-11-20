import type { FastifyReply, FastifyRequest } from 'fastify';
import type { DeviceInfo } from '@mediamax/shared';
import { authenticate, type AuthContext } from './services/auth.js';
import { forbidden, unauthorized } from './util/errors.js';

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
  req.auth = authenticate(extractToken(req));
}

export function requireUser(req: FastifyRequest): AuthContext {
  if (!req.auth) throw unauthorized();
  return req.auth;
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

export const remoteAddr = (req: FastifyRequest) => (req.headers['x-forwarded-for'] as string | undefined)?.split(',')[0].trim() ?? req.ip ?? null;

export function noCache(reply: FastifyReply) {
  reply.header('Cache-Control', 'no-store');
}
