import type { FastifyInstance } from 'fastify';
import type { CreateUserRequest, LoginRequest, PinLoginRequest, UpdateMeRequest, UpdateUserRequest } from '@mediamax/shared';
import { requireAdmin, requireUser, deviceFromRequest, remoteAddr, noCache } from '../http.js';
import * as auth from '../services/auth.js';
import { logActivity } from '../services/activity.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { badRequest } from '../util/errors.js';

async function saveAvatar(req: FastifyRequest, userId: string): Promise<string> {
  const file = await req.file();
  if (!file) throw badRequest('No file uploaded (field "file")');
  const ext = path.extname(file.filename).toLowerCase() || '.jpg';
  if (!['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) throw badRequest('Use a JPG, PNG, WebP or GIF image');
  const dir = path.join(config.dataDir, 'avatars');
  fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (f.startsWith(userId + '-')) fs.rmSync(path.join(dir, f), { force: true });
  const dest = path.join(dir, `${userId}-${Date.now()}${ext}`);
  fs.writeFileSync(dest, await file.toBuffer());
  return dest;
}

/** Simple in-memory login rate limiting per IP. */
const attempts = new Map<string, { n: number; until: number }>();
function rateLimit(ip: string | null) {
  const k = ip ?? 'unknown';
  const a = attempts.get(k);
  if (a && a.until > Date.now() && a.n >= 10) throw Object.assign(new Error('Too many sign-in attempts. Try again in a few minutes.'), { statusCode: 429 });
}
function recordFail(ip: string | null) {
  const k = ip ?? 'unknown';
  const a = attempts.get(k);
  if (!a || a.until < Date.now()) attempts.set(k, { n: 1, until: Date.now() + 10 * 60000 });
  else a.n++;
}

export default async function authRoutes(app: FastifyInstance) {
  app.post<{ Body: LoginRequest }>('/auth/login', async (req) => {
    const ip = remoteAddr(req);
    rateLimit(ip);
    try {
      return auth.login(req.body?.username, req.body?.password, deviceFromRequest(req, req.body), ip ?? undefined);
    } catch (e) {
      recordFail(ip);
      throw e;
    }
  });

  app.get('/auth/profiles', async (_req, reply) => {
    noCache(reply);
    return auth.publicProfiles();
  });

  app.post<{ Body: PinLoginRequest }>('/auth/profile-login', async (req) => {
    const ip = remoteAddr(req);
    rateLimit(ip);
    if (!req.body?.userId) throw badRequest('userId required');
    try {
      return auth.profileLogin(req.body.userId, req.body.pin, deviceFromRequest(req, req.body), ip ?? undefined);
    } catch (e) {
      recordFail(ip);
      throw e;
    }
  });

  app.post('/auth/link/request', async (req) => auth.requestLinkCode(deviceFromRequest(req, (req.body ?? {}) as any)));
  app.get<{ Querystring: { pollToken: string } }>('/auth/link/poll', async (req, reply) => {
    noCache(reply);
    return auth.pollLinkCode(req.query.pollToken);
  });
  app.post<{ Body: { code: string } }>('/auth/link/approve', async (req) => auth.approveLinkCode(requireUser(req), req.body?.code, remoteAddr(req) ?? undefined));

  app.post('/auth/logout', async (req) => {
    auth.logout(requireUser(req));
    return { ok: true };
  });
  app.get('/auth/me', async (req, reply) => {
    noCache(reply);
    return requireUser(req).user;
  });
  app.patch<{ Body: UpdateMeRequest }>('/auth/me', async (req) => auth.updateMe(requireUser(req).user.id, req.body ?? {}));
  app.post('/auth/me/avatar', async (req) => {
    const { user } = requireUser(req);
    return auth.setAvatar(user.id, await saveAvatar(req, user.id));
  });
  app.delete('/auth/me/avatar', async (req) => auth.setAvatar(requireUser(req).user.id, null));
  app.post<{ Params: { id: string } }>('/users/:id/avatar', async (req) => {
    requireAdmin(req);
    auth.getUserRow(req.params.id);
    return auth.setAvatar(req.params.id, await saveAvatar(req, req.params.id));
  });
  app.delete<{ Params: { id: string } }>('/users/:id/avatar', async (req) => {
    requireAdmin(req);
    return auth.setAvatar(req.params.id, null);
  });
  app.get<{ Querystring: { all?: string } }>('/auth/devices', async (req) => auth.listDevices(requireUser(req), req.query.all === 'true'));
  app.delete<{ Params: { id: string } }>('/auth/devices/:id', async (req) => {
    auth.revokeDevice(requireUser(req), req.params.id);
    return { ok: true };
  });

  // Users (admin)
  app.get('/users', async (req) => {
    requireAdmin(req);
    return auth.listUsers();
  });
  app.post<{ Body: CreateUserRequest }>('/users', async (req) => {
    const a = requireAdmin(req);
    const u = auth.createUser(req.body ?? ({} as CreateUserRequest));
    logActivity('user.create', `User ${u.displayName} created`, { userId: a.user.id, userName: a.user.displayName });
    return u;
  });
  app.patch<{ Params: { id: string }; Body: UpdateUserRequest }>('/users/:id', async (req) => auth.updateUser(req.params.id, req.body ?? {}, requireAdmin(req).user.id));
  app.delete<{ Params: { id: string } }>('/users/:id', async (req) => {
    const a = requireAdmin(req);
    auth.deleteUser(req.params.id, a.user.id);
    logActivity('user.delete', `User ${req.params.id} deleted`, { userId: a.user.id, userName: a.user.displayName });
    return { ok: true };
  });
}
