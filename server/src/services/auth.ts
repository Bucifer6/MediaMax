import { securityEvent } from '../util/securityLog.js';
import crypto from 'node:crypto';
import type {
  ApiKey, AuthResponse, CreatedApiKey, CreateUserRequest, TotpEnabled, TotpSetup, Device, DeviceInfo, LinkCodeResponse, LinkPollResponse, Platform,
  AudioComforts, ProfileSettings, PublicProfile, SubtitleStyle, UpdateMeRequest, UpdateUserRequest, User, UserPreferences,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId, newToken, sha256, shortCode } from '../util/ids.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../util/errors.js';
import { base32Decode, hotp, newTotpSecret, otpauthUrl } from '../util/totp.js';
import { nowIso, parseJson, ratingLevel } from '../util/misc.js';
import { getSettings, signInScreenOf } from './settings.js';
import { isLocalAddress } from '../util/net.js';
import { getBranding } from './branding.js';
import { logActivity } from './activity.js';
import { bus } from './events.js';
import { imageUrl, registerImage } from './images.js';
import { defaultPermissions, defaultQuotas, normalizePermissions, normalizeQuotas, storedPermissions, storedQuotas } from './requestPerms.js';
import { builtinAvatarUrl, isBuiltinAvatar } from './avatars.js';
import { normalizeComforts } from './audio.js';
import { Pending, sweepExpired, type Failure } from '../util/lockout.js';

/* ----------------------------- hashing ----------------------------- */

const SCRYPT = { N: 16384, r: 8, p: 1 };
/** crypto.scrypt on the libuv pool: ~40 ms of CPU per call, which must not block the event loop. */
const scrypt = (secret: string, salt: Buffer, len: number) =>
  new Promise<Buffer>((resolve, reject) => crypto.scrypt(secret, salt, len, SCRYPT, (err, key) => (err ? reject(err) : resolve(key))));

export async function hashSecret(secret: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(secret, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifySecret(secret: string, stored: string | null | undefined): Promise<boolean> {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = await scrypt(secret, Buffer.from(saltB64, 'base64'), key.length);
  return crypto.timingSafeEqual(key, test);
}

/**
 * Hashes for a request's new password / PIN (`undefined`: not being changed, `null`: being cleared). Computed before
 * the synchronous read-check-write of a user row, so no await splits it.
 */
export async function hashUserSecrets(req: { password?: string | null; pin?: string | null }) {
  const h = (v: string | null | undefined) => (v === undefined ? undefined : v ? hashSecret(v) : null);
  const [password_hash, pin_hash] = await Promise.all([h(req.password), h(req.pin)]);
  return { password_hash, pin_hash };
}
export type UserSecretHashes = Awaited<ReturnType<typeof hashUserSecrets>>;

/* ------------------------------ users ------------------------------ */

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = { size: 'medium', color: 'white', background: 'shadow', font: 'default', position: 'bottom' };

export const DEFAULT_PREFS: UserPreferences = {
  audioLanguage: null, subtitleLanguage: null, subtitleMode: 'auto', autoplayNext: true, skipIntros: false, maxBitrate: null, themeId: null,
  replayGain: 'auto', subtitleStyle: DEFAULT_SUBTITLE_STYLE, musicCrossfadeSec: 0,
};

const SUBTITLE_CHOICES: { [K in keyof SubtitleStyle]: readonly SubtitleStyle[K][] } = {
  size: ['small', 'medium', 'large', 'xlarge'],
  color: ['white', 'yellow', 'cyan', 'green'],
  background: ['none', 'shadow', 'box', 'boxSolid'],
  font: ['default', 'serif', 'mono', 'rounded'],
  position: ['bottom', 'raised'],
  // Client-rendered subtitles (web/src/player/subtitles): 0 = automatic lift (follows `position`).
  verticalOffset: [0, 5, 10, 15, 20],
  edge: ['outline', 'shadow', 'none'],
  assStyles: ['auto', 'file', 'user'],
};

/** Fill in / validate a (possibly partial) subtitle style; unknown values fall back to the current or default value. */
export function normalizeSubtitleStyle(input: unknown, base: SubtitleStyle = DEFAULT_SUBTITLE_STYLE): SubtitleStyle {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out = { ...DEFAULT_SUBTITLE_STYLE, ...base };
  for (const k of Object.keys(SUBTITLE_CHOICES) as (keyof SubtitleStyle)[]) {
    const v = src[k];
    if ((SUBTITLE_CHOICES[k] as readonly unknown[]).includes(v)) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Stored preferences merged over the defaults (nested objects merged field by field). */
function mergePrefs(stored: Partial<UserPreferences>, patch: Partial<UserPreferences> = {}): UserPreferences {
  const prefs: UserPreferences = { ...DEFAULT_PREFS, ...stored, ...patch };
  const base = normalizeSubtitleStyle(stored.subtitleStyle);
  prefs.subtitleStyle = patch.subtitleStyle ? normalizeSubtitleStyle(patch.subtitleStyle, base) : base;
  const xf = Number(prefs.musicCrossfadeSec);
  prefs.musicCrossfadeSec = Number.isFinite(xf) ? Math.max(0, Math.min(12, Math.round(xf))) : 0;
  if (!['off', 'track', 'album', 'auto'].includes(prefs.replayGain as string)) prefs.replayGain = 'auto';
  // Help Centre: the server version whose "What's new" card was dismissed.
  if (prefs.whatsNewSeen !== undefined) prefs.whatsNewSeen = typeof prefs.whatsNewSeen === 'string' && /^[\w.+-]{1,32}$/.test(prefs.whatsNewSeen) ? prefs.whatsNewSeen : null;
  // Now playing / lyrics / karaoke / visualiser preferences (web, TV and mobile music players).
  const num = (v: unknown, lo: number, hi: number) => (v === undefined || v === null || !Number.isFinite(Number(v)) ? undefined : Math.max(lo, Math.min(hi, Math.round(Number(v)))));
  if (prefs.nowPlayingView !== undefined && !['cover', 'lyrics', 'visualizer', 'karaoke'].includes(prefs.nowPlayingView)) delete prefs.nowPlayingView;
  if (prefs.visualizerStyle !== undefined && !['ring', 'bars', 'wave', 'particles', 'ambient'].includes(prefs.visualizerStyle)) delete prefs.visualizerStyle;
  for (const [k, lo, hi] of [['lyricsOffsetMs', -5000, 5000], ['karaokeVocalLevel', 0, 100], ['musicScreensaverMinutes', 0, 120]] as const) {
    if (prefs[k] === undefined) continue;
    const v = num(prefs[k], lo, hi);
    if (v === undefined) delete prefs[k];
    else prefs[k] = v;
  }
  // Listening comforts (audio.ts): validated; per-device entries merge field by field, an empty one removes the device.
  if (prefs.audio !== undefined) prefs.audio = normalizeComforts(prefs.audio);
  if (prefs.audioDevices !== undefined) {
    const merged: Record<string, AudioComforts> = {};
    const src = { ...(stored.audioDevices ?? {}), ...(patch.audioDevices ?? {}) };
    for (const id of Object.keys(src).slice(-50)) {
      const old = normalizeComforts(stored.audioDevices?.[id]);
      const next = patch.audioDevices && id in patch.audioDevices ? normalizeComforts(patch.audioDevices[id]) : null;
      if (next && !Object.keys(next).length) continue;
      merged[id.slice(0, 128)] = { ...old, ...(next ?? {}) };
    }
    prefs.audioDevices = merged;
  }
  return prefs;
}

export function toUser(r: Row): User {
  const u: User = {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    isAdmin: !!r.is_admin,
    avatarUrl: imageUrl(r.avatar),
    hasPin: !!r.pin_hash,
    pinLength: r.pin_hash ? r.pin_length ?? null : null,
    hasPassword: !!r.password_hash,
    maxContentRating: r.max_rating ?? null,
    libraryIds: parseJson<string[] | null>(r.library_ids, null),
    allowLiveTv: !!r.allow_live_tv,
    allowDownloads: !!r.allow_downloads,
    allowTranscode: !!r.allow_transcode,
    allowDvr: !!r.allow_dvr,
    allowRequest4k: !!r.allow_request_4k,
    requestPermissions: storedPermissions(r),
    requestQuotas: storedQuotas(r),
    disabled: !!r.disabled,
    allowRemote: r.allow_remote === undefined ? true : !!r.allow_remote,
    maxStreams: r.max_streams ?? null,
    totpEnabled: !!r.totp_enabled,
    showOnSignIn: !r.parent_user_id && !!r.show_on_signin,
    preferences: mergePrefs(parseJson<Partial<UserPreferences>>(r.preferences, {})),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
    parentUserId: r.parent_user_id ?? null,
    isKids: !!r.profile_kids,
    profileColor: r.profile_color ?? null,
    avatarId: r.avatar ? null : r.avatar_builtin ?? null,
    hideUnrated: !!r.hide_unrated,
  };
  if (!r.avatar && isBuiltinAvatar(r.avatar_builtin)) u.avatarUrl = builtinAvatarUrl(r.avatar_builtin);
  if (r.parent_user_id) {
    const owner = db.get('SELECT * FROM users WHERE id = ?', r.parent_user_id);
    if (owner) applyAccountLimits(u, r, owner);
  } else {
    u.profileCount = db.get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE parent_user_id = ?', r.id)!.n;
  }
  return u;
}

/** The stricter of two rating limits (null = unrestricted). */
export function stricterRating(a: string | null | undefined, b: string | null | undefined): string | null {
  const la = ratingLevel(a);
  const lb = ratingLevel(b);
  if (la === null || la < 0) return lb === null || lb < 0 ? a || b || null : b!;
  if (lb === null || lb < 0) return a!;
  return la <= lb ? a! : b!;
}

/**
 * Effective limits of a profile: never more than its owner may do. Library access is the intersection, the rating
 * limit the stricter one, the stream limit and remote access are the owner's (shared by the whole account), and a
 * profile is never an administrator and has no password or two-factor of its own.
 */
function applyAccountLimits(u: User, r: Row, owner: Row) {
  const ownerLibs = parseJson<string[] | null>(owner.library_ids, null);
  const ownLibs = u.libraryIds;
  u.libraryIds = ownerLibs === null || owner.is_admin ? ownLibs : ownLibs === null ? ownerLibs : ownLibs.filter((id) => ownerLibs.includes(id));
  u.maxContentRating = owner.is_admin ? u.maxContentRating : stricterRating(u.maxContentRating, owner.max_rating);
  u.isAdmin = false;
  u.hasPassword = false;
  u.totpEnabled = false;
  const ownerAdmin = !!owner.is_admin;
  u.allowLiveTv = u.allowLiveTv && (ownerAdmin || !!owner.allow_live_tv) && (!u.isKids || profileSettings().kidsLiveTv);
  u.allowDownloads = u.allowDownloads && (ownerAdmin || !!owner.allow_downloads);
  u.allowTranscode = ownerAdmin || !!owner.allow_transcode;
  u.allowDvr = !u.isKids && (ownerAdmin || !!owner.allow_dvr) && !!r.allow_dvr;
  u.allowRemote = ownerAdmin || owner.allow_remote === undefined || !!owner.allow_remote;
  u.maxStreams = owner.max_streams ?? null;
  u.disabled = u.disabled || !!owner.disabled;
  u.ownerName = owner.display_name;
}

export const DEFAULT_PROFILE_SETTINGS: ProfileSettings = { enabled: true, maxPerAccount: 6, kidsLiveTv: false, kidsDefaultRating: 'PG', kidsHideUnrated: true };
export function profileSettings(): ProfileSettings {
  const s = { ...DEFAULT_PROFILE_SETTINGS, ...(getSettings().profiles ?? {}) };
  s.maxPerAccount = Math.max(1, Math.min(20, Math.round(Number(s.maxPerAccount) || DEFAULT_PROFILE_SETTINGS.maxPerAccount)));
  return s;
}

/** "Owner › Profile" for profiles, the display name otherwise (activity, sessions, stats). */
export const qualifiedName = (u: Pick<User, 'displayName' | 'ownerName' | 'parentUserId'>) =>
  u.parentUserId && u.ownerName ? `${u.ownerName} › ${u.displayName}` : u.displayName;

/** The account (owner) user id of a user or profile. */
export const accountIdOf = (u: Pick<User, 'id' | 'parentUserId'>) => u.parentUserId || u.id;

export const userCount = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM users')!.n;

export function getUserRow(id: string): Row {
  const r = db.get('SELECT * FROM users WHERE id = ?', id);
  if (!r) throw notFound('User not found');
  return r;
}
export const getUser = (id: string) => toUser(getUserRow(id));
export const listUsers = () => db.all('SELECT * FROM users ORDER BY is_admin DESC, display_name').map(toUser);

function validatePin(pin: string) {
  if (!/^\d{4,8}$/.test(pin)) throw badRequest('PIN must be 4-8 digits');
}

export async function createUser(req: CreateUserRequest): Promise<User> {
  return createUserHashed(req, await hashUserSecrets(req));
}

/** createUser with the secrets already hashed (hashUserSecrets), for callers creating the user inside a transaction. */
export function createUserHashed(req: CreateUserRequest, hashes: UserSecretHashes): User {
  const username = (req.username ?? '').trim();
  if (!/^[\w.@ -]{1,64}$/.test(username)) throw badRequest('Invalid username');
  if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw conflict('Username already exists');
  if (req.password && req.password.length < 8) throw badRequest('Password must be at least 8 characters');
  if (req.pin) validatePin(req.pin);
  const id = newId();
  // New users start from the server's default request permissions; the legacy `allowRequest4k` flag still grants 4K.
  const base = defaultPermissions();
  if (req.allowRequest4k) Object.assign(base, { movie4k: base.movie4k === 'none' ? 'request' : base.movie4k, show4k: base.show4k === 'none' ? 'request' : base.show4k });
  const perms = normalizePermissions(req.requestPermissions ?? {}, base);
  db.insert('users', {
    id,
    username,
    display_name: req.displayName?.trim() || username,
    password_hash: req.password ? hashes.password_hash ?? null : null,
    pin_hash: req.pin ? hashes.pin_hash ?? null : null,
    pin_length: req.pin ? req.pin.length : null,
    is_admin: !!req.isAdmin,
    max_rating: req.maxContentRating ?? null,
    library_ids: req.libraryIds ? JSON.stringify(req.libraryIds) : null,
    allow_live_tv: req.allowLiveTv ?? true,
    allow_downloads: req.allowDownloads ?? true,
    allow_transcode: req.allowTranscode ?? true,
    allow_dvr: req.allowDvr ?? !!req.isAdmin,
    allow_request_4k: perms.movie4k !== 'none' || perms.show4k !== 'none',
    request_perms: JSON.stringify(perms),
    request_quotas: req.requestQuotas ? JSON.stringify(normalizeQuotas(req.requestQuotas, defaultQuotas())) : null,
    allow_remote: req.allowRemote ?? true,
    max_streams: req.maxStreams && req.maxStreams > 0 ? Math.min(100, Math.trunc(req.maxStreams)) : null,
    show_on_signin: !!req.showOnSignIn,
    preferences: '{}',
    created_at: nowIso(),
  });
  return getUser(id);
}

export async function updateUser(id: string, req: UpdateUserRequest, actorId: string): Promise<User> {
  // Same rules as createUser, checked before the (slow) hashing.
  if (req.password != null && typeof req.password !== 'string') throw badRequest('Password must be a string');
  if (req.password && req.password.length < 8) throw badRequest('Password must be at least 8 characters');
  if (req.pin) validatePin(req.pin);
  const hashes = await hashUserSecrets(req);
  const cur = getUserRow(id);
  if (cur.parent_user_id && (req.isAdmin || req.password || req.username !== undefined)) throw badRequest('Profiles cannot be administrators, have a password or a username; edit them under the owner\'s profiles');
  const patch: Row = {};
  if (req.username !== undefined) {
    const u = String(req.username ?? '').trim();
    if (!/^[\w.@ -]{1,64}$/.test(u)) throw badRequest('Invalid username');
    if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', u, id)) throw conflict('Username already exists');
    patch.username = u;
  }
  if (req.displayName !== undefined) patch.display_name = req.displayName.trim() || cur.username;
  if (req.password !== undefined) patch.password_hash = hashes.password_hash ?? null;
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = hashes.pin_hash ?? null;
    patch.pin_length = req.pin ? req.pin.length : null;
  }
  if (req.isAdmin !== undefined) {
    if (!req.isAdmin && cur.is_admin && adminCount() <= 1) throw badRequest('Cannot remove the last administrator');
    if (!req.isAdmin && id === actorId) throw badRequest('You cannot remove your own admin rights');
    patch.is_admin = req.isAdmin;
  }
  if (req.maxContentRating !== undefined) patch.max_rating = req.maxContentRating || null;
  if (req.libraryIds !== undefined) patch.library_ids = req.libraryIds ? JSON.stringify(req.libraryIds) : null;
  for (const [k, col] of [['allowLiveTv', 'allow_live_tv'], ['allowDownloads', 'allow_downloads'], ['allowTranscode', 'allow_transcode'], ['allowDvr', 'allow_dvr'], ['allowRequest4k', 'allow_request_4k'], ['allowRemote', 'allow_remote'], ['disabled', 'disabled'], ['showOnSignIn', 'show_on_signin']] as const) {
    if ((req as any)[k] !== undefined) patch[col] = !!(req as any)[k];
  }
  if (req.maxStreams !== undefined) patch.max_streams = req.maxStreams && req.maxStreams > 0 ? Math.min(100, Math.trunc(req.maxStreams)) : null;
  Object.assign(patch, requestPermsPatch(cur, req));
  if (patch.disabled && id === actorId) throw badRequest('You cannot disable yourself');
  // An empty password removes it (passwordless sign-in, see passwordlessAllowed), which administrators never get.
  const adminAfter = patch.is_admin !== undefined ? !!patch.is_admin : !!cur.is_admin;
  if (req.password !== undefined && !req.password && adminAfter && !cur.oidc_sub) throw badRequest('Administrators must keep a password');
  db.update('users', id, patch);
  if (patch.pin_hash !== undefined) clearFailures(`p:${id}`);
  if (patch.disabled || patch.password_hash !== undefined) {
    // Signs the account out everywhere, including its profiles' sessions.
    db.run('DELETE FROM devices WHERE user_id IN (SELECT id FROM users WHERE id = ? OR parent_user_id = ?)', id, id);
  }
  return getUser(id);
}

/** Columns for a permissions/quotas change. Old clients that only send `allowRequest4k` toggle the 4K permissions. */
export function requestPermsPatch(cur: Row, req: Pick<UpdateUserRequest, 'requestPermissions' | 'requestQuotas' | 'allowRequest4k'>): Row {
  const patch: Row = {};
  let perms = storedPermissions(cur);
  let changed = false;
  if (req.requestPermissions) {
    perms = normalizePermissions(req.requestPermissions, perms);
    changed = true;
  } else if (req.allowRequest4k !== undefined) {
    const lvl = req.allowRequest4k ? 'request' : 'none';
    perms = { ...perms, movie4k: req.allowRequest4k && perms.movie4k !== 'none' ? perms.movie4k : lvl, show4k: req.allowRequest4k && perms.show4k !== 'none' ? perms.show4k : lvl };
    changed = true;
  }
  if (changed) {
    patch.request_perms = JSON.stringify(perms);
    patch.allow_request_4k = perms.movie4k !== 'none' || perms.show4k !== 'none';
  }
  if (req.requestQuotas !== undefined) patch.request_quotas = req.requestQuotas ? JSON.stringify(normalizeQuotas(req.requestQuotas, defaultQuotas())) : null;
  return patch;
}

const adminCount = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0')!.n;

export function deleteUser(id: string, actorId: string) {
  const cur = getUserRow(id);
  if (id === actorId) throw badRequest('You cannot delete yourself');
  if (cur.is_admin && adminCount() <= 1) throw badRequest('Cannot delete the last administrator');
  // Deleting an account deletes its profiles (also enforced by the foreign key).
  db.tx(() => {
    // Series rules and still-scheduled recordings of the account and its profiles (finished recordings stay).
    const members = 'SELECT id FROM users WHERE id = ? OR parent_user_id = ?';
    db.run(`DELETE FROM recording_rules WHERE created_by IN (${members})`, id, id);
    db.run(`UPDATE recordings SET status = 'cancelled' WHERE status = 'scheduled' AND created_by IN (${members})`, id, id);
    db.run('DELETE FROM users WHERE parent_user_id = ?', id);
    db.run('DELETE FROM users WHERE id = ?', id);
  });
}

/** Cap on a user's stored preferences (serialized JSON, characters). */
export const MAX_PREFERENCES_BYTES = 64 * 1024;

/** `keepDeviceRowId`: the session making the change, which stays signed in when the password changes. */
export async function updateMe(userId: string, req: UpdateMeRequest, keepDeviceRowId?: string): Promise<User> {
  const before = getUserRow(userId);
  const currentOk = req.password !== undefined && before.password_hash ? await verifySecret(req.currentPassword ?? '', before.password_hash) : true;
  const hashes = await hashUserSecrets(req);
  const cur = getUserRow(userId);
  // Profiles have no password; their name and PIN are managed by the account owner (Settings → Profiles).
  if (cur.parent_user_id && (req.password !== undefined || req.pin !== undefined || req.displayName !== undefined)) {
    throw new HttpError(403, 'Ask the account owner to change this profile\'s name or PIN', 'profile_session');
  }
  const patch: Row = {};
  if (req.displayName !== undefined) patch.display_name = req.displayName.trim() || cur.username;
  if (req.password !== undefined) {
    // Checked against the hash read before the awaits; a password changed meanwhile must be re-entered.
    if (cur.password_hash && (!currentOk || cur.password_hash !== before.password_hash)) throw forbidden('Current password is incorrect');
    if (req.password && req.password.length < 8) throw badRequest('Password must be at least 8 characters');
    if (!req.password && cur.is_admin && !cur.oidc_sub) throw badRequest('Administrators must keep a password');
    patch.password_hash = hashes.password_hash ?? null;
  }
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = hashes.pin_hash ?? null;
    patch.pin_length = req.pin ? req.pin.length : null;
  }
  if (req.avatarId !== undefined) {
    if (req.avatarId !== null && !isBuiltinAvatar(req.avatarId)) throw badRequest('Unknown avatar');
    patch.avatar_builtin = req.avatarId;
    if (req.avatarId) patch.avatar = null;
  }
  if (req.profileColor !== undefined) {
    if (req.profileColor !== null && !/^#[0-9a-f]{6}$/i.test(req.profileColor)) throw badRequest('Colour must be a #rrggbb value');
    patch.profile_color = req.profileColor;
  }
  if (req.preferences !== undefined && req.preferences !== null) {
    if (typeof req.preferences !== 'object' || Array.isArray(req.preferences)) throw badRequest('preferences must be an object');
    const prefs = mergePrefs(parseJson<Partial<UserPreferences>>(cur.preferences, {}), req.preferences);
    if (prefs.themeId && !getBranding().themes.some((t) => t.id === prefs.themeId)) prefs.themeId = null;
    const json = JSON.stringify(prefs);
    // Parsed on every authenticated request (toUser): keep it small. A blob already over the cap may still shrink.
    if (json.length > MAX_PREFERENCES_BYTES && json.length > String(cur.preferences ?? '').length) {
      throw new HttpError(400, `Preferences are too large (over ${MAX_PREFERENCES_BYTES / 1024} KB)`, 'preferences_too_large');
    }
    patch.preferences = json;
  }
  db.update('users', userId, patch);
  if (patch.pin_hash !== undefined) clearFailures(`p:${userId}`);
  if (patch.password_hash !== undefined) {
    // A new password signs every other device out (the account's profiles included), like an admin reset does,
    // so a stolen session doesn't outlive the password change.
    db.run('DELETE FROM devices WHERE id != ? AND user_id IN (SELECT id FROM users WHERE id = ? OR parent_user_id = ?)', keepDeviceRowId ?? '', userId, userId);
    logActivity('user.password', `${cur.display_name} changed their password; other devices were signed out`, { userId });
  }
  return getUser(userId);
}

/* ----------------------------- sessions ---------------------------- */

export interface AuthContext {
  user: User;
  deviceRowId: string;
  device: DeviceInfo;
  token: string;
}

const PLATFORMS: Platform[] = ['web', 'ios', 'android', 'tvos', 'androidtv', 'roku', 'other'];

function normDevice(d: Partial<DeviceInfo>): DeviceInfo {
  return {
    deviceId: String(d.deviceId || newId()).slice(0, 128),
    deviceName: String(d.deviceName || 'Unknown device').slice(0, 128),
    platform: PLATFORMS.includes(d.platform as Platform) ? (d.platform as Platform) : 'other',
    appVersion: d.appVersion ? String(d.appVersion).slice(0, 32) : undefined,
  };
}

export function issueToken(userId: string, device: Partial<DeviceInfo>, remoteAddr?: string, opts: { switched?: boolean } = {}): AuthResponse {
  const user = getUser(userId);
  if (user.disabled) throw forbidden('This account is disabled');
  const d = normDevice(device);
  const token = newToken();
  const now = nowIso();
  // One token per (user, deviceId): replace the previous one.
  db.run('DELETE FROM devices WHERE user_id = ? AND device_id = ?', userId, d.deviceId);
  db.insert('devices', {
    id: newId(), token_hash: sha256(token), user_id: userId, device_id: d.deviceId, device_name: d.deviceName,
    platform: d.platform, app_version: d.appVersion ?? null, remote_addr: remoteAddr ?? null, created_at: now, last_seen_at: now,
  });
  db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, userId);
  const name = qualifiedName(user);
  if (opts.switched) logActivity('user.profile', `${name} is now watching on ${d.deviceName}`, { userId, userName: name });
  else logActivity('user.login', `${name} signed in on ${d.deviceName} (${d.platform})`, { userId, userName: name });
  bus.emit('user.login', { user, device: d });
  return { token, user };
}

const lastTouch = new Map<string, number>();

export function authenticate(token: string | undefined | null): AuthContext | null {
  if (!token) return null;
  if (token.startsWith(API_URL_TOKEN_PREFIX)) return authenticateApiUrlToken(token);
  const row = db.get(
    `SELECT d.id did, d.device_id, d.device_name, d.platform, d.app_version, d.last_seen_at dlast, u.*
     FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ?`, sha256(token));
  if (!row || row.disabled) return null;
  const user = toUser(row);
  if (user.disabled) return null;
  const timeoutDays = getSettings().sessionTimeoutDays;
  if (timeoutDays > 0 && Date.parse(row.dlast) < Date.now() - timeoutDays * 86400000) {
    db.run('DELETE FROM devices WHERE id = ?', row.did);
    return null;
  }
  // Throttle last-seen writes to once a minute per device.
  const t = lastTouch.get(row.did) ?? 0;
  if (Date.now() - t > 60000) {
    lastTouch.set(row.did, Date.now());
    const now = nowIso();
    db.run('UPDATE devices SET last_seen_at = ? WHERE id = ?', now, row.did);
    db.run('UPDATE users SET last_seen_at = ? WHERE id = ?', now, row.id);
  }
  return {
    user,
    deviceRowId: row.did,
    token,
    device: { deviceId: row.device_id, deviceName: row.device_name, platform: row.platform, appVersion: row.app_version ?? undefined },
  };
}

/*
 * Per-account lockout: 5 failures → 15 minutes, independent of client IP (which can't be trusted). Keys: `u:<username>`
 * (password sign-in) and `p:<userId>` (PIN). The PIN budget is shared by every way of entering a PIN (sign-in screen
 * here, profile switching in profiles.ts), so each path can't be guessed against separately.
 */
const failures = new Map<string, Failure>();
/** Attempts still being checked count as failures until they finish (the hash compare runs off-thread). */
const pending = new Pending();
function assertNotLocked(key: string, ip?: string, error?: (minutes: number) => Error) {
  const f = failures.get(key);
  const live = f && f.until > Date.now() ? f.n : 0;
  if (live + pending.count(key) >= 5) {
    securityEvent('AUTH_LOCKED', ip, { account: key });
    const minutes = Math.ceil(((live ? f!.until : Date.now() + 15 * 60000) - Date.now()) / 60000);
    throw error ? error(minutes) : Object.assign(unauthorized(`Too many failed attempts. Try again in ${minutes} minute(s).`), { statusCode: 429 });
  }
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) {
    sweepExpired(failures);
    failures.set(key, { n: 1, until: Date.now() + 15 * 60000 });
  } else f.n++;
}
const clearFailures = (key: string) => failures.delete(key);
/** The shared sign-in lockout, for the other PIN entry points (profiles.ts). */
export const signInLockout = { assertNotLocked, recordFailure, clear: clearFailures, pending, pinKey: (userId: string) => `p:${userId}` };
/** Tests only. */
export const _resetSignInLockouts = () => failures.clear();

/**
 * Accounts that may sign in without any secret: Plex-Home style kids/family profiles only.
 * Never administrators, never SSO-created accounts.
 */
let dummy: Promise<string> | null = null;
const dummyHash = () => (dummy ??= hashSecret(crypto.randomBytes(16).toString('hex')));

export const passwordlessAllowed = (r: Row) => !r.parent_user_id && !r.password_hash && !r.pin_hash && !r.is_admin && !r.oidc_sub && getSettings().allowPasswordlessProfiles;

export async function login(username: string, password: string, device: Partial<DeviceInfo>, remoteAddr?: string, totpCode?: string): Promise<AuthResponse> {
  // Request bodies are untyped JSON: anything but a string is a malformed request, not a failed sign-in.
  if ((username != null && typeof username !== 'string') || (password != null && typeof password !== 'string') || (totpCode != null && typeof totpCode !== 'string')) {
    throw badRequest('username and password must be strings');
  }
  const key = `u:${String(username ?? '').trim().toLowerCase()}`;
  assertNotLocked(key, remoteAddr);
  const row = await pending.run(key, async () => {
    const row = db.get('SELECT * FROM users WHERE username = ?', (username ?? '').trim());
    // Constant-ish time: always run exactly one hash compare (an unknown user must not take twice as long).
    const ok = row ? (row.password_hash ? await verifySecret(password ?? '', row.password_hash) : !password && passwordlessAllowed(row)) : await verifySecret(password ?? '', await dummyHash());
    if (!row || !ok) {
      recordFailure(key);
      logActivity('user.login.failed', `Failed sign-in for "${username}" from ${remoteAddr ?? 'unknown'}`, { severity: 'warning' });
      securityEvent('AUTH_FAIL', remoteAddr, { user: String(username ?? ''), reason: 'password' });
      throw unauthorized('Invalid username or password');
    }
    await checkSecondFactor(row, totpCode, key, remoteAddr);
    return row;
  });
  clearFailures(key);
  securityEvent('AUTH_OK', remoteAddr, { user: row.username });
  return issueToken(row.id, device, remoteAddr);
}

/** Second factor for accounts with TOTP enabled. Throws 401 `totp_required` when no code was sent. */
async function checkSecondFactor(row: Row, code: string | undefined, key: string, ip?: string) {
  if (!row.totp_enabled) return;
  if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', 'totp_required');
  if (row.totp_secret && acceptTotp(row.id, row.totp_secret, code)) return;
  // Recovery codes are single-use.
  const codes = parseJson<string[]>(row.recovery_codes, []);
  const norm = String(code).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  let hit: string | undefined;
  for (const h of codes) if (await verifySecret(norm, h)) { hit = h; break; }
  // Re-read after the awaits: a code used meanwhile by a concurrent sign-in is gone.
  const fresh = hit ? parseJson<string[]>(db.get('SELECT recovery_codes FROM users WHERE id = ?', row.id)?.recovery_codes, []) : [];
  const idx = hit ? fresh.indexOf(hit) : -1;
  if (idx >= 0) {
    fresh.splice(idx, 1);
    db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(fresh), row.id);
    logActivity('user.2fa', `${row.display_name} signed in with a recovery code (${fresh.length} left)`, { userId: row.id, severity: 'warning' });
    return;
  }
  recordFailure(key);
  securityEvent('AUTH_FAIL', ip, { user: row.username, reason: 'totp' });
  throw new HttpError(401, 'That code is not valid', 'totp_invalid');
}

/* ------------------------------ two-factor --------------------------- */

/**
 * Replay protection: the last time step whose code each user had accepted. A code is only accepted for a later step,
 * so one seen (shoulder-surfed, phished, logged) can't be used again within its ±30 s window. In memory: the server is
 * a single process, and after a restart the window has long passed.
 */
const lastTotpStep = new Map<string, number>();
/** Tests only. */
export const _resetTotpReplay = () => lastTotpStep.clear();

/** The time step (current, or one either side for clock drift) whose code matches, or null. */
function totpStep(secretB32: string, code: string, at = Date.now()): number | null {
  const c = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const key = base32Decode(secretB32);
  const counter = Math.floor(at / 1000 / 30);
  let hit: number | null = null;
  // Check every candidate (no early exit), and prefer the latest matching step.
  for (const d of [-1, 0, 1]) if (crypto.timingSafeEqual(Buffer.from(hotp(key, counter + d)), Buffer.from(c))) hit = counter + d;
  return hit;
}

/** Verify a TOTP code and consume its time step (synchronous: no await between the check and the write). */
function acceptTotp(userId: string, secretB32: string, code: string): boolean {
  const step = totpStep(secretB32, code);
  if (step === null) return false;
  const last = lastTotpStep.get(userId);
  if (last !== undefined && step <= last) return false;
  lastTotpStep.set(userId, step);
  return true;
}

export function totpSetup(userId: string): TotpSetup {
  const row = getUserRow(userId);
  if (row.totp_enabled) throw badRequest('Two-factor authentication is already on');
  const secret = newTotpSecret();
  db.run('UPDATE users SET totp_secret = ? WHERE id = ?', secret, userId);
  return { secret, otpauthUrl: otpauthUrl(secret, row.username, getBranding().serverName || 'Kinora') };
}

export async function totpEnable(userId: string, code: string): Promise<TotpEnabled> {
  const row = getUserRow(userId);
  if (!row.totp_secret) throw badRequest('Start two-factor setup first');
  if (!acceptTotp(userId, row.totp_secret, code)) throw badRequest('That code is not valid. Check the time on your phone and try again.');
  const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  const hashed = await Promise.all(recoveryCodes.map((c) => hashSecret(c)));
  db.run('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', JSON.stringify(hashed), userId);
  logActivity('user.2fa', `${row.display_name} turned on two-factor authentication`, { userId });
  return { recoveryCodes: recoveryCodes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
}

export function totpDisable(userId: string, code: string, actorIsAdmin = false) {
  const row = getUserRow(userId);
  if (!row.totp_enabled) return;
  if (!actorIsAdmin && !(row.totp_secret && acceptTotp(userId, row.totp_secret, code))) throw badRequest('That code is not valid');
  db.run("UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = '[]' WHERE id = ?", userId);
  logActivity('user.2fa', `Two-factor authentication turned off for ${row.display_name}`, { userId, severity: 'warning' });
}

/* -------------------------------- API keys --------------------------- */

export function listApiKeys(userId: string): ApiKey[] {
  return db.all('SELECT * FROM api_keys WHERE user_id = ? ORDER BY created_at DESC', userId)
    .map((r) => ({ id: r.id, name: r.name, prefix: r.prefix, createdAt: r.created_at, lastUsedAt: r.last_used_at ?? null }));
}

export function createApiKey(userId: string, name: string): CreatedApiKey {
  if (!name?.trim()) throw badRequest('Give the key a name');
  if (db.get<{ n: number }>('SELECT COUNT(*) n FROM api_keys WHERE user_id = ?', userId)!.n >= 50) throw badRequest('Too many API keys');
  const key = `mmk_${newToken()}`;
  const id = newId();
  const now = nowIso();
  db.insert('api_keys', { id, user_id: userId, name: name.trim().slice(0, 80), key_hash: sha256(key), prefix: key.slice(0, 10), created_at: now });
  logActivity('apikey', `API key "${name.trim()}" created`, { userId });
  return { id, name: name.trim().slice(0, 80), prefix: key.slice(0, 10), createdAt: now, lastUsedAt: null, key };
}

export function deleteApiKey(userId: string, id: string, isAdmin: boolean) {
  const r = db.get('SELECT user_id FROM api_keys WHERE id = ?', id);
  if (!r) throw notFound('API key not found');
  if (r.user_id !== userId && !isAdmin) throw forbidden();
  db.run('DELETE FROM api_keys WHERE id = ?', id);
}

/** Authenticate an `X-Api-Key` (acts as the key's owner, from a virtual "API" device). */
export function authenticateApiKey(key: string | null | undefined): AuthContext | null {
  if (!key || !key.startsWith('mmk_')) return null;
  const row = db.get('SELECT k.id kid, k.name kname, k.last_used_at klast, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?', sha256(key));
  return apiKeyContext(row);
}

function apiKeyContext(row: Row | undefined): AuthContext | null {
  if (!row || row.disabled) return null;
  const user = toUser(row);
  if (user.disabled) return null;
  if (!row.klast || Date.now() - Date.parse(row.klast) > 60000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.kid);
  // `token` ends up in media URLs (`?token=` on HLS, trickplay, subtitles…): never the long-lived key itself, but a
  // signed token naming the key that expires and dies with the key.
  return { user, deviceRowId: `apikey:${row.kid}`, token: apiUrlToken(row.kid), device: { deviceId: `apikey:${row.kid}`, deviceName: `API: ${row.kname}`, platform: 'other' } };
}

/*
 * URL tokens for API-key sessions: `mmu_<keyId>.<expiry (unix s, base36)>.<HMAC>`. Signed with a per-process secret,
 * so a restart invalidates outstanding URLs (clients ask for fresh ones, as after any session change). Long enough for
 * a film with pauses; the key being deleted or its user disabled ends it at once (checked on every use).
 */
export const API_URL_TOKEN_PREFIX = 'mmu_';
export const API_URL_TOKEN_TTL_MS = 24 * 3600_000;
const urlTokenSecret = crypto.randomBytes(32);
const urlTokenSig = (body: string) => crypto.createHmac('sha256', urlTokenSecret).update(body).digest('base64url');
export function apiUrlToken(keyId: string, now = Date.now()): string {
  const body = `${keyId}.${Math.floor((now + API_URL_TOKEN_TTL_MS) / 1000).toString(36)}`;
  return `${API_URL_TOKEN_PREFIX}${body}.${urlTokenSig(body)}`;
}
function authenticateApiUrlToken(token: string): AuthContext | null {
  const m = /^mmu_([^.]{1,64})\.([0-9a-z]{1,10})\.([\w-]{43})$/.exec(token);
  if (!m) return null;
  const expected = Buffer.from(urlTokenSig(`${m[1]}.${m[2]}`));
  if (!crypto.timingSafeEqual(expected, Buffer.from(m[3])) || parseInt(m[2], 36) * 1000 < Date.now()) return null;
  return apiKeyContext(db.get('SELECT k.id kid, k.name kname, k.last_used_at klast, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.id = ?', m[1]));
}

/**
 * Whether the public sign-in screen may list users to this client at all: the profile picker is on, the admin lets
 * it show users, and (by default) the client is on the home network. Unauthenticated, so it never lists anyone else.
 */
export function signInListAllowed(remoteAddr: string | null | undefined): boolean {
  if (!getBranding().features.profilePicker) return false;
  const s = signInScreenOf(getSettings().signInScreen);
  return s.showUsers && (!s.homeNetworkOnly || isLocalAddress(remoteAddr));
}

/** The public sign-in screen's users: only those an admin opted in ("Show on sign-in screen"). */
export function publicProfiles(remoteAddr?: string | null): PublicProfile[] {
  if (!signInListAllowed(remoteAddr)) return [];
  // Account profiles are entered through their owner's account, never from the server-wide picker.
  return db.all('SELECT * FROM users WHERE disabled = 0 AND parent_user_id IS NULL AND show_on_signin = 1 ORDER BY is_admin DESC, display_name').map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: imageUrl(r.avatar),
    hasPin: !!r.pin_hash,
    pinLength: r.pin_hash ? r.pin_length ?? null : null,
    requiresPassword: !r.pin_hash && !passwordlessAllowed(r),
  }));
}

/** Profile-picker sign in: allowed with a PIN, or with nothing if the profile has neither password nor PIN. */
export async function profileLogin(userId: string, pin: string | undefined, device: Partial<DeviceInfo>, remoteAddr?: string, totpCode?: string): Promise<AuthResponse> {
  if (!getBranding().features.profilePicker) throw forbidden('Profile sign-in is disabled');
  if (typeof userId !== 'string' || (pin != null && typeof pin !== 'string') || (totpCode != null && typeof totpCode !== 'string')) throw badRequest('userId and pin must be strings');
  const row = getUserRow(userId);
  if (row.parent_user_id) throw unauthorized('Sign in with the account this profile belongs to');
  // Only users the sign-in screen lists to this client can be entered from it (PIN-only / passwordless sign-in).
  if (!row.show_on_signin || !signInListAllowed(remoteAddr)) throw unauthorized('Sign in with your username and password');
  const key = `p:${userId}`;
  assertNotLocked(key, remoteAddr);
  await pending.run(key, async () => {
    if (row.pin_hash) {
      if (!(await verifySecret(pin ?? '', row.pin_hash))) {
        recordFailure(key);
        logActivity('user.login.failed', `Wrong PIN for ${row.display_name}`, { severity: 'warning' });
        securityEvent('AUTH_FAIL', remoteAddr, { user: row.username, reason: 'pin' });
        throw unauthorized('Incorrect PIN');
      }
    } else if (!passwordlessAllowed(row)) {
      throw unauthorized('This profile requires a password');
    }
    // A PIN never replaces the second factor.
    await checkSecondFactor(row, totpCode, key, remoteAddr);
  });
  clearFailures(key);
  return issueToken(userId, device, remoteAddr);
}

export function logout(ctx: AuthContext) {
  db.run('DELETE FROM devices WHERE id = ?', ctx.deviceRowId);
  // Signing out of a profile signs the whole account out of this device (the owner's session included).
  if (!ctx.deviceRowId.startsWith('apikey:')) {
    const acct = accountIdOf(ctx.user);
    db.run('DELETE FROM devices WHERE device_id = ? AND user_id IN (SELECT id FROM users WHERE id = ? OR parent_user_id = ?)', ctx.device.deviceId, acct, acct);
  }
}

export function listDevices(ctx: AuthContext, all: boolean): Device[] {
  const SEL = `SELECT d.*, u.display_name uname, o.display_name oname FROM devices d JOIN users u ON u.id = d.user_id LEFT JOIN users o ON o.id = u.parent_user_id`;
  // Account owners also see (and can revoke) their profiles' sessions.
  const rows = all && ctx.user.isAdmin
    ? db.all(`${SEL} ORDER BY d.last_seen_at DESC`)
    : ctx.user.parentUserId
      ? db.all(`${SEL} WHERE d.user_id = ? ORDER BY d.last_seen_at DESC`, ctx.user.id)
      : db.all(`${SEL} WHERE d.user_id = ? OR u.parent_user_id = ? ORDER BY d.last_seen_at DESC`, ctx.user.id, ctx.user.id);
  return rows.map((r) => ({
    id: r.id, deviceId: r.device_id, deviceName: r.device_name, platform: r.platform, appVersion: r.app_version,
    userId: r.user_id, userName: r.oname ? `${r.oname} › ${r.uname}` : r.uname, lastSeenAt: r.last_seen_at, current: r.id === ctx.deviceRowId,
  }));
}

export function revokeDevice(ctx: AuthContext, id: string) {
  const r = db.get('SELECT d.user_id, u.parent_user_id FROM devices d JOIN users u ON u.id = d.user_id WHERE d.id = ?', id);
  if (!r) throw notFound('Device not found');
  const ownersProfile = !ctx.user.parentUserId && r.parent_user_id === ctx.user.id;
  if (r.user_id !== ctx.user.id && !ownersProfile && !ctx.user.isAdmin) throw forbidden();
  db.run('DELETE FROM devices WHERE id = ?', id);
}

/* ---------------------------- link codes --------------------------- */

interface PendingLink {
  code: string;
  pollToken: string;
  device: DeviceInfo;
  expiresAt: number;
  ip?: string | null;
  result?: AuthResponse;
}
const links = new Map<string, PendingLink>();
/** Tests only. */
export const _resetLinks = () => links.clear();

function sweepLinks() {
  const now = Date.now();
  for (const [k, v] of links) if (v.expiresAt < now - 60000) links.delete(k);
}

/**
 * Anyone can ask for a link code, so pending codes are capped per client address and overall: bounds memory, and
 * keeps the 4-character code space sparse (a full one would also make the uniqueness loop below spin forever).
 */
export const LINK_LIMITS = { perIp: 5, total: 1000 };

export function requestLinkCode(device: Partial<DeviceInfo>, ip?: string | null): LinkCodeResponse {
  if (!getBranding().features.linkCodes) throw forbidden('Device linking is disabled');
  sweepLinks();
  const d = normDevice(device);
  // A device asking again (new code on screen) replaces its earlier, unused code.
  if (device.deviceId) for (const [k, l] of links) if (!l.result && l.device.deviceId === d.deviceId && l.ip === (ip ?? null)) links.delete(k);
  const busy = () => new HttpError(429, 'Too many devices are waiting to be linked. Try again in a few minutes.', 'rate_limited');
  if (links.size >= LINK_LIMITS.total) throw busy();
  if (ip && [...links.values()].filter((l) => l.ip === ip && !l.result).length >= LINK_LIMITS.perIp) throw busy();
  const used = new Set([...links.values()].map((l) => l.code));
  let code = shortCode(4);
  while (used.has(code)) code = shortCode(4);
  const pending: PendingLink = { code, pollToken: newToken(), device: d, expiresAt: Date.now() + 10 * 60000, ip: ip ?? null };
  links.set(pending.pollToken, pending);
  return { code, pollToken: pending.pollToken, expiresAt: new Date(pending.expiresAt).toISOString() };
}

export function pollLinkCode(pollToken: string): LinkPollResponse {
  const l = links.get(pollToken);
  if (!l || l.expiresAt < Date.now()) {
    if (l && !l.result) links.delete(pollToken);
    if (!l?.result) return { status: 'expired' };
  }
  if (l!.result) {
    links.delete(pollToken);
    return { status: 'linked', token: l!.result.token, user: l!.result.user };
  }
  return { status: 'pending' };
}

export function approveLinkCode(ctx: AuthContext, code: string, remoteAddr?: string) {
  const c = String(code ?? '').trim().toUpperCase();
  const l = [...links.values()].find((x) => x.code === c && x.expiresAt > Date.now() && !x.result);
  if (!l) throw notFound('That code is invalid or has expired');
  l.result = issueToken(ctx.user.id, l.device, remoteAddr);
  return { ok: true, deviceName: l.device.deviceName };
}

/** Set or clear a user's avatar (image file already saved on disk). */
export function setAvatar(userId: string, file: string | null): User {
  getUserRow(userId);
  // An uploaded picture replaces a built-in avatar.
  if (file) db.run('UPDATE users SET avatar = ?, avatar_builtin = NULL WHERE id = ?', registerImage(file), userId);
  else db.run('UPDATE users SET avatar = NULL WHERE id = ?', userId);
  return getUser(userId);
}
