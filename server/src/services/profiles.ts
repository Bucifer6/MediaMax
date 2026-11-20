/**
 * Account profiles (Plex Home / Netflix "Who's watching?").
 *
 * Design: a profile is a row in `users` with `parent_user_id` = the account owner. Because every per-user table
 * (user_data, watchlist, play_history, preferences, channel favourites, requests, …) is keyed by user id, profiles
 * get their own progress, history, My List, ratings, recommendations and settings with no other schema change.
 * Profiles have no password, username sign-in or second factor: a device signs in as the owner and then switches
 * (POST /auth/profiles/:id/switch), which issues a session token for the profile on that device. A profile's
 * effective limits never exceed its owner's (see applyAccountLimits in auth.ts).
 */
import type { AccountProfile, AuthResponse, CreateProfileRequest, Profile, RequestPermissions, UpdateProfileRequest, User, UserPreferences } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId } from '../util/ids.js';
import { badRequest, forbidden, HttpError, notFound } from '../util/errors.js';
import { nowIso, parseJson, ratingLevel } from '../util/misc.js';
import { securityEvent } from '../util/securityLog.js';
import { imageUrl } from './images.js';
import { logActivity } from './activity.js';
import { getBranding } from './branding.js';
import { avatarColor, builtinAvatarUrl, isBuiltinAvatar } from './avatars.js';
import { getUser, getUserRow, hashSecret, issueToken, profileSettings, qualifiedName, toUser, verifySecret, type AuthContext } from './auth.js';
import { capPermissions, NO_REQUEST_PERMISSIONS, normalizePermissions, normalizeQuotas, defaultQuotas, ownerPermissions } from './requestPerms.js';
import { allowedLibraryIds } from './items.js';

const COLORS = ['#e50914', '#f5b700', '#2a9d8f', '#4361ee', '#7b2cbf', '#ef476f', '#06d6a0', '#ff7a59'];

const avatarUrlOf = (r: Row) => (r.avatar ? imageUrl(r.avatar) : isBuiltinAvatar(r.avatar_builtin) ? builtinAvatarUrl(r.avatar_builtin) : null);

/** The account owner row of a user or profile. */
export function accountOwnerRow(userId: string): Row {
  const r = getUserRow(userId);
  return r.parent_user_id ? getUserRow(r.parent_user_id) : r;
}

export function toProfile(r: Row, owner?: Row): Profile {
  const o = owner ?? getUserRow(r.parent_user_id);
  const prefs = parseJson<Partial<UserPreferences>>(r.preferences, {});
  const quotas = parseJson<Profile['requestQuotas']>(r.request_quotas, null);
  return {
    id: r.id,
    ownerId: o.id,
    ownerName: o.display_name,
    displayName: r.display_name,
    avatarUrl: avatarUrlOf(r),
    avatarId: r.avatar ? null : r.avatar_builtin ?? null,
    color: r.profile_color ?? null,
    isKids: !!r.profile_kids,
    hasPin: !!r.pin_hash,
    pinLength: r.pin_hash ? r.pin_length ?? null : null,
    language: prefs.audioLanguage ?? null,
    maxContentRating: r.max_rating ?? null,
    hideUnrated: !!r.hide_unrated,
    libraryIds: parseJson<string[] | null>(r.library_ids, null),
    allowLiveTv: !!r.allow_live_tv,
    allowDownloads: !!r.allow_downloads,
    requestPermissions: r.request_perms ? { ...normalizePermissions(parseJson(r.request_perms, {})), manageRequests: false } : null,
    requestQuotas: quotas ? normalizeQuotas(quotas, defaultQuotas()) : null,
    themeId: prefs.themeId ?? null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
  };
}

/** Profiles of an account (not including the owner). */
export function listProfiles(ownerId: string): Profile[] {
  const owner = getUserRow(ownerId);
  if (owner.parent_user_id) throw badRequest('Profiles cannot have profiles');
  return db.all('SELECT * FROM users WHERE parent_user_id = ? ORDER BY created_at', ownerId).map((r) => toProfile(r, owner));
}

/** The "Who's watching?" list for the account of the current session: the owner first, then its profiles. */
export function accountProfiles(ctx: AuthContext): AccountProfile[] {
  const owner = accountOwnerRow(ctx.user.id);
  const rows = [owner, ...db.all('SELECT * FROM users WHERE parent_user_id = ? AND disabled = 0 ORDER BY created_at', owner.id)];
  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    avatarUrl: avatarUrlOf(r),
    avatarId: r.avatar ? null : r.avatar_builtin ?? null,
    color: r.profile_color ?? null,
    isKids: !!r.profile_kids,
    isOwner: r.id === owner.id,
    hasPin: !!r.pin_hash,
    pinLength: r.pin_hash ? r.pin_length ?? null : null,
    current: r.id === ctx.user.id,
  }));
}

/** Only the account owner (or an administrator acting as one) may manage an account's profiles. */
export function assertCanManage(actor: User, ownerId: string) {
  if (actor.parentUserId) throw new HttpError(403, 'Switch to the account owner\'s profile to manage profiles', 'profile_session');
  if (actor.id !== ownerId && !actor.isAdmin) throw forbidden('You can only manage your own profiles');
}

function validatePin(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw badRequest('PIN must be 4-8 digits');
}

function uniqueUsername(owner: Row, name: string): string {
  const slug = name.toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'profile';
  const base = `${owner.username}.${slug}`.slice(0, 60);
  let u = base;
  for (let i = 2; db.get('SELECT 1 FROM users WHERE username = ?', u); i++) u = `${base}${i}`;
  return u;
}

/** Columns for the shared create/update fields. */
function profilePatch(owner: Row, cur: Row | null, req: UpdateProfileRequest, actor: User): Row {
  const patch: Row = {};
  if (req.displayName !== undefined) {
    const n = String(req.displayName ?? '').trim().slice(0, 40);
    if (!n) throw badRequest('Give the profile a name');
    patch.display_name = n;
  }
  if (req.avatarId !== undefined) {
    if (req.avatarId !== null && !isBuiltinAvatar(req.avatarId)) throw badRequest('Unknown avatar');
    patch.avatar_builtin = req.avatarId;
    if (req.avatarId) patch.avatar = null;
  }
  if (req.color !== undefined) {
    if (req.color !== null && !/^#[0-9a-f]{6}$/i.test(req.color)) throw badRequest('Colour must be a #rrggbb value');
    patch.profile_color = req.color;
  }
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = req.pin ? hashSecret(req.pin) : null;
    patch.pin_length = req.pin ? req.pin.length : null;
  }
  if (req.isKids !== undefined) patch.profile_kids = !!req.isKids;
  if (req.maxContentRating !== undefined) {
    const r = req.maxContentRating ? String(req.maxContentRating).trim().slice(0, 16) : null;
    if (r && ratingLevel(r) === -1) throw badRequest(`Unknown content rating "${r}"`);
    patch.max_rating = r;
  }
  if (req.hideUnrated !== undefined) patch.hide_unrated = !!req.hideUnrated;
  if (req.libraryIds !== undefined) {
    if (req.libraryIds === null) patch.library_ids = null;
    else {
      // A subset of what the owner may see.
      const allowed = allowedLibraryIds(toUser(owner));
      patch.library_ids = JSON.stringify([...new Set(req.libraryIds)].filter((id) => allowed.includes(id)));
    }
  }
  if (req.allowLiveTv !== undefined) patch.allow_live_tv = !!req.allowLiveTv;
  if (req.allowDownloads !== undefined) patch.allow_downloads = !!req.allowDownloads;
  if (req.requestPermissions !== undefined) {
    if (req.requestPermissions === null) patch.request_perms = null;
    else {
      const base = cur?.request_perms ? normalizePermissions(parseJson(cur.request_perms, {})) : ownerPermissions(owner);
      let p: RequestPermissions = normalizePermissions(req.requestPermissions, base);
      // Owners can only give a profile what they have themselves; admins can set anything (except managing requests).
      p = actor.isAdmin ? { ...p, manageRequests: false } : capPermissions(p, ownerPermissions(owner));
      patch.request_perms = JSON.stringify(p);
      patch.allow_request_4k = p.movie4k !== 'none' || p.show4k !== 'none';
    }
  }
  if (req.requestQuotas !== undefined) {
    if (!actor.isAdmin) throw forbidden('Only an administrator can give a profile its own request quota');
    patch.request_quotas = req.requestQuotas ? JSON.stringify(normalizeQuotas(req.requestQuotas, defaultQuotas())) : null;
  }
  if (req.language !== undefined || req.kidsTheme !== undefined) {
    const prefs = parseJson<Partial<UserPreferences>>(cur?.preferences ?? '{}', {});
    if (req.language !== undefined) {
      const lang = req.language ? String(req.language).trim().toLowerCase().slice(0, 8) : null;
      if (lang && !/^[a-z]{2,3}(-[a-z0-9]{2,4})?$/.test(lang)) throw badRequest('Language must be a language code such as "en"');
      prefs.audioLanguage = lang;
      prefs.subtitleLanguage = lang;
    }
    if (req.kidsTheme !== undefined) {
      const kidsTheme = getBranding().themes.some((t) => t.id === 'kids') ? 'kids' : null;
      if (req.kidsTheme) prefs.themeId = kidsTheme;
      else if (prefs.themeId === 'kids') prefs.themeId = null;
    }
    patch.preferences = JSON.stringify(prefs);
  }
  return patch;
}

export function createProfile(actor: User, ownerId: string, req: CreateProfileRequest): Profile {
  assertCanManage(actor, ownerId);
  const settings = profileSettings();
  if (!settings.enabled) throw forbidden('Profiles are turned off on this server');
  const owner = getUserRow(ownerId);
  if (owner.parent_user_id) throw badRequest('Profiles cannot have profiles');
  const n = db.get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE parent_user_id = ?', ownerId)!.n;
  if (n + 1 >= settings.maxPerAccount) throw new HttpError(409, `An account can have up to ${settings.maxPerAccount} profiles (including the owner's)`, 'profile_limit');
  const kids = !!req.isKids;
  const id = newId();
  const name = String(req.displayName ?? '').trim().slice(0, 40);
  if (!name) throw badRequest('Give the profile a name');
  const avatar = req.avatarId === undefined ? null : req.avatarId;
  db.insert('users', {
    id,
    username: uniqueUsername(owner, name),
    display_name: name,
    password_hash: null,
    is_admin: 0,
    parent_user_id: ownerId,
    profile_kids: kids,
    profile_color: COLORS[n % COLORS.length],
    allow_live_tv: true,
    allow_downloads: true,
    allow_transcode: true,
    allow_dvr: !kids,
    allow_remote: true,
    // Kids: no requests by default; others inherit the owner's permissions (NULL).
    request_perms: kids ? JSON.stringify(NO_REQUEST_PERMISSIONS) : null,
    max_rating: kids ? settings.kidsDefaultRating || 'PG' : null,
    hide_unrated: kids && settings.kidsHideUnrated,
    preferences: '{}',
    created_at: nowIso(),
  });
  const patch = profilePatch(owner, getUserRow(id), { ...req, displayName: undefined, kidsTheme: req.kidsTheme ?? kids }, actor);
  if (req.color == null && avatar) patch.profile_color = avatarColor(avatar);
  db.update('users', id, patch);
  const p = toProfile(getUserRow(id), owner);
  logActivity('profile.create', `${owner.display_name} added the ${kids ? 'kids ' : ''}profile ${p.displayName}`, { userId: actor.id, userName: qualifiedName(actor) });
  return p;
}

/** The profile row, checked to belong to an account the actor may manage. */
function managedRow(actor: User, profileId: string): { row: Row; owner: Row } {
  const row = db.get('SELECT * FROM users WHERE id = ?', profileId);
  if (!row || !row.parent_user_id) throw notFound('Profile not found');
  assertCanManage(actor, row.parent_user_id);
  return { row, owner: getUserRow(row.parent_user_id) };
}

export function getProfile(actor: User, profileId: string): Profile {
  const { row, owner } = managedRow(actor, profileId);
  return toProfile(row, owner);
}

export function updateProfile(actor: User, profileId: string, req: UpdateProfileRequest): Profile {
  const { row, owner } = managedRow(actor, profileId);
  const patch = profilePatch(owner, row, req, actor);
  // Turning a profile into a kids profile applies the kids defaults the request didn't set.
  if (req.isKids === true && !row.profile_kids) {
    const s = profileSettings();
    if (req.maxContentRating === undefined && !row.max_rating) patch.max_rating = s.kidsDefaultRating || 'PG';
    if (req.requestPermissions === undefined) patch.request_perms = JSON.stringify(NO_REQUEST_PERMISSIONS);
    if (req.hideUnrated === undefined) patch.hide_unrated = s.kidsHideUnrated;
    patch.allow_dvr = false;
  }
  if (req.isKids === false && row.profile_kids) patch.allow_dvr = true;
  db.update('users', profileId, patch);
  if (patch.pin_hash !== undefined) clearFailures(`p:${profileId}`);
  return toProfile(getUserRow(profileId), owner);
}

export function deleteProfile(actor: User, profileId: string) {
  const { row, owner } = managedRow(actor, profileId);
  db.tx(() => {
    db.run('DELETE FROM recording_rules WHERE created_by = ?', profileId);
    db.run("UPDATE recordings SET status = 'cancelled' WHERE status = 'scheduled' AND created_by = ?", profileId);
    db.run('DELETE FROM users WHERE id = ?', profileId);
  });
  logActivity('profile.delete', `${owner.display_name} removed the profile ${row.display_name}`, { userId: actor.id, userName: qualifiedName(actor) });
}

/** Owner-or-admin check for the profile avatar routes. */
export function assertProfileManaged(actor: User, profileId: string) {
  managedRow(actor, profileId);
}

/* ------------------------------ switching ------------------------------ */

/* Same lockout as the PIN sign-in: 5 wrong PINs → 15 minutes, per target profile. */
const failures = new Map<string, { n: number; until: number }>();
function assertNotLocked(key: string, ip?: string) {
  const f = failures.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) {
    securityEvent('AUTH_LOCKED', ip, { account: key });
    throw new HttpError(429, `Too many wrong PINs. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minute(s).`, 'pin_locked');
  }
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { n: 1, until: Date.now() + 15 * 60000 });
  else f.n++;
}
const clearFailures = (key: string) => failures.delete(key);
/** Tests only. */
export const _resetProfileLockouts = () => failures.clear();

/**
 * Switch the current device to another profile of the same account. Works from the owner's session and from any
 * profile session (so a kids profile can only get back to the owner with the owner's PIN when one is set).
 * The previous session on this device ends; a new token for the target profile is returned.
 */
export function switchProfile(ctx: AuthContext, targetId: string, pin: string | undefined, remoteAddr?: string): AuthResponse {
  if (ctx.deviceRowId.startsWith('apikey:')) throw forbidden('API keys cannot switch profiles');
  const owner = accountOwnerRow(ctx.user.id);
  const target = db.get('SELECT * FROM users WHERE id = ?', targetId);
  if (!target || (target.id !== owner.id && target.parent_user_id !== owner.id)) throw notFound('Profile not found');
  if (target.disabled || owner.disabled) throw forbidden('This profile is disabled');
  if (target.parent_user_id && !profileSettings().enabled) throw forbidden('Profiles are turned off on this server');
  const key = `p:${target.id}`;
  if (target.pin_hash && target.id !== ctx.user.id) {
    assertNotLocked(key, remoteAddr);
    // No PIN sent: the client is asking whether one is needed; that is not a failed attempt.
    if (!pin) throw new HttpError(401, 'Enter the profile PIN', 'pin_required');
    if (!verifySecret(String(pin), target.pin_hash)) {
      recordFailure(key);
      logActivity('user.login.failed', `Wrong PIN for the profile ${target.display_name}`, { severity: 'warning', userId: ctx.user.id });
      securityEvent('AUTH_FAIL', remoteAddr, { user: target.username, reason: 'profile_pin' });
      throw new HttpError(401, 'Incorrect PIN', 'pin_invalid');
    }
    clearFailures(key);
  }
  const res = issueToken(target.id, ctx.device, remoteAddr, { switched: true });
  // One account session per device: the session we switched away from ends.
  if (target.id !== ctx.user.id) db.run('DELETE FROM devices WHERE id = ?', ctx.deviceRowId);
  return res;
}

/** Resolve the account owner for the admin "profiles of user X" routes. */
export function ownerForAdmin(userId: string): User {
  const u = getUser(userId);
  if (u.parentUserId) throw badRequest('Profiles cannot have profiles');
  return u;
}
