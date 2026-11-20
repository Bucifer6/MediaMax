import type { FastifyInstance } from 'fastify';
import type { CreateProfileRequest, ProfileSettings, SwitchProfileRequest, UpdateProfileRequest } from '@mediamax/shared';
import { noCache, remoteAddr, requireAccountOwner, requireAdmin, requireUser } from '../http.js';
import * as profiles from '../services/profiles.js';
import { getUserRow, profileSettings, setAvatar } from '../services/auth.js';
import { avatarSvg, listAvatars } from '../services/avatars.js';
import { HttpError, notFound } from '../util/errors.js';
import { saveAvatar } from './auth.js';
import { stopUserSessions } from '../services/playback.js';

/* Per-IP limit on PIN guesses across all profiles (the per-profile lockout lives in the service). */
const attempts = new Map<string, { n: number; until: number }>();
function ipLimit(ip: string | null) {
  const a = attempts.get(ip ?? '?');
  if (a && a.until > Date.now() && a.n >= 20) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.', 'rate_limited');
}
function ipFail(ip: string | null) {
  const k = ip ?? '?';
  const a = attempts.get(k);
  if (!a || a.until < Date.now()) attempts.set(k, { n: 1, until: Date.now() + 10 * 60000 });
  else a.n++;
}

export default async function profileRoutes(app: FastifyInstance) {
  /* Built-in avatars (public: shown before/while choosing a profile). */
  app.get('/avatars', async () => listAvatars());
  app.get<{ Params: { file: string } }>('/avatars/:file', async (req, reply) => {
    const svg = avatarSvg(req.params.file.replace(/\.svg$/, ''));
    if (!svg) throw notFound('Avatar not found');
    reply.header('Cache-Control', 'public, max-age=86400').type('image/svg+xml');
    return svg;
  });

  /* "Who's watching?" */
  app.get('/auth/account/profiles', async (req, reply) => {
    noCache(reply);
    return profiles.accountProfiles(requireUser(req));
  });
  app.post<{ Params: { id: string }; Body: SwitchProfileRequest }>('/auth/profiles/:id/switch', async (req) => {
    const ctx = requireUser(req);
    const ip = remoteAddr(req);
    ipLimit(ip);
    try {
      return profiles.switchProfile(ctx, req.params.id, req.body?.pin, ip ?? undefined);
    } catch (e) {
      if (e instanceof HttpError && e.statusCode === 401) ipFail(ip);
      throw e;
    }
  });

  /* Server-wide profile settings the clients need (limits). Admins change them with PUT /settings { profiles }. */
  app.get('/profiles/settings', async (req): Promise<ProfileSettings> => {
    requireUser(req);
    return profileSettings();
  });

  /* The owner's own profiles. */
  app.get('/profiles', async (req) => profiles.listProfiles(requireAccountOwner(req).user.id));
  app.post<{ Body: CreateProfileRequest }>('/profiles', async (req) => {
    const { user } = requireAccountOwner(req);
    return profiles.createProfile(user, user.id, req.body ?? ({} as CreateProfileRequest));
  });
  app.get<{ Params: { id: string } }>('/profiles/:id', async (req) => profiles.getProfile(requireUser(req).user, req.params.id));
  app.patch<{ Params: { id: string }; Body: UpdateProfileRequest }>('/profiles/:id', async (req) =>
    profiles.updateProfile(requireUser(req).user, req.params.id, req.body ?? {}));
  app.delete<{ Params: { id: string } }>('/profiles/:id', async (req) => {
    profiles.deleteProfile(requireUser(req).user, req.params.id);
    stopUserSessions(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/profiles/:id/avatar', async (req) => {
    profiles.assertProfileManaged(requireUser(req).user, req.params.id);
    setAvatar(req.params.id, await saveAvatar(req, req.params.id));
    return profiles.toProfile(getUserRow(req.params.id));
  });
  app.delete<{ Params: { id: string } }>('/profiles/:id/avatar', async (req) => {
    profiles.assertProfileManaged(requireUser(req).user, req.params.id);
    setAvatar(req.params.id, null);
    return profiles.toProfile(getUserRow(req.params.id));
  });

  /* Admin: profiles of any account. */
  app.get<{ Params: { id: string } }>('/users/:id/profiles', async (req) => {
    requireAdmin(req);
    return profiles.listProfiles(profiles.ownerForAdmin(req.params.id).id);
  });
  app.post<{ Params: { id: string }; Body: CreateProfileRequest }>('/users/:id/profiles', async (req) => {
    const a = requireAdmin(req);
    return profiles.createProfile(a.user, profiles.ownerForAdmin(req.params.id).id, req.body ?? ({} as CreateProfileRequest));
  });
}
