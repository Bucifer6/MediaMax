/**
 * Smart downloads — the pure decisions behind state/downloads.tsx (no React Native imports; unit-tested in
 * tests/smart-downloads.test.mjs).
 *
 * The server stores the per-show rules and answers "what should this device have?" (POST /downloads/plan: the next N
 * unwatched episodes per rule with the user's access rules applied, plus watched / gone items to delete). This module
 * turns that answer and the device's conditions (Wi-Fi, charging, storage limit, paused) into actions: what to queue,
 * what to delete, and what we are waiting for. When offline it applies the same watched-cleanup rule locally.
 */
import type { DownloadedItemState, DownloadPlan, DownloadQuality, DownloadRule, Item, OfflineSyncEntry } from '@/api/types';

export interface SmartSettings {
  /** Every download (manual and automatic) waits for Wi-Fi. */
  wifiOnly: boolean;
  /** Downloads may use at most this much space; watched downloads are evicted oldest-watched first. null = no limit. */
  storageLimitGb: number | null;
  /** All transfers paused by the user. */
  paused: boolean;
  /** Defaults for new show rules. */
  defaultKeepCount: number;
  deleteWatchedAfterHours: number | null;
  /** New rules fetch only while charging. */
  chargingOnly: boolean;
}

export const DEFAULT_SMART_SETTINGS: SmartSettings = { wifiOnly: true, storageLimitGb: null, paused: false, defaultKeepCount: 3, deleteWatchedAfterHours: 24, chargingOnly: false };
export const KEEP_OPTIONS = [1, 3, 5, 10];
export const STORAGE_LIMIT_OPTIONS: (number | null)[] = [null, 2, 5, 10, 25, 50, 100];
export const DELETE_AFTER_OPTIONS: (number | null)[] = [null, 0, 24, 72, 168];

export const deleteAfterLabel = (h: number | null) => (h == null ? 'Never' : h === 0 ? 'Right after watching' : h < 48 ? `After ${h} hours` : `After ${Math.round(h / 24)} days`);
export const storageLimitLabel = (gb: number | null) => (gb == null ? 'No limit' : `${gb} GB`);

/** What smart-download logic needs from a download record. */
export interface LocalDownload {
  id: string;
  state: 'queued' | 'downloading' | 'done' | 'error' | 'paused';
  bytes: number;
  total: number;
  createdAt: string;
  item: Pick<Item, 'type' | 'durationMs' | 'grandparentId'> & { media?: { size?: number | null; bitrate?: number | null }[] | null };
  quality?: DownloadQuality;
  /** Watched (on this device or according to the server) and when. */
  watched?: boolean;
  watchedAt?: string | null;
  /** Rule that fetched it automatically. */
  ruleId?: string | null;
  positionMs: number;
  pendingSync?: boolean;
}

export interface Conditions {
  online: boolean;
  wifi: boolean;
  charging: boolean;
}

export type WaitingFor = 'paused' | 'offline' | 'wifi' | 'charging' | 'storage';

export const waitingLabel: Record<WaitingFor, string> = {
  paused: 'Paused',
  offline: 'Waiting for a connection',
  wifi: 'Waiting for Wi-Fi',
  charging: 'Waiting for charging',
  storage: 'Storage limit reached',
};

/** May a transfer run now (globally, and for a rule's own Wi-Fi / charging conditions)? */
export function canTransfer(s: Pick<SmartSettings, 'paused' | 'wifiOnly'>, c: Conditions, rule?: Pick<DownloadRule, 'wifiOnly' | 'chargingOnly'> | null): { ok: true } | { ok: false; waitingFor: WaitingFor } {
  if (s.paused) return { ok: false, waitingFor: 'paused' };
  if (!c.online) return { ok: false, waitingFor: 'offline' };
  if ((s.wifiOnly || rule?.wifiOnly) && !c.wifi) return { ok: false, waitingFor: 'wifi' };
  if (rule?.chargingOnly && !c.charging) return { ok: false, waitingFor: 'charging' };
  return { ok: true };
}

const QUALITY_KBPS: Record<Exclude<DownloadQuality, 'original'>, number> = { '1080p': 8000, '720p': 4000, '480p': 1500 };

/** Expected size of a download (bytes): the file size for originals, bitrate × duration for converted copies. */
export function estimateBytes(item: LocalDownload['item'], quality: DownloadQuality = 'original'): number {
  const durS = (item.durationMs ?? 0) / 1000;
  if (quality === 'original') {
    const size = item.media?.[0]?.size;
    if (size) return size;
    const kbps = item.media?.[0]?.bitrate;
    return kbps && durS ? (kbps * 1000 * durS) / 8 : 0;
  }
  return durS ? ((QUALITY_KBPS[quality] + 160) * 1000 * durS) / 8 : 0;
}

const sizeOf = (r: LocalDownload) => (r.state === 'done' ? r.bytes : Math.max(r.total, estimateBytes(r.item, r.quality), r.bytes));
export const usedBytes = (records: LocalDownload[]) => records.reduce((n, r) => n + (r.state === 'error' ? 0 : sizeOf(r)), 0);

/**
 * Watched downloads to delete so `incoming` more bytes fit under `limitBytes`, oldest-watched first. Unwatched
 * downloads are never evicted; returns null when even deleting every watched download isn't enough.
 */
export function evictionFor(records: LocalDownload[], limitBytes: number | null, incoming: number, protect: Set<string> = new Set()): string[] | null {
  if (limitBytes == null) return [];
  let used = usedBytes(records);
  if (used + incoming <= limitBytes) return [];
  const watched = records
    .filter((r) => r.state === 'done' && r.watched && !protect.has(r.id))
    .sort((a, b) => (a.watchedAt ?? a.createdAt).localeCompare(b.watchedAt ?? b.createdAt));
  const out: string[] = [];
  for (const r of watched) {
    if (used + incoming <= limitBytes) break;
    out.push(r.id);
    used -= sizeOf(r);
  }
  return used + incoming <= limitBytes ? out : null;
}

/** Watched more than `hours` ago (no timestamp: due now). */
export function watchedDue(r: Pick<LocalDownload, 'watched' | 'watchedAt'>, hours: number | null, now: number): boolean {
  if (hours == null || !r.watched) return false;
  const at = r.watchedAt ? Date.parse(r.watchedAt) : NaN;
  return !Number.isFinite(at) || now - at >= hours * 3600_000;
}

/** Offline: downloads of a rule's show watched longer ago than the rule allows (the server plan does this online). */
export function localCleanup(records: LocalDownload[], rules: Pick<DownloadRule, 'showId' | 'deleteWatchedAfterHours'>[], now: number): string[] {
  const byShow = new Map(rules.map((r) => [r.showId, r.deleteWatchedAfterHours]));
  return records.filter((r) => r.state === 'done' && r.item.type === 'episode' && r.item.grandparentId && byShow.has(r.item.grandparentId) && watchedDue(r, byShow.get(r.item.grandparentId)!, now)).map((r) => r.id);
}

/** Server → device: watched state and resume position of downloads (local changes not yet synced win). */
export function mergeServerState(r: LocalDownload, s: DownloadedItemState): Partial<Pick<LocalDownload, 'watched' | 'watchedAt' | 'positionMs'>> | null {
  if (s.gone || r.pendingSync) return null;
  const patch: Partial<Pick<LocalDownload, 'watched' | 'watchedAt' | 'positionMs'>> = {};
  if (!!r.watched !== s.played) {
    patch.watched = s.played;
    patch.watchedAt = s.played ? s.lastPlayedAt : null;
  }
  if (!s.played && s.positionMs !== r.positionMs) patch.positionMs = s.positionMs;
  return Object.keys(patch).length ? patch : null;
}

export interface SmartActions {
  queue: { item: Item; ruleId: string; quality: DownloadQuality }[];
  remove: { id: string; reason: 'watched' | 'gone' | 'storage' }[];
  /** Why rule episodes are not being fetched right now (first reason found). */
  waitingFor: WaitingFor | null;
}

/** Turn the server's plan into actions for this device. */
export function smartActions(i: { records: LocalDownload[]; plan: DownloadPlan; settings: SmartSettings; cond: Conditions }): SmartActions {
  const have = new Map(i.records.map((r) => [r.id, r]));
  const remove: SmartActions['remove'] = i.plan.remove.filter((x) => have.has(x.itemId)).map((x) => ({ id: x.itemId, reason: x.reason }));
  const removed = new Set(remove.map((x) => x.id));
  let kept = i.records.filter((r) => !removed.has(r.id));
  const queue: SmartActions['queue'] = [];
  let waitingFor: WaitingFor | null = null;
  const limit = i.settings.storageLimitGb != null ? i.settings.storageLimitGb * 1024 ** 3 : null;
  const wanted = new Set(i.plan.want.flatMap((w) => w.items.map((x) => x.id)));
  for (const w of i.plan.want) {
    const rule = i.plan.rules.find((r) => r.id === w.ruleId);
    if (!rule) continue;
    for (const item of w.items) {
      if (have.has(item.id) || queue.some((q) => q.item.id === item.id)) continue;
      const ok = canTransfer(i.settings, i.cond, rule);
      if (!ok.ok) {
        waitingFor ??= ok.waitingFor;
        continue;
      }
      const size = estimateBytes(item, rule.quality);
      // Never evict what the rules still want.
      const evict = evictionFor(kept, limit, size, wanted);
      if (evict === null) {
        waitingFor ??= 'storage';
        continue;
      }
      for (const id of evict) remove.push({ id, reason: 'storage' });
      kept = kept.filter((r) => !evict.includes(r.id));
      kept.push({ id: item.id, state: 'queued', bytes: 0, total: size, createdAt: new Date(0).toISOString(), item, quality: rule.quality, positionMs: 0 });
      queue.push({ item, ruleId: rule.id, quality: rule.quality });
    }
  }
  return { queue, remove, waitingFor };
}

/** Add an offline change to the sync queue (one entry per item, the newest wins; watched state is kept). */
export function queueSync(queue: OfflineSyncEntry[], e: OfflineSyncEntry): OfflineSyncEntry[] {
  const prev = queue.find((q) => q.itemId === e.itemId);
  const merged: OfflineSyncEntry = prev ? { ...prev, ...e, played: e.played ?? (e.positionMs != null && e.positionMs > 0 ? undefined : prev.played) } : e;
  return [...queue.filter((q) => q.itemId !== e.itemId), merged].slice(-500);
}
