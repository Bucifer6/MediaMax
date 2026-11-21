/**
 * Smart downloads: per-device, per-show rules ("keep the next N unwatched episodes on this phone, delete watched ones
 * after 24 h"). The phone enforces Wi-Fi / charging and does the downloading; the server stores the rules (so the web
 * app and other devices can show them) and answers "what should this device have?" with the viewer's access rules
 * applied (libraries, parental limits, profiles).
 *
 * Offline sync: progress / watched changes made without a connection are replayed with their device timestamps; a
 * change older than the server's last change for that item (user_data.last_played_at) is skipped and the server state
 * returned, so the newest change wins in both directions.
 */
import type { DownloadedItemState, DownloadPlan, DownloadQuality, DownloadRule, DownloadRuleInput, Item, OfflineSyncEntry, OfflineSyncResult, Platform, User } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { newId } from '../util/ids.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { nowIso } from '../util/misc.js';
import { assertCanSee, getItem, nextItem, reportProgress, selectItems, setPlayed } from './items.js';
import type { AuthContext } from './auth.js';

export const KEEP_COUNTS = [1, 3, 5, 10];
const QUALITIES: DownloadQuality[] = ['original', '1080p', '720p', '480p'];
/** Longest "delete watched after" delay (30 days). */
const MAX_DELETE_HOURS = 720;

function assertDownloadsAllowed(u: User) {
  if (!u.allowDownloads && !u.isAdmin) throw forbidden('Downloads are not enabled for your account');
}

function canSee(user: User, itemId: string): Row | null {
  try {
    return assertCanSee(user, itemId);
  } catch {
    return null;
  }
}

function rowToRule(r: Row, user: User, currentDevice: string | null): DownloadRule {
  let showTitle = r.show_title ?? 'Unknown show';
  let posterUrl: string | null = null;
  try {
    const show = getItem(user, r.show_id, false);
    showTitle = show.title;
    posterUrl = show.posterUrl;
  } catch {
    /* hidden from this user now: keep the stored title */
  }
  return {
    id: r.id, showId: r.show_id, showTitle, posterUrl, deviceId: r.device_id, deviceName: r.device_name, platform: r.platform as Platform,
    keepCount: r.keep_count, deleteWatchedAfterHours: r.delete_watched_after_hours ?? null, wifiOnly: !!r.wifi_only, chargingOnly: !!r.charging_only,
    quality: (r.quality as DownloadQuality) ?? 'original', createdAt: r.created_at, updatedAt: r.updated_at, lastSyncAt: r.last_sync_at ?? null,
    current: currentDevice != null && r.device_id === currentDevice,
  };
}

/** Rules of the user: this device's only, or every device's (web management page). */
export function listRules(ctx: AuthContext, scope: 'device' | 'all' = 'all'): DownloadRule[] {
  const rows = scope === 'device'
    ? db.all("SELECT r.*, i.title show_title FROM download_rules r LEFT JOIN items i ON i.id = r.show_id WHERE r.user_id = ? AND r.device_id = ? ORDER BY r.created_at", ctx.user.id, ctx.device.deviceId)
    : db.all("SELECT r.*, i.title show_title FROM download_rules r LEFT JOIN items i ON i.id = r.show_id WHERE r.user_id = ? ORDER BY r.device_name, r.created_at", ctx.user.id);
  return rows.map((r) => rowToRule(r, ctx.user, ctx.device.deviceId));
}

export function normalizeRuleInput(input: Partial<DownloadRuleInput>): Required<DownloadRuleInput> {
  const keep = Number(input.keepCount);
  if (!KEEP_COUNTS.includes(keep)) throw badRequest(`keepCount must be one of ${KEEP_COUNTS.join(', ')}`);
  let hours: number | null = input.deleteWatchedAfterHours == null ? null : Number(input.deleteWatchedAfterHours);
  if (hours != null && (!Number.isFinite(hours) || hours < 0)) throw badRequest('deleteWatchedAfterHours must be a positive number of hours or null');
  if (hours != null) hours = Math.min(MAX_DELETE_HOURS, Math.round(hours));
  const quality = input.quality ?? 'original';
  if (!QUALITIES.includes(quality)) throw badRequest('quality must be original, 1080p, 720p or 480p');
  return { keepCount: keep, deleteWatchedAfterHours: hours, wifiOnly: input.wifiOnly ?? true, chargingOnly: !!input.chargingOnly, quality };
}

/** Create or update this device's rule for a show. */
export function putRule(ctx: AuthContext, showId: string, input: Partial<DownloadRuleInput>): DownloadRule {
  assertDownloadsAllowed(ctx.user);
  const show = assertCanSee(ctx.user, showId);
  if (show.type !== 'show') throw badRequest('Smart downloads follow a show');
  const r = normalizeRuleInput(input);
  const now = nowIso();
  db.run(
    `INSERT INTO download_rules (id, user_id, device_id, device_name, platform, show_id, keep_count, delete_watched_after_hours, wifi_only, charging_only, quality, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (user_id, device_id, show_id) DO UPDATE SET keep_count = excluded.keep_count, delete_watched_after_hours = excluded.delete_watched_after_hours,
       wifi_only = excluded.wifi_only, charging_only = excluded.charging_only, quality = excluded.quality, device_name = excluded.device_name, updated_at = excluded.updated_at`,
    newId(), ctx.user.id, ctx.device.deviceId, ctx.device.deviceName, ctx.device.platform, showId, r.keepCount, r.deleteWatchedAfterHours,
    r.wifiOnly ? 1 : 0, r.chargingOnly ? 1 : 0, r.quality, now, now,
  );
  const row = db.get('SELECT * FROM download_rules WHERE user_id = ? AND device_id = ? AND show_id = ?', ctx.user.id, ctx.device.deviceId, showId)!;
  return rowToRule(row, ctx.user, ctx.device.deviceId);
}

/** Remove one of the user's rules (any of their devices: the web page manages them all). */
export function deleteRule(ctx: AuthContext, id: string) {
  const r = db.get('SELECT user_id FROM download_rules WHERE id = ?', id);
  if (!r || r.user_id !== ctx.user.id) throw notFound('Rule not found');
  db.run('DELETE FROM download_rules WHERE id = ?', id);
}

const EPISODE_ORDER = 'ORDER BY COALESCE(i.parent_idx,0) = 0, COALESCE(i.parent_idx,0), COALESCE(i.idx,0)';

/**
 * The next `n` unwatched episodes of a show for this user: starting at its next-up episode (in progress, else the
 * first unplayed after the last watched, else the first unplayed), in watching order, specials last. Hidden episodes
 * (library access, parental limits) never appear.
 */
export function nextUnwatched(user: User, showId: string, n: number): Item[] {
  if (!canSee(user, showId) || n <= 0) return [];
  const start = nextItem(user, showId);
  if (!start) return [];
  const unplayed = selectItems(user, "i.grandparent_id = ? AND i.type = 'episode' AND COALESCE(ud.played,0) = 0", [showId], EPISODE_ORDER);
  const from = unplayed.findIndex((e) => e.id === start.id);
  return unplayed.slice(Math.max(0, from), Math.max(0, from) + n);
}

function stateOf(user: User, itemId: string): DownloadedItemState & { showId: string | null } {
  const row = canSee(user, itemId);
  if (!row) return { itemId, played: false, lastPlayedAt: null, positionMs: 0, gone: true, showId: null };
  const ud = db.get('SELECT played, position_ms, last_played_at FROM user_data WHERE user_id = ? AND item_id = ?', user.id, itemId);
  return { itemId, played: !!ud?.played, lastPlayedAt: ud?.last_played_at ?? null, positionMs: ud?.position_ms ?? 0, gone: false, showId: row.type === 'episode' ? row.grandparent_id ?? null : null };
}

/** Should a downloaded episode be deleted now? Watched, and watched longer ago than the rule allows. */
export function watchedCleanupDue(s: Pick<DownloadedItemState, 'played' | 'lastPlayedAt'>, deleteAfterHours: number | null, now = Date.now()): boolean {
  if (deleteAfterHours == null || !s.played) return false;
  const at = s.lastPlayedAt ? Date.parse(s.lastPlayedAt) : NaN;
  // Watched with no timestamp (marked long ago): due now.
  if (!Number.isFinite(at)) return true;
  return now - at >= deleteAfterHours * 3600_000;
}

/** "What should this device have?" for its rules, plus the state of what it has (and what to delete). */
export function devicePlan(ctx: AuthContext, have: string[], now = Date.now()): DownloadPlan {
  const ids = [...new Set((Array.isArray(have) ? have : []).filter((x) => typeof x === 'string'))].slice(0, 5000);
  const rules = listRules(ctx, 'device');
  db.run('UPDATE download_rules SET last_sync_at = ? WHERE user_id = ? AND device_id = ?', nowIso(), ctx.user.id, ctx.device.deviceId);
  const want = rules.map((r) => ({ ruleId: r.id, showId: r.showId, items: nextUnwatched(ctx.user, r.showId, r.keepCount) }));
  const states = ids.map((id) => stateOf(ctx.user, id));
  const wanted = new Set(want.flatMap((w) => w.items.map((i) => i.id)));
  const ruleByShow = new Map(rules.map((r) => [r.showId, r]));
  const remove: DownloadPlan['remove'] = [];
  for (const s of states) {
    if (s.gone) remove.push({ itemId: s.itemId, reason: 'gone' });
    else if (s.showId && ruleByShow.has(s.showId) && !wanted.has(s.itemId) && watchedCleanupDue(s, ruleByShow.get(s.showId)!.deleteWatchedAfterHours, now)) remove.push({ itemId: s.itemId, reason: 'watched' });
  }
  return { rules, want, have: states.map(({ showId: _s, ...rest }) => rest), remove, generatedAt: new Date(now).toISOString() };
}

/** Replay offline progress / watched changes; the newest change (device or server) wins. */
export function syncOffline(ctx: AuthContext, entries: OfflineSyncEntry[]): OfflineSyncResult {
  const list = (Array.isArray(entries) ? entries : []).slice(0, 2000);
  const applied: string[] = [];
  const skipped: string[] = [];
  // Several entries for one item: keep only the newest.
  const newest = new Map<string, OfflineSyncEntry>();
  for (const e of list) {
    if (!e || typeof e.itemId !== 'string' || !e.at || !Number.isFinite(Date.parse(e.at))) continue;
    const prev = newest.get(e.itemId);
    if (!prev || Date.parse(e.at) >= Date.parse(prev.at)) newest.set(e.itemId, e);
  }
  for (const e of newest.values()) {
    if (!canSee(ctx.user, e.itemId)) {
      skipped.push(e.itemId);
      continue;
    }
    const ud = db.get('SELECT last_played_at FROM user_data WHERE user_id = ? AND item_id = ?', ctx.user.id, e.itemId);
    if (ud?.last_played_at && Date.parse(ud.last_played_at) > Date.parse(e.at)) {
      skipped.push(e.itemId);
      continue;
    }
    if (e.played === true) setPlayed(ctx.user, e.itemId, true);
    else {
      if (e.played === false) setPlayed(ctx.user, e.itemId, false);
      if (typeof e.positionMs === 'number' && e.positionMs > 0) reportProgress(ctx.user, e.itemId, e.positionMs, e.durationMs ?? null, 'stopped');
    }
    applied.push(e.itemId);
  }
  return { applied, skipped, state: [...newest.keys()].map((id) => stateOf(ctx.user, id)).map(({ showId: _s, ...rest }) => rest) };
}
