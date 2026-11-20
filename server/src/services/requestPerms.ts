/**
 * Per-user request permissions and quotas (Overseerr/Jellyseerr-style).
 *
 * Users store `request_perms` (JSON RequestPermissions). Users created before permissions existed have none stored:
 * their permissions are derived from the legacy fields — `allow_request_4k` and `ServerSettings.requests.autoApproveUserIds`
 * — so upgrading changes nothing for anyone. New users get `requests.defaultPermissions`.
 */
import type {
  RequestMediaType, RequestPermissionKind, RequestPermissionLevel, RequestPermissions, RequestQuota, RequestQuotaKind, RequestQuotas,
  RequestQuotaStatus, ServerSettings, User,
} from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';

const LEVELS: RequestPermissionLevel[] = ['none', 'request', 'auto'];
export const PERMISSION_KINDS: RequestPermissionKind[] = ['movie', 'show', 'movie4k', 'show4k', 'music', 'book'];
export const QUOTA_KINDS: RequestQuotaKind[] = ['movie', 'show', 'music', 'book'];

export const DEFAULT_PERMISSIONS: RequestPermissions = {
  movie: 'request', show: 'request', movie4k: 'none', show4k: 'none', music: 'request', book: 'request',
  manageRequests: false, reportIssues: true, watchlistAutoRequest: false,
};
const ADMIN_PERMISSIONS: RequestPermissions = {
  movie: 'auto', show: 'auto', movie4k: 'auto', show4k: 'auto', music: 'auto', book: 'auto', manageRequests: true, reportIssues: true, watchlistAutoRequest: true,
};

/** Fill in / validate (possibly partial) permissions over a base. */
export function normalizePermissions(input: unknown, base: RequestPermissions = DEFAULT_PERMISSIONS): RequestPermissions {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: RequestPermissions = { ...DEFAULT_PERMISSIONS, ...base };
  for (const k of PERMISSION_KINDS) if (LEVELS.includes(src[k] as RequestPermissionLevel)) out[k] = src[k] as RequestPermissionLevel;
  for (const k of ['manageRequests', 'reportIssues', 'watchlistAutoRequest'] as const) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  return out;
}

const quota = (q: unknown, base: RequestQuota): RequestQuota => {
  const src = q && typeof q === 'object' ? (q as Record<string, unknown>) : {};
  const limit = Number(src.limit);
  const days = Number(src.days);
  return {
    limit: Number.isFinite(limit) ? Math.max(0, Math.min(10000, Math.round(limit))) : base.limit,
    days: Number.isFinite(days) && days >= 1 ? Math.min(365, Math.round(days)) : base.days,
  };
};

/** Quotas seeded from the legacy "weekly limit" (which counted every request): the same number per kind per 7 days. */
export const quotasFromWeekly = (weekly: number): RequestQuotas => {
  const q = { limit: Math.max(0, Math.round(weekly || 0)), days: 7 };
  return { movie: { ...q }, show: { ...q }, music: { ...q }, book: { ...q } };
};

export function normalizeQuotas(input: unknown, base: RequestQuotas): RequestQuotas {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  return { movie: quota(src.movie, base.movie), show: quota(src.show, base.show), music: quota(src.music, base.music), book: quota(src.book, base.book) };
}

type ReqSettings = ServerSettings['requests'];
export const defaultPermissions = (s: ReqSettings = getSettings().requests) => normalizePermissions(s.defaultPermissions);
export const defaultQuotas = (s: ReqSettings = getSettings().requests): RequestQuotas =>
  s.defaultQuotas ? normalizeQuotas(s.defaultQuotas, quotasFromWeekly(s.weeklyLimit ?? 0)) : quotasFromWeekly(s.weeklyLimit ?? 0);

/** Permissions for a user row with nothing stored: what the old `allowRequest4k` + auto-approve list meant. */
export function legacyPermissions(r: Row): RequestPermissions {
  const auto = (getSettings().requests.autoApproveUserIds ?? []).includes(r.id);
  const base: RequestPermissionLevel = auto ? 'auto' : 'request';
  const uhd: RequestPermissionLevel = r.allow_request_4k ? base : 'none';
  return { ...DEFAULT_PERMISSIONS, movie: base, show: base, music: base, book: base, movie4k: uhd, show4k: uhd };
}

/** Stored (or legacy-derived) permissions of a user row. */
export function storedPermissions(r: Row): RequestPermissions {
  const stored = parseJson<Partial<RequestPermissions> | null>(r.request_perms, null);
  return stored ? normalizePermissions(stored) : legacyPermissions(r);
}
export const storedQuotas = (r: Row): RequestQuotas | null => {
  const q = parseJson<RequestQuotas | null>(r.request_quotas, null);
  return q ? normalizeQuotas(q, defaultQuotas()) : null;
};

/** What a user may actually do: admins can do everything. */
export function effectivePermissions(user: User): RequestPermissions {
  if (user.isAdmin) return { ...ADMIN_PERMISSIONS };
  if (user.requestPermissions) return normalizePermissions(user.requestPermissions);
  const row = db.get('SELECT * FROM users WHERE id = ?', user.id);
  return row ? storedPermissions(row) : { ...DEFAULT_PERMISSIONS };
}

export const canManageRequests = (user: User) => user.isAdmin || effectivePermissions(user).manageRequests;

/** Permission kind for a request type (+4K copy). */
export function permissionKind(type: RequestMediaType, uhd = false): RequestPermissionKind {
  if (type === 'movie') return uhd ? 'movie4k' : 'movie';
  if (type === 'show') return uhd ? 'show4k' : 'show';
  if (type === 'book') return 'book';
  return 'music';
}
export const quotaKind = (type: RequestMediaType): RequestQuotaKind => (type === 'movie' ? 'movie' : type === 'show' ? 'show' : type === 'book' ? 'book' : 'music');
const typesOf = (k: RequestQuotaKind): RequestMediaType[] => (k === 'music' ? ['artist', 'album'] : [k]);

/** Effective level for a request (the 4K copy needs its own permission; auto only if both are auto). */
export function requestLevel(user: User, type: RequestMediaType, also4k = false): RequestPermissionLevel {
  const p = effectivePermissions(user);
  const base = p[permissionKind(type)];
  if (!also4k || base === 'none') return base;
  const uhd = p[permissionKind(type, true)];
  if (uhd === 'none') return 'none';
  return base === 'auto' && uhd === 'auto' ? 'auto' : 'request';
}

export const quotasFor = (user: User): RequestQuotas => (user.requestQuotas ? normalizeQuotas(user.requestQuotas, defaultQuotas()) : defaultQuotas());

/** Is this user exempt from the quota of a kind? */
export function quotaExempt(user: User, kind: RequestQuotaKind): boolean {
  if (user.isAdmin) return true;
  const s = getSettings().requests;
  const p = effectivePermissions(user);
  if (s.quotaExemptManagers !== false && p.manageRequests) return true;
  if (s.quotaExemptAutoApprove && p[kind === 'music' ? 'music' : kind] === 'auto') return true;
  return false;
}

/**
 * Used quota: units (seasons for shows, 1 otherwise) of this user's requests of the kind inside the rolling window.
 * Declined requests don't count (Overseerr semantics).
 */
export function quotaStatus(user: User, kind: RequestQuotaKind, now = Date.now()): RequestQuotaStatus {
  const q = quotasFor(user)[kind];
  const exempt = quotaExempt(user, kind);
  if (!q.limit) return { limit: 0, days: q.days, used: 0, remaining: null, resetsAt: null, exempt };
  const since = new Date(now - q.days * 86400000).toISOString();
  const types = typesOf(kind);
  const rows = db.all<{ requested_at: string; units: number }>(
    `SELECT requested_at, COALESCE(json_extract(options, '$.units'), 1) units FROM media_requests
     WHERE requested_by = ? AND requested_at > ? AND status != 'declined' AND media_type IN (${types.map(() => '?').join(',')}) ORDER BY requested_at`,
    user.id, since, ...types);
  const used = rows.reduce((n, r) => n + Math.max(1, Number(r.units) || 1), 0);
  const resetsAt = rows.length ? new Date(Date.parse(rows[0].requested_at) + q.days * 86400000).toISOString() : null;
  return { limit: q.limit, days: q.days, used, remaining: exempt ? null : Math.max(0, q.limit - used), resetsAt, exempt };
}

export const allQuotaStatus = (user: User): Record<RequestQuotaKind, RequestQuotaStatus> =>
  Object.fromEntries(QUOTA_KINDS.map((k) => [k, quotaStatus(user, k)])) as Record<RequestQuotaKind, RequestQuotaStatus>;

/** Users who manage requests (admins + request managers), for notifications. */
export function requestManagers(): string[] {
  return db.all('SELECT * FROM users WHERE disabled = 0').filter((r) => r.is_admin || storedPermissions(r).manageRequests).map((r) => r.id as string);
}
