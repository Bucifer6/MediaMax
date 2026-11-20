/**
 * Disk-friendly mode: keep NAS hard drives asleep when nobody uses MediaMax.
 *
 *  - Background media-disk work (scans, thumbnails, trickplay, intro detection, DJ analysis, subtitle matching,
 *    HDR probing) only starts inside the maintenance window, or "piggybacks" on a disk that is awake anyway
 *    (a stream started from it, a file changed on it, or — with disk-state checks — something else woke it).
 *  - Optional disk-state awareness: disks reported asleep by hdparm/smartctl are skipped by non-window work.
 *  - Everything MediaMax generates (artwork cache, thumbnails, trickplay, subtitles, DB) lives in the data dir.
 */
import type { DiskPowerState, StorageLibraryInfo, StorageSettings, StorageStatus } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { getKv, setKv } from '../settings.js';
import { bus } from '../events.js';
import { logger } from '../../util/log.js';
import { parseJson } from '../../util/misc.js';
import { inWindow, nextWindowStart, parseHm } from './window.js';
import { PiggybackQueue } from './piggyback.js';
import { combineStates, detectTools, diskKeyFor, diskState, findMount, isNetworkFs, isRotational, mounts, resolveDisks } from './mounts.js';
import type { PlaySession } from '../playback.js';

const log = logger('storage');

export type PathFilter = (mediaPath: string) => boolean;

export const DEFAULT_STORAGE: StorageSettings = {
  diskFriendly: false, windowStart: '02:00', windowEnd: '05:00', piggyback: true, checkDiskState: true, watchMode: 'native', pollIntervalMinutes: 360,
};

/** Scheduled tasks that read media files (and so spin disks up). Manual runs are never held back. */
export const DISK_TASKS = ['scan-libraries', 'episode-thumbnails', 'trickplay', 'detect-intros', 'dj-analysis', 'subtitles', 'hdr-formats'];
export const isDiskTask = (id: string) => DISK_TASKS.includes(id);

const KV = 'storage';
const QUEUE_KV = 'storage:deferred';

export function getStorageSettings(): StorageSettings {
  return { ...DEFAULT_STORAGE, ...getKv<Partial<StorageSettings>>(KV, {}) };
}

export function normaliseStorage(patch: Partial<StorageSettings> | undefined, cur = getStorageSettings()): StorageSettings {
  const n = { ...cur, ...(patch ?? {}) };
  return {
    diskFriendly: !!n.diskFriendly,
    windowStart: parseHm(n.windowStart) != null ? String(n.windowStart).trim().padStart(5, '0') : cur.windowStart,
    windowEnd: parseHm(n.windowEnd) != null ? String(n.windowEnd).trim().padStart(5, '0') : cur.windowEnd,
    piggyback: n.piggyback !== false,
    checkDiskState: n.checkDiskState !== false,
    watchMode: (['native', 'poll', 'off'] as const).includes(n.watchMode) ? n.watchMode : 'native',
    pollIntervalMinutes: Math.max(60, Math.min(7 * 24 * 60, Math.round(Number(n.pollIntervalMinutes) || 360))),
  };
}

export function saveStorageSettings(patch: Partial<StorageSettings>): StorageSettings {
  const next = normaliseStorage(patch);
  setKv(KV, next);
  bus.emit('storage.settings', next);
  return next;
}

/* ------------------------------ disks ------------------------------- */

interface PathDisk { key: string; disks: string[]; network: boolean; mountPoint: string | null; fsType: string | null; source: string | null }

const pathDiskCache = new Map<string, PathDisk>();

/** Which disk a path is on — from the mount table only, no access to the path itself. */
export function pathDisk(p: string): PathDisk {
  const hit = pathDiskCache.get(p);
  if (hit) return hit;
  const ms = mounts();
  const m = ms.length ? findMount(p, ms) : null;
  // Off Linux (no mount table) each library root is its own "disk".
  const root = m ? null : libraryRootFor(p);
  const res: PathDisk = {
    key: m ? diskKeyFor(m, p) : `path:${root ?? p}`,
    disks: m && !isNetworkFs(m.fsType) ? resolveDisks(m) : [],
    network: m ? isNetworkFs(m.fsType) : false,
    mountPoint: m?.mountPoint ?? null, fsType: m?.fsType ?? null, source: m?.source ?? null,
  };
  if (pathDiskCache.size > 5000) pathDiskCache.clear();
  pathDiskCache.set(p, res);
  return res;
}

export const diskKeyForPath = (p: string) => pathDisk(p).key;

function libraryRoots(): { id: string; name: string; type: string; paths: string[] }[] {
  return db.all("SELECT id, name, type, paths FROM libraries WHERE type NOT LIKE 'iptv-%' AND type != 'podcasts'")
    .map((l) => ({ id: l.id, name: l.name, type: l.type, paths: parseJson<string[]>(l.paths, []) }));
}

function libraryRootFor(p: string): string | null {
  let best: string | null = null;
  for (const l of libraryRoots()) for (const r of l.paths) if ((p === r || p.startsWith(r.replace(/[\\/]+$/, '') + '/') || p.startsWith(r.replace(/[\\/]+$/, '') + '\\')) && (!best || r.length > best.length)) best = r;
  return best;
}

/** Every disk key the libraries use. */
export function allDiskKeys(): string[] {
  return [...new Set(libraryRoots().flatMap((l) => l.paths.map((p) => diskKeyForPath(p))))];
}

/** Power state for a disk key (combined over RAID members). Never wakes anything. */
export async function stateForKey(key: string, maxAgeMs = 60000): Promise<DiskPowerState> {
  const sample = libraryRoots().flatMap((l) => l.paths).find((p) => diskKeyForPath(p) === key);
  if (!sample) return 'unknown';
  const pd = pathDisk(sample);
  if (pd.network || !pd.disks.length) return 'unknown';
  const states = await Promise.all(pd.disks.map((d) => diskState(d, { maxAgeMs, useTools: getStorageSettings().checkDiskState })));
  return combineStates(states.map((s) => s.state));
}

/* ------------------------------ policy ------------------------------ */

const queue = new PiggybackQueue();
let queueLoaded = false;
function q(): PiggybackQueue {
  if (!queueLoaded) {
    queueLoaded = true;
    queue.restore(getKv(QUEUE_KV, []));
  }
  return queue;
}
const persistQueue = () => setKv(QUEUE_KV, queue.snapshot());

export interface RunPlan { run: boolean; filter?: PathFilter; reason?: string; awakeKeys?: string[] }

/**
 * Pure decision for a due scheduled task. `states` maps disk key → power state (only consulted with checkDiskState
 * outside disk-friendly mode, where sleeping disks are skipped and remembered for piggybacking).
 */
export function decide(taskId: string, s: StorageSettings, now: Date, states: Map<string, DiskPowerState> | null): RunPlan {
  if (!isDiskTask(taskId)) return { run: true };
  if (s.diskFriendly) {
    if (!inWindow(now, s.windowStart, s.windowEnd)) return { run: false, reason: 'outside the maintenance window' };
    // In the window waking disks is the point; run everything.
    return { run: true };
  }
  if (s.checkDiskState && states && states.size) {
    const sleeping = [...states].filter(([, st]) => st === 'standby').map(([k]) => k);
    if (!sleeping.length) return { run: true };
    const awake = [...states.keys()].filter((k) => !sleeping.includes(k));
    if (!awake.length) return { run: false, reason: 'all library disks are asleep' };
    const skip = new Set(sleeping);
    return { run: true, filter: (p) => !skip.has(diskKeyForPath(p)), awakeKeys: awake, reason: `skipping ${sleeping.length} sleeping disk(s)` };
  }
  return { run: true };
}

const lastPlan = new Map<string, number>();

/** Called by the scheduler for every due task. Deferred tasks are remembered for piggybacking. */
export async function planScheduledRun(taskId: string): Promise<RunPlan> {
  if (!isDiskTask(taskId)) return { run: true };
  const s = getStorageSettings();
  // Re-evaluating a deferred task every minute is pointless (and would spawn hdparm each time).
  const prev = lastPlan.get(taskId);
  if (q().isDeferred(taskId) && prev && Date.now() - prev < (s.diskFriendly ? 60000 : 10 * 60000) && !(s.diskFriendly && inWindow(new Date(), s.windowStart, s.windowEnd))) return { run: false, reason: 'deferred' };
  lastPlan.set(taskId, Date.now());
  let states: Map<string, DiskPowerState> | null = null;
  if (!s.diskFriendly && s.checkDiskState && process.platform === 'linux') {
    states = new Map();
    for (const k of allDiskKeys()) states.set(k, await stateForKey(k, 5 * 60000));
  }
  const plan = decide(taskId, s, new Date(), states);
  if (!plan.run || plan.filter) {
    if (!q().isDeferred(taskId)) log.info(`Postponing "${taskId}": ${plan.reason}`);
    q().defer(taskId);
    persistQueue();
  }
  return plan;
}

/** The scheduler finished a task run: a full run clears it, a filtered run marks the awake disks done. */
export function taskRunFinished(taskId: string, plan?: RunPlan) {
  if (!isDiskTask(taskId) || !q().isDeferred(taskId)) return;
  if (plan?.filter && plan.awakeKeys) for (const k of plan.awakeKeys) q().markDone(taskId, k, allDiskKeys());
  else q().clear(taskId);
  persistQueue();
}

/* ----------------------------- piggyback ---------------------------- */

let piggybackRunning: string | null = null;
const piggybackWaiting = new Set<string>();

/** A disk is spinning anyway: run its share of every postponed task, one at a time. */
export async function piggyback(diskKey: string): Promise<number> {
  const s = getStorageSettings();
  if (!s.piggyback || !q().size) return 0;
  if (piggybackRunning) {
    if (piggybackRunning !== diskKey) piggybackWaiting.add(diskKey);
    return 0;
  }
  const pending = q().pendingFor(diskKey);
  if (!pending.length) return 0;
  piggybackRunning = diskKey;
  let ran = 0;
  try {
    const tasks = await import('../tasks.js');
    for (const id of pending) {
      if (tasks.isTaskRunning(id) || !tasks.taskSupportsDiskFilter(id)) continue;
      log.info(`Disk ${diskKey} is awake: running postponed "${id}" for it`);
      await tasks.runTask(id, (p: string) => diskKeyForPath(p) === diskKey);
      q().markDone(id, diskKey, allDiskKeys());
      persistQueue();
      ran++;
    }
  } catch (e) {
    log.warn(`Piggyback run failed: ${(e as Error).message}`);
  } finally {
    piggybackRunning = null;
  }
  const next = [...piggybackWaiting][0];
  if (next) {
    piggybackWaiting.delete(next);
    void piggyback(next);
  }
  return ran;
}

/** Hook: a path's disk is known to be awake (a stream or a file change). */
export function noteDiskAwake(p: string, delayMs = 60000) {
  if (!getStorageSettings().piggyback || !q().size) return;
  const key = diskKeyForPath(p);
  if (!q().pendingFor(key).length) return;
  // Let playback get going first; the disk stays spun up for its idle timeout anyway.
  setTimeout(() => void piggyback(key), delayMs).unref();
}

function onPlaybackStart(s: PlaySession) {
  if (!s.mediaId || s.preview) return;
  const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE id = ?', s.mediaId);
  if (m?.path) noteDiskAwake(m.path);
}

/** With disk-state checks: disks something else woke up (another app, a file copy) count as awake too. */
async function opportunisticCheck() {
  const s = getStorageSettings();
  if (!s.piggyback || !q().size || piggybackRunning || process.platform !== 'linux') return;
  for (const k of allDiskKeys()) {
    if (!q().pendingFor(k).length) continue;
    const st = await stateForKey(k, 4 * 60000);
    if (st === 'active') {
      const sample = libraryRoots().flatMap((l) => l.paths).find((p) => diskKeyForPath(p) === k);
      if (sample && isRotationalKey(sample)) {
        await piggyback(k);
        return;
      }
    }
  }
}

function isRotationalKey(p: string): boolean {
  const pd = pathDisk(p);
  return pd.disks.some((d) => isRotational(d) === true);
}

/* ------------------------------ status ------------------------------ */

const TASK_NAMES: Record<string, string> = {
  'scan-libraries': 'Scan all libraries', 'episode-thumbnails': 'Generate missing thumbnails', trickplay: 'Generate scrub previews',
  'detect-intros': 'Detect intros & credits', 'dj-analysis': 'Analyse music for DJ mode', subtitles: 'Download missing subtitles', 'hdr-formats': 'Detect HDR formats',
};

export async function storageStatus(watchInfo: (libId: string) => StorageLibraryInfo['watch']): Promise<StorageStatus> {
  const s = getStorageSettings();
  const now = new Date();
  const t = await detectTools();
  const libraries: StorageLibraryInfo[] = [];
  for (const l of libraryRoots()) {
    const paths = [];
    for (const p of l.paths) {
      const pd = pathDisk(p);
      const disks = [];
      for (const d of pd.disks) {
        const st = await diskState(d, { useTools: s.checkDiskState });
        disks.push({ name: d, state: st.state, method: st.method, rotational: isRotational(d), checkedAt: new Date(st.checkedAt).toISOString() });
      }
      paths.push({
        path: p, mountPoint: pd.mountPoint, fsType: pd.fsType, source: pd.source, network: pd.network, diskKey: pd.key, disks,
        state: pd.network ? 'unknown' as const : combineStates(disks.map((d) => d.state)),
      });
    }
    libraries.push({ id: l.id, name: l.name, type: l.type, paths, watch: watchInfo(l.id) });
  }
  return {
    settings: s,
    inWindow: s.diskFriendly ? inWindow(now, s.windowStart, s.windowEnd) : true,
    nextWindowAt: s.diskFriendly ? nextWindowStart(now, s.windowStart, s.windowEnd).toISOString() : null,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    serverTime: now.toISOString(),
    deferred: q().snapshot().map((e) => ({ taskId: e.taskId, name: TASK_NAMES[e.taskId] ?? e.taskId, since: new Date(e.since).toISOString(), doneDisks: e.doneDisks })),
    piggybackRunning,
    tools: { ...t, mountinfo: mounts().length > 0 },
    libraries,
    dataDir: config.dataDir,
    transcodeDir: config.transcodeDir,
    diskTasks: DISK_TASKS,
  };
}

let timer: NodeJS.Timeout | null = null;
let inited = false;

export function initStorage() {
  if (inited) return;
  inited = true;
  bus.on('playback.start', onPlaybackStart);
  timer = setInterval(() => void opportunisticCheck().catch(() => {}), 5 * 60000);
  timer.unref();
}

/** Test hook. */
export function _resetStorage() {
  queue.restore([]);
  queueLoaded = true;
  lastPlan.clear();
  pathDiskCache.clear();
  piggybackRunning = null;
}
export const _queue = () => q();
