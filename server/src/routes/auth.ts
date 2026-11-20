import type { FastifyInstance } from 'fastify';
import type { CreateUserRequest, LoginRequest, PinLoginRequest, UpdateMeRequest, UpdateUserRequest } from '@mediamax/shared';
import { requireAccountOwner, requireAdmin, requireUser, deviceFromRequest, remoteAddr, noCache } from '../http.js';
import * as auth from '../services/auth.js';
import * as oidc from '../services/oidc.js';
import * as invites from '../services/invites.js';
import type { AcceptInviteRequest, CreateInviteRequest } from '@mediamax/shared';
import { getSettings } from '../services/settings.js';
import { logActivity } from '../services/activity.js';
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyRequest } from 'fastify';
import { config } from '../config.js';
import { badRequest } from '../util/errors.js';

export async function saveAvatar(req: FastifyRequest, userId: string): Promise<string> {
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
      return auth.login(req.body?.username, req.body?.password, deviceFromRequest(req, req.body), ip ?? undefined, req.body?.totpCode);
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
      return auth.profileLogin(req.body.userId, req.body.pin, deviceFromRequest(req, req.body), ip ?? undefined, req.body.totpCode);
    } catch (e) {
      recordFail(ip);
      throw e;
    }
  });

  /* Single sign-on (OpenID Connect). Clients open /auth/oidc/start in a browser;
     the server redirects back to `redirect` with #token=… or #error=…. */
  app.get<{ Querystring: { redirect?: string; deviceId?: string; deviceName?: string; platform?: string } }>('/auth/oidc/start', async (req, reply) => {
    // One origin for both the IdP callback and the allowed token redirect.
    const base = getSettings().publicUrl?.replace(/\/+$/, '') || `${req.protocol}://${req.host}`;
    const redirect = oidc.validateRedirect(req.query.redirect || `${base}/login`, base);
    const { url, state } = await oidc.startLogin(base, redirect, deviceFromRequest(req, req.query as any));
    const secure = base.startsWith('https:') ? '; Secure' : '';
    reply.header('Set-Cookie', `mm_oidc_state=${state}; Path=/api/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=600${secure}`);
    return reply.redirect(url);
  });
  app.get<{ Querystring: { state?: string; code?: string; error?: string; error_description?: string } }>('/auth/oidc/callback', async (req, reply) => {
    if (req.query.error || !req.query.code || !req.query.state) {
      return reply.type('text/html').send(`<p>Sign-in was cancelled: ${String(req.query.error_description ?? req.query.error ?? 'missing code').replace(/[<>&]/g, '')}</p>`);
    }
    const cookieState = /(?:^|;\s*)mm_oidc_state=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null;
    reply.header('Set-Cookie', 'mm_oidc_state=; Path=/api/v1/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=0');
    return reply.redirect(await oidc.finishLogin(req.query.state, req.query.code, cookieState, remoteAddr(req) ?? undefined));
  });

  app.post('/auth/link/request', async (req) => auth.requestLinkCode(deviceFromRequest(req, (req.body ?? {}) as any)));
  app.get<{ Querystring: { pollToken: string } }>('/auth/link/poll', async (req, reply) => {
    noCache(reply);
    return auth.pollLinkCode(req.query.pollToken);
  });
  app.post<{ Body: { code: string } }>('/auth/link/approve', async (req) => auth.approveLinkCode(requireAccountOwner(req), req.body?.code, remoteAddr(req) ?? undefined));

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
  /* Two-factor (TOTP) */
  app.post('/auth/me/2fa/setup', async (req) => auth.totpSetup(requireAccountOwner(req).user.id));
  app.post<{ Body: { code: string } }>('/auth/me/2fa/enable', async (req) => auth.totpEnable(requireAccountOwner(req).user.id, req.body?.code));
  app.post<{ Body: { code: string } }>('/auth/me/2fa/disable', async (req) => {
    const { user } = requireAccountOwner(req);
    auth.totpDisable(user.id, req.body?.code);
    return auth.getUser(user.id);
  });
  app.delete<{ Params: { id: string } }>('/users/:id/2fa', async (req) => {
    const a = requireAdmin(req);
    auth.totpDisable(req.params.id, '', true);
    void a;
    return auth.getUser(req.params.id);
  });

  /* API keys (act as the owning user) */
  app.get('/auth/api-keys', async (req) => auth.listApiKeys(requireAccountOwner(req).user.id));
  app.post<{ Body: { name: string } }>('/auth/api-keys', async (req) => {
    const a = requireAccountOwner(req);
    if (a.deviceRowId.startsWith('apikey:')) throw badRequest('API keys cannot create other API keys');
    return auth.createApiKey(a.user.id, req.body?.name);
  });
  app.delete<{ Params: { id: string } }>('/auth/api-keys/:id', async (req) => {
    const { user } = requireAccountOwner(req);
    auth.deleteApiKey(user.id, req.params.id, user.isAdmin);
    return { ok: true };
  });

  /* Invite links */
  const origin = (req: FastifyRequest) => `${req.protocol}://${req.host}`;
  app.get('/invites', async (req) => {
    requireAdmin(req);
    return invites.listInvites(origin(req));
  });
  app.post<{ Body: CreateInviteRequest }>('/invites', async (req) => invites.createInvite(requireAdmin(req).user, req.body ?? {}, origin(req)));
  app.delete<{ Params: { code: string } }>('/invites/:code', async (req) => {
    requireAdmin(req);
    invites.deleteInvite(req.params.code);
    return { ok: true };
  });
  app.get<{ Params: { code: string } }>('/invites/:code/preview', async (req, reply) => {
    noCache(reply);
    return invites.previewInvite(req.params.code);
  });
  app.post<{ Params: { code: string }; Body: AcceptInviteRequest }>('/invites/:code/accept', async (req) => {
    const ip = remoteAddr(req);
    rateLimit(ip);
    try {
      return invites.acceptInvite(req.params.code, { ...(req.body ?? ({} as AcceptInviteRequest)), ...deviceFromRequest(req, req.body) } as AcceptInviteRequest, ip ?? undefined);
    } catch (e) {
      recordFail(ip);
      throw e;
    }
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
