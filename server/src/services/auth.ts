import crypto from 'node:crypto';
import type {
  AuthResponse, CreateUserRequest, Device, DeviceInfo, LinkCodeResponse, LinkPollResponse, Platform,
  PublicProfile, UpdateMeRequest, UpdateUserRequest, User, UserPreferences,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId, newToken, sha256, shortCode } from '../util/ids.js';
import { badRequest, conflict, forbidden, notFound, unauthorized } from '../util/errors.js';
import { nowIso, parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';
import { getBranding } from './branding.js';
import { logActivity } from './activity.js';
import { bus } from './events.js';

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

export const DEFAULT_PREFS: UserPreferences = {
  audioLanguage: null, subtitleLanguage: null, subtitleMode: 'auto', autoplayNext: true, skipIntros: false, maxBitrate: null, themeId: null,
};

export function toUser(r: Row): User {
  return {
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    isAdmin: !!r.is_admin,
    avatarUrl: r.avatar ?? null,
    hasPin: !!r.pin_hash,
    hasPassword: !!r.password_hash,
    maxContentRating: r.max_rating ?? null,
    libraryIds: parseJson<string[] | null>(r.library_ids, null),
    allowLiveTv: !!r.allow_live_tv,
    allowDownloads: !!r.allow_downloads,
    allowTranscode: !!r.allow_transcode,
    allowDvr: !!r.allow_dvr,
    disabled: !!r.disabled,
    preferences: { ...DEFAULT_PREFS, ...parseJson<Partial<UserPreferences>>(r.preferences, {}) },
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at ?? null,
  };
}

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
  db.insert('users', {
    id,
    username,
    display_name: req.displayName?.trim() || username,
    password_hash: req.password ? hashSecret(req.password) : null,
    pin_hash: req.pin ? hashSecret(req.pin) : null,
    is_admin: !!req.isAdmin,
    max_rating: req.maxContentRating ?? null,
    library_ids: req.libraryIds ? JSON.stringify(req.libraryIds) : null,
    allow_live_tv: req.allowLiveTv ?? true,
    allow_downloads: req.allowDownloads ?? true,
    allow_transcode: req.allowTranscode ?? true,
    allow_dvr: req.allowDvr ?? !!req.isAdmin,
    preferences: '{}',
    created_at: nowIso(),
  });
  return getUser(id);
}

export function updateUser(id: string, req: UpdateUserRequest, actorId: string): User {
  const cur = getUserRow(id);
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
  }
  if (req.isAdmin !== undefined) {
    if (!req.isAdmin && cur.is_admin && adminCount() <= 1) throw badRequest('Cannot remove the last administrator');
    if (!req.isAdmin && id === actorId) throw badRequest('You cannot remove your own admin rights');
    patch.is_admin = req.isAdmin;
  }
  if (req.maxContentRating !== undefined) patch.max_rating = req.maxContentRating || null;
  if (req.libraryIds !== undefined) patch.library_ids = req.libraryIds ? JSON.stringify(req.libraryIds) : null;
  for (const [k, col] of [['allowLiveTv', 'allow_live_tv'], ['allowDownloads', 'allow_downloads'], ['allowTranscode', 'allow_transcode'], ['allowDvr', 'allow_dvr'], ['disabled', 'disabled']] as const) {
    if ((req as any)[k] !== undefined) patch[col] = !!(req as any)[k];
  }
  if (patch.disabled && id === actorId) throw badRequest('You cannot disable yourself');
  db.update('users', id, patch);
  if (patch.disabled || patch.password_hash !== undefined) {
    db.run('DELETE FROM devices WHERE user_id = ?', id);
  }
  return getUser(id);
}

const adminCount = () => db.get<{ n: number }>('SELECT COUNT(*) n FROM users WHERE is_admin = 1 AND disabled = 0')!.n;

export function deleteUser(id: string, actorId: string) {
  const cur = getUserRow(id);
  if (id === actorId) throw badRequest('You cannot delete yourself');
  if (cur.is_admin && adminCount() <= 1) throw badRequest('Cannot delete the last administrator');
  db.run('DELETE FROM users WHERE id = ?', id);
}

export function updateMe(userId: string, req: UpdateMeRequest): User {
  const cur = getUserRow(userId);
  const patch: Row = {};
  if (req.displayName !== undefined) patch.display_name = req.displayName.trim() || cur.username;
  if (req.password !== undefined) {
    if (cur.password_hash && !verifySecret(req.currentPassword ?? '', cur.password_hash)) throw forbidden('Current password is incorrect');
    if (req.password && req.password.length < 4) throw badRequest('Password must be at least 4 characters');
    patch.password_hash = req.password ? hashSecret(req.password) : null;
  }
  if (req.pin !== undefined) {
    if (req.pin) validatePin(req.pin);
    patch.pin_hash = req.pin ? hashSecret(req.pin) : null;
  }
  if (req.preferences) {
    const prefs = { ...DEFAULT_PREFS, ...parseJson(cur.preferences, {}), ...req.preferences };
    if (prefs.themeId && !getBranding().themes.some((t) => t.id === prefs.themeId)) prefs.themeId = null;
    patch.preferences = JSON.stringify(prefs);
  }
  db.update('users', userId, patch);
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

export function issueToken(userId: string, device: Partial<DeviceInfo>, remoteAddr?: string): AuthResponse {
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
  logActivity('user.login', `${user.displayName} signed in on ${d.deviceName} (${d.platform})`, { userId, userName: user.displayName });
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
    user: toUser(row),
    deviceRowId: row.did,
    token,
    device: { deviceId: row.device_id, deviceName: row.device_name, platform: row.platform, appVersion: row.app_version ?? undefined },
  };
}

export function login(username: string, password: string, device: Partial<DeviceInfo>, remoteAddr?: string): AuthResponse {
  const row = db.get('SELECT * FROM users WHERE username = ?', (username ?? '').trim());
  // Constant-ish time: always run a hash compare.
  const ok = row ? (row.password_hash ? verifySecret(password ?? '', row.password_hash) : !password && getSettings().allowPasswordlessProfiles) : verifySecret('x', hashSecret('y'));
  if (!row || !ok) {
    logActivity('user.login.failed', `Failed sign-in for "${username}" from ${remoteAddr ?? 'unknown'}`, { severity: 'warning' });
    throw unauthorized('Invalid username or password');
  }
  return issueToken(row.id, device, remoteAddr);
}

export function publicProfiles(): PublicProfile[] {
  if (!getBranding().features.profilePicker) return [];
  return db.all('SELECT * FROM users WHERE disabled = 0 ORDER BY is_admin DESC, display_name').map((r) => ({
    id: r.id,
    username: r.username,
    displayName: r.display_name,
    avatarUrl: r.avatar ?? null,
    hasPin: !!r.pin_hash,
    requiresPassword: !!r.password_hash && !r.pin_hash,
  }));
}

/** Profile-picker sign in: allowed with a PIN, or with nothing if the profile has neither password nor PIN. */
export function profileLogin(userId: string, pin: string | undefined, device: Partial<DeviceInfo>, remoteAddr?: string): AuthResponse {
  if (!getBranding().features.profilePicker) throw forbidden('Profile sign-in is disabled');
  const row = getUserRow(userId);
  if (row.pin_hash) {
    if (!verifySecret(pin ?? '', row.pin_hash)) {
      logActivity('user.login.failed', `Wrong PIN for ${row.display_name}`, { severity: 'warning' });
      throw unauthorized('Incorrect PIN');
    }
  } else if (row.password_hash || !getSettings().allowPasswordlessProfiles) {
    throw unauthorized('This profile requires a password');
  }
  return issueToken(userId, device, remoteAddr);
}

export function logout(ctx: AuthContext) {
  db.run('DELETE FROM devices WHERE id = ?', ctx.deviceRowId);
}

export function listDevices(ctx: AuthContext, all: boolean): Device[] {
  const rows = all && ctx.user.isAdmin
    ? db.all('SELECT d.*, u.display_name uname FROM devices d JOIN users u ON u.id = d.user_id ORDER BY d.last_seen_at DESC')
    : db.all('SELECT d.*, u.display_name uname FROM devices d JOIN users u ON u.id = d.user_id WHERE d.user_id = ? ORDER BY d.last_seen_at DESC', ctx.user.id);
  return rows.map((r) => ({
    id: r.id, deviceId: r.device_id, deviceName: r.device_name, platform: r.platform, appVersion: r.app_version,
    userId: r.user_id, userName: r.uname, lastSeenAt: r.last_seen_at, current: r.id === ctx.deviceRowId,
  }));
}

export function revokeDevice(ctx: AuthContext, id: string) {
  const r = db.get('SELECT user_id FROM devices WHERE id = ?', id);
  if (!r) throw notFound('Device not found');
  if (r.user_id !== ctx.user.id && !ctx.user.isAdmin) throw forbidden();
  db.run('DELETE FROM devices WHERE id = ?', id);
}

/* ---------------------------- link codes --------------------------- */

interface PendingLink {
  code: string;
  pollToken: string;
  device: DeviceInfo;
  expiresAt: number;
  result?: AuthResponse;
}
const links = new Map<string, PendingLink>();

function sweepLinks() {
  const now = Date.now();
  for (const [k, v] of links) if (v.expiresAt < now - 60000) links.delete(k);
}

export function requestLinkCode(device: Partial<DeviceInfo>): LinkCodeResponse {
  if (!getBranding().features.linkCodes) throw forbidden('Device linking is disabled');
  sweepLinks();
  let code = shortCode(4);
  while ([...links.values()].some((l) => l.code === code)) code = shortCode(4);
  const pending: PendingLink = { code, pollToken: newToken(), device: normDevice(device), expiresAt: Date.now() + 10 * 60000 };
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
