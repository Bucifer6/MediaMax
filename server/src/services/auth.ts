import { securityEvent } from '../util/securityLog.js';
import crypto from 'node:crypto';
import type {
  ApiKey, AuthResponse, CreatedApiKey, CreateUserRequest, TotpEnabled, TotpSetup, Device, DeviceInfo, LinkCodeResponse, LinkPollResponse, Platform,
  AudioComforts, ProfileSettings, PublicProfile, SubtitleStyle, UpdateMeRequest, UpdateUserRequest, User, UserPreferences,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId, newToken, sha256, shortCode } from '../util/ids.js';
import { badRequest, conflict, forbidden, HttpError, notFound, unauthorized } from '../util/errors.js';
import { newTotpSecret, otpauthUrl, verifyTotp } from '../util/totp.js';
import { nowIso, parseJson, ratingLevel } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { logActivity } from './activity.js';
import { bus } from './events.js';
import { imageUrl, registerImage } from './images.js';
import { defaultPermissions, defaultQuotas, normalizePermissions, normalizeQuotas, storedPermissions, storedQuotas } from './requestPerms.js';
import { builtinAvatarUrl, isBuiltinAvatar } from './avatars.js';
import { normalizeComforts } from './audio.js';

/* ----------------------------- hashing ----------------------------- */

export function hashSecret(secret: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifySecret(secret: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const [algo, saltB64, keyB64] = stored.split('$');
  if (algo !== 'scrypt') return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(secret, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

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

/** Ids of every user on an account: the owner and its profiles. */
export const accountMemberIds = (accountId: string): string[] =>
  db.all<{ id: string }>('SELECT id FROM users WHERE id = ? OR parent_user_id = ?', accountId, accountId).map((r) => r.id);

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

export function createUser(req: CreateUserRequest): User {
  const username = (req.username ?? '').trim();
  if (!/^[\w.@ -]{1,64}$/.test(username)) throw badRequest('Invalid username');
  if (db.get('SELECT 1 FROM users WHERE username = ?', username)) throw conflict('Username already exists');
  if (req.password && req.password.length < 4) throw badRequest('Password must be at least 4 characters');
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
    password_hash: req.password ? hashSecret(req.password) : null,
    pin_hash: req.pin ? hashSecret(req.pin) : null,
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
    preferences: '{}',
    created_at: nowIso(),
  });
  return getUser(id);
}

export function updateUser(id: string, req: UpdateUserRequest, actorId: string): User {
  const cur = getUserRow(id);
  if (cur.parent_user_id && (req.isAdmin || req.password || req.username !== undefined)) throw badRequest('Profiles cannot be administrators, have a password or a username; edit them under the owner\'s profiles');
  const patch: Row = {};
  if (req.username !== undefined) {
    const u = req.username.trim();
    if (!u) throw badRequest('Invalid username');
    if (db.get('SELECT 1 FROM users WHERE username = ? AND id != ?', u, id)) throw conflict('Username already exists');
    patch.username = u;
  }
  if (req.displayName !== undefined) patch.display_name = req.displayName.trim() || cur.username;
  if (req.password !== undefined) patch.password_hash = req.password ? hashSecret(req.password) : null;
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = req.pin ? hashSecret(req.pin) : null;
    patch.pin_length = req.pin ? req.pin.length : null;
  }
  if (req.isAdmin !== undefined) {
    if (!req.isAdmin && cur.is_admin && adminCount() <= 1) throw badRequest('Cannot remove the last administrator');
    if (!req.isAdmin && id === actorId) throw badRequest('You cannot remove your own admin rights');
    patch.is_admin = req.isAdmin;
  }
  if (req.maxContentRating !== undefined) patch.max_rating = req.maxContentRating || null;
  if (req.libraryIds !== undefined) patch.library_ids = req.libraryIds ? JSON.stringify(req.libraryIds) : null;
  for (const [k, col] of [['allowLiveTv', 'allow_live_tv'], ['allowDownloads', 'allow_downloads'], ['allowTranscode', 'allow_transcode'], ['allowDvr', 'allow_dvr'], ['allowRequest4k', 'allow_request_4k'], ['allowRemote', 'allow_remote'], ['disabled', 'disabled']] as const) {
    if ((req as any)[k] !== undefined) patch[col] = !!(req as any)[k];
  }
  if (req.maxStreams !== undefined) patch.max_streams = req.maxStreams && req.maxStreams > 0 ? Math.min(100, Math.trunc(req.maxStreams)) : null;
  Object.assign(patch, requestPermsPatch(cur, req));
  if (patch.disabled && id === actorId) throw badRequest('You cannot disable yourself');
  db.update('users', id, patch);
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

/** `keepDeviceRowId`: the session making the change, which stays signed in when the password changes. */
export function updateMe(userId: string, req: UpdateMeRequest, keepDeviceRowId?: string): User {
  const cur = getUserRow(userId);
  // Profiles have no password; their name and PIN are managed by the account owner (Settings → Profiles).
  if (cur.parent_user_id && (req.password !== undefined || req.pin !== undefined || req.displayName !== undefined)) {
    throw new HttpError(403, 'Ask the account owner to change this profile\'s name or PIN', 'profile_session');
  }
  const patch: Row = {};
  if (req.displayName !== undefined) patch.display_name = req.displayName.trim() || cur.username;
  if (req.password !== undefined) {
    if (cur.password_hash && !verifySecret(req.currentPassword ?? '', cur.password_hash)) throw forbidden('Current password is incorrect');
    if (req.password && req.password.length < 4) throw badRequest('Password must be at least 4 characters');
    if (!req.password && cur.is_admin && !cur.oidc_sub) throw badRequest('Administrators must keep a password');
    patch.password_hash = req.password ? hashSecret(req.password) : null;
  }
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = req.pin ? hashSecret(req.pin) : null;
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
  if (req.preferences) {
    const prefs = mergePrefs(parseJson<Partial<UserPreferences>>(cur.preferences, {}), req.preferences);
    if (prefs.themeId && !getBranding().themes.some((t) => t.id === prefs.themeId)) prefs.themeId = null;
    patch.preferences = JSON.stringify(prefs);
  }
  db.update('users', userId, patch);
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

const PLATFORMS: Platform[] = ['web', 'ios', 'android', 'tvos', 'androidtv', 'other'];

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

/* Per-account lockout: 5 failures → 15 minutes, independent of client IP (which can't be trusted). */
const failures = new Map<string, { n: number; until: number }>();
function assertNotLocked(key: string, ip?: string) {
  const f = failures.get(key);
  if (f && f.n >= 5 && f.until > Date.now()) {
    securityEvent('AUTH_LOCKED', ip, { account: key });
    throw Object.assign(unauthorized(`Too many failed attempts. Try again in ${Math.ceil((f.until - Date.now()) / 60000)} minute(s).`), { statusCode: 429 });
  }
}
function recordFailure(key: string) {
  const f = failures.get(key);
  if (!f || f.until < Date.now()) failures.set(key, { n: 1, until: Date.now() + 15 * 60000 });
  else f.n++;
}
const clearFailures = (key: string) => failures.delete(key);

/**
 * Accounts that may sign in without any secret: Plex-Home style kids/family profiles only.
 * Never administrators, never SSO-created accounts.
 */
let dummy: string | null = null;
const dummyHash = () => (dummy ??= hashSecret(crypto.randomBytes(16).toString('hex')));

export const passwordlessAllowed = (r: Row) => !r.parent_user_id && !r.password_hash && !r.pin_hash && !r.is_admin && !r.oidc_sub && getSettings().allowPasswordlessProfiles;

export function login(username: string, password: string, device: Partial<DeviceInfo>, remoteAddr?: string, totpCode?: string): AuthResponse {
  const key = `u:${String(username ?? '').trim().toLowerCase()}`;
  assertNotLocked(key, remoteAddr);
  const row = db.get('SELECT * FROM users WHERE username = ?', (username ?? '').trim());
  // Constant-ish time: always run exactly one hash compare (an unknown user must not take twice as long).
  const ok = row ? (row.password_hash ? verifySecret(password ?? '', row.password_hash) : !password && passwordlessAllowed(row)) : verifySecret(password ?? '', dummyHash());
  if (!row || !ok) {
    recordFailure(key);
    logActivity('user.login.failed', `Failed sign-in for "${username}" from ${remoteAddr ?? 'unknown'}`, { severity: 'warning' });
    securityEvent('AUTH_FAIL', remoteAddr, { user: String(username ?? ''), reason: 'password' });
    throw unauthorized('Invalid username or password');
  }
  checkSecondFactor(row, totpCode, key, remoteAddr);
  clearFailures(key);
  securityEvent('AUTH_OK', remoteAddr, { user: row.username });
  return issueToken(row.id, device, remoteAddr);
}

/** Second factor for accounts with TOTP enabled. Throws 401 `totp_required` when no code was sent. */
function checkSecondFactor(row: Row, code: string | undefined, key: string, ip?: string) {
  if (!row.totp_enabled) return;
  if (!code) throw new HttpError(401, 'Enter the 6-digit code from your authenticator app', 'totp_required');
  if (row.totp_secret && verifyTotp(row.totp_secret, code)) return;
  // Recovery codes are single-use.
  const codes = parseJson<string[]>(row.recovery_codes, []);
  const norm = String(code).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const idx = codes.findIndex((h) => verifySecret(norm, h));
  if (idx >= 0) {
    codes.splice(idx, 1);
    db.run('UPDATE users SET recovery_codes = ? WHERE id = ?', JSON.stringify(codes), row.id);
    logActivity('user.2fa', `${row.display_name} signed in with a recovery code (${codes.length} left)`, { userId: row.id, severity: 'warning' });
    return;
  }
  recordFailure(key);
  securityEvent('AUTH_FAIL', ip, { user: row.username, reason: 'totp' });
  throw new HttpError(401, 'That code is not valid', 'totp_invalid');
}

/* ------------------------------ two-factor --------------------------- */

export function totpSetup(userId: string): TotpSetup {
  const row = getUserRow(userId);
  if (row.totp_enabled) throw badRequest('Two-factor authentication is already on');
  const secret = newTotpSecret();
  db.run('UPDATE users SET totp_secret = ? WHERE id = ?', secret, userId);
  return { secret, otpauthUrl: otpauthUrl(secret, row.username, getBranding().serverName || 'MediaMax') };
}

export function totpEnable(userId: string, code: string): TotpEnabled {
  const row = getUserRow(userId);
  if (!row.totp_secret) throw badRequest('Start two-factor setup first');
  if (!verifyTotp(row.totp_secret, code)) throw badRequest('That code is not valid. Check the time on your phone and try again.');
  const recoveryCodes = Array.from({ length: 8 }, () => crypto.randomBytes(5).toString('hex'));
  db.run('UPDATE users SET totp_enabled = 1, recovery_codes = ? WHERE id = ?', JSON.stringify(recoveryCodes.map((c) => hashSecret(c))), userId);
  logActivity('user.2fa', `${row.display_name} turned on two-factor authentication`, { userId });
  return { recoveryCodes: recoveryCodes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
}

export function totpDisable(userId: string, code: string, actorIsAdmin = false) {
  const row = getUserRow(userId);
  if (!row.totp_enabled) return;
  if (!actorIsAdmin && !(row.totp_secret && verifyTotp(row.totp_secret, code))) throw badRequest('That code is not valid');
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
  if (!row || row.disabled) return null;
  if (!row.klast || Date.now() - Date.parse(row.klast) > 60000) db.run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.kid);
  return { user: toUser(row), deviceRowId: `apikey:${row.kid}`, token: key, device: { deviceId: `apikey:${row.kid}`, deviceName: `API: ${row.kname}`, platform: 'other' } };
}

export function publicProfiles(): PublicProfile[] {
  if (!getBranding().features.profilePicker) return [];
  // Account profiles are entered through their owner's account, never from the server-wide picker.
  return db.all('SELECT * FROM users WHERE disabled = 0 AND parent_user_id IS NULL ORDER BY is_admin DESC, display_name').map((r) => ({
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
export function profileLogin(userId: string, pin: string | undefined, device: Partial<DeviceInfo>, remoteAddr?: string, totpCode?: string): AuthResponse {
  if (!getBranding().features.profilePicker) throw forbidden('Profile sign-in is disabled');
  const row = getUserRow(userId);
  if (row.parent_user_id) throw unauthorized('Sign in with the account this profile belongs to');
  const key = `p:${userId}`;
  assertNotLocked(key, remoteAddr);
  if (row.pin_hash) {
    if (!verifySecret(pin ?? '', row.pin_hash)) {
      recordFailure(key);
      logActivity('user.login.failed', `Wrong PIN for ${row.display_name}`, { severity: 'warning' });
      securityEvent('AUTH_FAIL', remoteAddr, { user: row.username, reason: 'pin' });
      throw unauthorized('Incorrect PIN');
    }
  } else if (!passwordlessAllowed(row)) {
    throw unauthorized('This profile requires a password');
  }
  // A PIN never replaces the second factor.
  checkSecondFactor(row, totpCode, key, remoteAddr);
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
