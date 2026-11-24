/**
 * Offline downloads (phones only, when the server enables downloads and the
 * user has `allowDownloads`). Files come from GET /stream/download/:itemId and
 * are stored under Documents/downloads/<serverId>/.
 *
 * Quality: `original` is the untouched file; 1080p/720p/480p are converted by
 * the server on the fly (fragmented H.264/AAC MP4, or .m4a for audio) and have
 * no Content-Length, so their progress is shown as bytes downloaded only. On
 * iOS, originals in containers AVPlayer can't open (MKV, AVI, TS…) are fetched
 * as 1080p automatically so they play offline.
 *
 * Smart downloads (decisions in smartDownloads.ts): per-show rules stored on the
 * server ("keep the next N unwatched episodes", "delete watched after 24 h"),
 * Wi-Fi only / charging conditions, a storage limit with oldest-watched-first
 * eviction, pause / resume all, and offline progress + watched sync both ways.
 *
 * When it runs: while the app is open — on sign-in, when the app comes to the
 * foreground, when the network or charging state changes, and every 15 minutes.
 * There is no background task: iOS only grants background fetch opportunistically
 * (minutes to hours apart, never guaranteed), so a rule's new episodes arrive the
 * next time the app is opened on Wi-Fi. A transfer that has started keeps going
 * on iOS while the app is suspended (background URL session), but its completion
 * is only recorded when the app runs again.
 */
import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import type { DownloadQuality, DownloadRule, Item, OfflineSyncEntry, TrickplayInfo } from '@/api/types';
import { isAudioItem } from '@/utils/library';
import { getConditions, onConditionsChange } from '@/utils/connectivity';
import { useSession } from './session';
import {
  DEFAULT_SMART_SETTINGS,
  canTransfer,
  localCleanup,
  mergeServerState,
  queueSync,
  smartActions,
  type Conditions,
  type SmartSettings,
  type WaitingFor,
} from './smartDownloads';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error';

export const DOWNLOAD_QUALITIES: { key: DownloadQuality; label: string; description: string }[] = [
  { key: 'original', label: 'Original', description: 'The untouched file — best quality, largest size' },
  { key: '1080p', label: '1080p', description: 'Converted to H.264 · good for tablets and TVs' },
  { key: '720p', label: '720p', description: 'Converted to H.264 · good for phones' },
  { key: '480p', label: '480p', description: 'Converted to H.264 · smallest size' },
];

export const qualityLabel = (q: DownloadQuality | undefined) => DOWNLOAD_QUALITIES.find((x) => x.key === (q ?? 'original'))?.label ?? 'Original';

export interface DownloadRecord {
  id: string;
  serverId: string;
  item: Item;
  state: DownloadState;
  progress: number;
  bytes: number;
  /** 0 when unknown (converted downloads have no Content-Length). */
  total: number;
  /** Quality requested from the server; missing on records made before quality existed. */
  quality?: DownloadQuality;
  fileUri: string | null;
  posterUri: string | null;
  backdropUri: string | null;
  error?: string;
  createdAt: string;
  /** Offline resume position; synced to the server when back online. */
  positionMs: number;
  pendingSync?: boolean;
  /** Scrub-preview sprite sheets saved with the video (sheets are local file URIs). */
  trickplay?: TrickplayInfo | null;
  /** Watched (here or on another device, per the server) and when: drives auto-delete and storage eviction. */
  watched?: boolean;
  watchedAt?: string | null;
  /** Smart-download rule that fetched it. */
  ruleId?: string | null;
}

interface DownloadsValue {
  supported: boolean;
  records: DownloadRecord[];
  get: (itemId: string) => DownloadRecord | undefined;
  /** Queue downloads. `quality` defaults to the user's default download quality. */
  download: (item: Item | Item[], quality?: DownloadQuality, ruleId?: string | null) => Promise<void>;
  /** Every episode of a show (all seasons). */
  downloadShow: (showId: string, quality?: DownloadQuality) => Promise<void>;
  cancel: (itemId: string) => void;
  remove: (itemId: string) => void;
  retry: (itemId: string) => void;
  updateLocalPosition: (itemId: string, positionMs: number) => void;
  /** Mark a download watched / unwatched (works offline; synced later). */
  setWatched: (itemId: string, watched: boolean) => void;
  totalBytes: number;
  defaultQuality: DownloadQuality;
  setDefaultQuality: (q: DownloadQuality) => void;
  /* smart downloads */
  smart: SmartSettings;
  /** Change settings; Wi-Fi / charging / delete-after changes also apply to this device's show rules. */
  setSmart: (patch: Partial<SmartSettings>) => void;
  pauseAll: () => void;
  resumeAll: () => void;
  /** This device's show rules (cached for offline use). */
  rules: DownloadRule[];
  ruleFor: (showId: string) => DownloadRule | undefined;
  /** Keep the next `keepCount` unwatched episodes of a show; null removes the rule. */
  setRule: (show: Pick<Item, 'id'>, keepCount: number | null) => Promise<void>;
  /** Re-evaluate rules now (fetch plan, sync offline changes). */
  refreshSmart: () => Promise<void>;
  /** Why queued downloads are not moving, if they aren't. */
  waitingFor: WaitingFor | null;
  conditions: Conditions;
}

const KEY = 'mediamax.downloads';
const QUALITY_KEY = 'mediamax.downloads.quality';
const SMART_KEY = 'mediamax.downloads.smart';
const SYNC_KEY = 'mediamax.downloads.sync';
const RULES_KEY = (serverId: string) => `mediamax.downloads.rules.${serverId}`;
const SMART_INTERVAL_MS = 15 * 60 * 1000;

/** Containers AVPlayer can play from a local file. */
const IOS_PLAYABLE = new Set(['mp4', 'm4v', 'mov', 'm4a', 'mp3', 'aac']);

function containersOf(item: Item): string[] {
  return (item.media?.[0]?.container ?? '')
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
}

/** The quality actually requested for `item` on this platform. */
export function effectiveQuality(item: Item, requested: DownloadQuality): DownloadQuality {
  if (requested !== 'original' || Platform.OS !== 'ios') return requested;
  const cs = containersOf(item);
  if (!cs.length) return requested;
  return cs.some((c) => IOS_PLAYABLE.has(c)) ? requested : '1080p';
}

const isConverted = (r: Pick<DownloadRecord, 'quality'>) => !!r.quality && r.quality !== 'original';
const Ctx = createContext<DownloadsValue | null>(null);

function extFor(item: Item, quality: DownloadQuality = 'original'): string {
  if (quality !== 'original') return isAudioItem(item.type) ? 'm4a' : 'mp4';
  const c = containersOf(item)[0];
  if (c && /^[a-z0-9]{2,5}$/.test(c)) return c === 'matroska' ? 'mkv' : c;
  if (isAudioItem(item.type)) return 'mp3';
  return 'mp4';
}

function dirFor(serverId: string): Directory {
  const dir = new Directory(Paths.document, 'downloads', serverId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

/** Where a record's media is written while it transfers (fileUri is only set once it completes). */
const transferFile = (r: Pick<DownloadRecord, 'id' | 'serverId' | 'item' | 'quality'>) => new File(dirFor(r.serverId), `${r.id}.${extFor(r.item, r.quality ?? 'original')}`);

const deleteQuietly = (f: File) => {
  try {
    if (f.exists) f.delete();
  } catch {
    /* ignore */
  }
};

const deleteFiles = (r: DownloadRecord) => {
  // A cancelled or failed transfer leaves a partial file at its destination.
  if (!r.fileUri) deleteQuietly(transferFile(r));
  for (const uri of [r.fileUri, r.posterUri, r.backdropUri, ...(r.trickplay?.sheets ?? [])]) {
    if (!uri) continue;
    try {
      const f = new File(uri);
      if (f.exists) f.delete();
    } catch {
      /* ignore */
    }
  }
};

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const { api, server, status } = useSession();
  const supported = !Platform.isTV && Platform.OS !== 'web';
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [defaultQuality, setDefaultQualityState] = useState<DownloadQuality>('original');
  const [smart, setSmartState] = useState<SmartSettings>(DEFAULT_SMART_SETTINGS);
  const [rules, setRules] = useState<DownloadRule[]>([]);
  const [conditions, setConditions] = useState<Conditions>({ online: true, wifi: false, charging: false });
  const [smartWaiting, setSmartWaiting] = useState<WaitingFor | null>(null);
  const recordsRef = useRef<DownloadRecord[]>([]);
  recordsRef.current = records;
  const smartRef = useRef(smart);
  smartRef.current = smart;
  const rulesRef = useRef(rules);
  rulesRef.current = rules;
  const condRef = useRef(conditions);
  condRef.current = conditions;
  const syncQueue = useRef<OfflineSyncEntry[]>([]);
  const tasks = useRef(new Map<string, DownloadTask>());
  /** Transfers paused mid-way (pause all, Wi-Fi lost): resumed where they stopped. */
  const pausedTasks = useRef(new Map<string, DownloadTask>());
  const running = useRef<string | null>(null);
  const [ready, setReady] = useState(false);
  const flushTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const smartBusy = useRef(false);

  useEffect(() => {
    if (!supported) return;
    getJSON<DownloadRecord[]>(KEY, []).then((list) => {
      // Anything mid-flight when the app died goes back to the queue.
      setRecords(list.map((r) => (r.state === 'downloading' ? { ...r, state: 'queued' } : r)));
      setReady(true);
    });
    getJSON<DownloadQuality>(QUALITY_KEY, 'original').then((q) => setDefaultQualityState(DOWNLOAD_QUALITIES.some((x) => x.key === q) ? q : 'original'));
    getJSON<Partial<SmartSettings>>(SMART_KEY, {}).then((s) => setSmartState({ ...DEFAULT_SMART_SETTINGS, ...s }));
    getJSON<OfflineSyncEntry[]>(SYNC_KEY, []).then((q) => {
      syncQueue.current = [...q, ...syncQueue.current];
    });
    void getConditions().then(setConditions);
    return onConditionsChange(() => void getConditions().then(setConditions));
  }, [supported]);

  useEffect(() => {
    if (supported && server) getJSON<DownloadRule[]>(RULES_KEY(server.id), []).then((r) => rulesRef.current.length || setRules(r));
  }, [supported, server]);

  const setDefaultQuality = useCallback((q: DownloadQuality) => {
    setDefaultQualityState(q);
    void setJSON(QUALITY_KEY, q);
  }, []);

  const setSmart = useCallback((patch: Partial<SmartSettings>) => {
    setSmartState((prev) => {
      const next = { ...prev, ...patch };
      void setJSON(SMART_KEY, next);
      return next;
    });
    // Rule conditions follow the device settings.
    if (api && (patch.wifiOnly !== undefined || patch.chargingOnly !== undefined || patch.deleteWatchedAfterHours !== undefined)) {
      const rulePatch = {
        ...(patch.wifiOnly !== undefined ? { wifiOnly: patch.wifiOnly } : {}),
        ...(patch.chargingOnly !== undefined ? { chargingOnly: patch.chargingOnly } : {}),
        ...(patch.deleteWatchedAfterHours !== undefined ? { deleteWatchedAfterHours: patch.deleteWatchedAfterHours } : {}),
      };
      void Promise.all(rulesRef.current.map((r) => api.putDownloadRule(r.showId, { keepCount: r.keepCount, deleteWatchedAfterHours: r.deleteWatchedAfterHours, wifiOnly: r.wifiOnly, chargingOnly: r.chargingOnly, quality: r.quality, ...rulePatch })))
        .then((updated) => setRules((prev) => prev.map((r) => updated.find((u) => u.id === r.id) ?? r)))
        .catch(() => undefined);
    }
  }, [api]);

  const persist = useCallback((list: DownloadRecord[]) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void setJSON(KEY, list), 400);
  }, []);

  const update = useCallback(
    (id: string, patch: Partial<DownloadRecord> | ((r: DownloadRecord) => Partial<DownloadRecord>)) => {
      setRecords((prev) => {
        const next = prev.map((r) => (r.id === id ? { ...r, ...(typeof patch === 'function' ? patch(r) : patch) } : r));
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const pushSync = useCallback((e: OfflineSyncEntry) => {
    syncQueue.current = queueSync(syncQueue.current, e);
    void setJSON(SYNC_KEY, syncQueue.current);
  }, []);

  const ruleOf = (r: Pick<DownloadRecord, 'ruleId'>) => (r.ruleId ? rulesRef.current.find((x) => x.id === r.ruleId) : undefined);

  // Sequential worker.
  const pump = useCallback(async () => {
    if (running.current || !api || !server) return;
    // First queued download allowed to transfer now (global Wi-Fi only / pause, its rule's own conditions).
    const nextRec = recordsRef.current.find((r) => r.state === 'queued' && r.serverId === server.id && canTransfer(smartRef.current, condRef.current, ruleOf(r)).ok);
    if (!nextRec) return;
    const id = nextRec.id;
    running.current = id;
    try {
      update(id, { state: 'downloading', error: undefined });
      const dir = dirFor(server.id);
      const quality = nextRec.quality ?? 'original';
      const converted = isConverted(nextRec);
      const dest = transferFile(nextRec);
      let task = pausedTasks.current.get(id);
      pausedTasks.current.delete(id);
      if (!task) {
        if (dest.exists) dest.delete();
        // Artwork for offline browsing.
        const art = async (path: string | null, name: string) => {
          if (!path) return null;
          try {
            const f = new File(dir, name);
            if (f.exists) f.delete();
            const out = await File.downloadFileAsync(api.image(path, 600)!, f);
            return out.uri;
          } catch {
            return null;
          }
        };
        const [posterUri, backdropUri] = await Promise.all([
          art(nextRec.item.posterUrl ?? nextRec.item.thumbUrl, `${id}.poster.jpg`),
          art(nextRec.item.backdropUrl ?? nextRec.item.thumbUrl, `${id}.backdrop.jpg`),
        ]);
        update(id, { posterUri, backdropUri });
        let lastTick = 0;
        task = File.createDownloadTask(api.downloadUrl(id, quality), dest, {
          headers: api.headers(false),
          onProgress: ({ bytesWritten, totalBytes }) => {
            const now = Date.now();
            if (now - lastTick < 500) return;
            lastTick = now;
            // Converted downloads are streamed without Content-Length: bytes only.
            const total = !converted && totalBytes > 0 ? totalBytes : 0;
            update(id, { bytes: bytesWritten, total, progress: total > 0 ? bytesWritten / total : 0 });
          },
        });
      }
      const resuming = task.state === 'paused';
      tasks.current.set(id, task);
      const file = resuming ? await task.resumeAsync() : await task.downloadAsync();
      tasks.current.delete(id);
      if (!recordsRef.current.find((r) => r.id === id)) {
        // Removed while downloading.
        if (dest.exists) dest.delete();
      } else if (file) {
        update(id, { state: 'done', progress: 1, fileUri: file.uri, bytes: file.size, total: file.size });
        // Trickplay sheets (a few MB) so seek previews work offline too. Optional: failures are ignored.
        if (nextRec.item.type === 'movie' || nextRec.item.type === 'episode' || nextRec.item.type === 'video') {
          try {
            const tp = await api.trickplay(id);
            if (tp?.sheets?.length && tp.count > 0) {
              const sheets: string[] = [];
              for (let i = 0; i < tp.sheets.length; i++) {
                const f = new File(dir, `${id}.tp${i}.jpg`);
                if (f.exists) f.delete();
                sheets.push((await File.downloadFileAsync(api.absolute(tp.sheets[i]), f)).uri);
              }
              if (recordsRef.current.find((r) => r.id === id)) update(id, { trickplay: { ...tp, sheets } });
              else for (const u of sheets) new File(u).delete();
            }
          } catch {
            /* no previews offline */
          }
        }
      } else if (task.state === 'paused') {
        // Paused (pause all / Wi-Fi lost): back in the queue, resumed from where it stopped.
        pausedTasks.current.set(id, task);
        update(id, { state: 'queued' });
      } else {
        update(id, { state: 'error', error: 'Cancelled' });
      }
    } catch (e) {
      tasks.current.delete(id);
      // Cancelling makes the transfer reject; if the record was removed meanwhile, drop its partial file.
      if (!recordsRef.current.find((r) => r.id === id)) deleteQuietly(transferFile(nextRec));
      else update(id, { state: 'error', error: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      running.current = null;
      setTimeout(() => void pump(), 50);
    }
  }, [api, server, update]);

  useEffect(() => {
    if (status === 'signed-in' && records.some((r) => r.state === 'queued')) void pump();
  }, [records, status, pump, smart, conditions]);

  // Pause the running transfer when the user pauses everything or its conditions stop holding (Wi-Fi lost …).
  useEffect(() => {
    const id = running.current;
    if (!id) return;
    const rec = recordsRef.current.find((r) => r.id === id);
    if (rec && !canTransfer(smart, conditions, ruleOf(rec)).ok) void tasks.current.get(id)?.pauseAsync().catch(() => undefined);
  }, [smart, conditions]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = useCallback(
    async (input: Item | Item[], requested?: DownloadQuality, ruleId: string | null = null) => {
      if (!api || !server) return;
      const list = Array.isArray(input) ? input : [input];
      const fresh: DownloadRecord[] = [];
      for (const it of list) {
        if (recordsRef.current.some((r) => r.id === it.id && r.state !== 'error')) continue;
        let full = it;
        if (!it.media) {
          try {
            full = await api.item(it.id);
          } catch {
            /* use what we have */
          }
        }
        const quality = effectiveQuality(full, requested ?? defaultQuality);
        fresh.push({
          id: it.id,
          serverId: server.id,
          item: full,
          state: 'queued',
          quality,
          progress: 0,
          bytes: 0,
          total: quality === 'original' ? full.media?.[0]?.size ?? 0 : 0,
          fileUri: null,
          posterUri: null,
          backdropUri: null,
          createdAt: new Date().toISOString(),
          positionMs: full.userData?.positionMs ?? 0,
          watched: !!full.userData?.played,
          watchedAt: full.userData?.played ? full.userData.lastPlayedAt ?? null : null,
          ruleId,
        });
      }
      if (!fresh.length) return;
      setRecords((prev) => {
        const next = [...prev.filter((r) => !fresh.some((f) => f.id === r.id)), ...fresh];
        persist(next);
        return next;
      });
    },
    [api, server, persist, defaultQuality],
  );

  const downloadShow = useCallback(
    async (showId: string, quality?: DownloadQuality) => {
      if (!api) return;
      const eps = (await api.items({ ancestorId: showId, type: 'episode', limit: 2000 })).items;
      eps.sort((a, b) => (a.parentIndex ?? 0) - (b.parentIndex ?? 0) || (a.index ?? 0) - (b.index ?? 0));
      await download(eps, quality);
    },
    [api, download],
  );

  const removeMany = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      for (const id of ids) {
        tasks.current.get(id)?.cancel();
        tasks.current.delete(id);
        pausedTasks.current.get(id)?.cancel();
        pausedTasks.current.delete(id);
      }
      setRecords((prev) => {
        for (const r of prev) if (ids.includes(r.id)) deleteFiles(r);
        const next = prev.filter((x) => !ids.includes(x.id));
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const cancel = useCallback(
    (id: string) => {
      tasks.current.get(id)?.cancel();
      tasks.current.delete(id);
      pausedTasks.current.get(id)?.cancel();
      pausedTasks.current.delete(id);
      update(id, { state: 'error', error: 'Cancelled' });
    },
    [update],
  );

  const remove = useCallback((id: string) => removeMany([id]), [removeMany]);

  const retry = useCallback((id: string) => update(id, (r) => ({ state: 'queued', error: undefined, progress: 0, bytes: 0, total: isConverted(r) ? 0 : r.total })), [update]);

  /* ----------------------------- sync & smart ----------------------------- */

  /** Send queued offline changes; the server answers with its state for those items (newest change wins). */
  const flushSync = useCallback(async () => {
    if (!api || !server) return;
    // Records from before the sync queue existed.
    for (const r of recordsRef.current) if (r.pendingSync && r.serverId === server.id && !syncQueue.current.some((q) => q.itemId === r.id)) pushSync({ itemId: r.id, positionMs: r.positionMs, durationMs: r.item.durationMs ?? undefined, at: new Date().toISOString() });
    const mine = new Set(recordsRef.current.filter((r) => r.serverId === server.id).map((r) => r.id));
    const batch = syncQueue.current.filter((q) => mine.has(q.itemId));
    if (!batch.length) return;
    const res = await api.offlineSync(batch);
    const done = new Set([...res.applied, ...res.skipped]);
    syncQueue.current = syncQueue.current.filter((q) => !done.has(q.itemId) || !batch.includes(q));
    void setJSON(SYNC_KEY, syncQueue.current);
    for (const s of res.state) {
      update(s.itemId, (r) => ({ pendingSync: false, ...(mergeServerState({ ...r, pendingSync: false }, s) ?? {}) }));
    }
  }, [api, server, pushSync, update]);

  const refreshSmart = useCallback(async () => {
    if (!supported || !server || smartBusy.current) return;
    smartBusy.current = true;
    try {
      const mine = recordsRef.current.filter((r) => r.serverId === server.id);
      if (status !== 'signed-in' || !api) {
        // Offline: apply the watched-cleanup rule locally with the cached rules.
        removeMany(localCleanup(mine, rulesRef.current, Date.now()));
        return;
      }
      await flushSync().catch(() => undefined);
      const plan = await api.downloadPlan(mine.map((r) => r.id));
      setRules(plan.rules);
      void setJSON(RULES_KEY(server.id), plan.rules);
      for (const s of plan.have) {
        const r = recordsRef.current.find((x) => x.id === s.itemId);
        const patch = r ? mergeServerState(r, s) : null;
        if (patch) update(s.itemId, patch);
      }
      const cond = await getConditions();
      setConditions(cond);
      const actions = smartActions({ records: recordsRef.current.filter((r) => r.serverId === server.id), plan, settings: smartRef.current, cond });
      removeMany(actions.remove.map((x) => x.id));
      for (const q of actions.queue) await download(q.item, q.quality, q.ruleId);
      setSmartWaiting(actions.waitingFor);
    } catch {
      /* offline or server error: try again on the next trigger */
    } finally {
      smartBusy.current = false;
    }
  }, [supported, server, status, api, flushSync, removeMany, update, download]);

  // Triggers: sign-in, network / charging changes, back to the foreground, every 15 minutes.
  useEffect(() => {
    if (!supported || !ready) return;
    void refreshSmart();
  }, [supported, ready, status, conditions.online, conditions.wifi, conditions.charging, refreshSmart]);
  useEffect(() => {
    if (!supported) return;
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') {
        void getConditions().then(setConditions);
        void refreshSmart();
      }
    });
    const t = setInterval(() => void refreshSmart(), SMART_INTERVAL_MS);
    return () => {
      sub.remove();
      clearInterval(t);
    };
  }, [supported, refreshSmart]);

  const updateLocalPosition = useCallback(
    (id: string, positionMs: number) => {
      const r = recordsRef.current.find((x) => x.id === id);
      const dur = r?.item.durationMs ?? 0;
      const finished = dur > 0 && positionMs / dur >= 0.9;
      const at = new Date().toISOString();
      update(id, (prev) => ({ positionMs, pendingSync: true, ...(finished && !prev.watched ? { watched: true, watchedAt: at } : {}) }));
      pushSync({ itemId: id, positionMs, durationMs: dur || undefined, at });
      // Online: send it soon (progress ticks are coalesced).
      if (status === 'signed-in' && !flushTimer.current) {
        flushTimer.current = setTimeout(() => {
          flushTimer.current = null;
          void flushSync().catch(() => undefined);
        }, finished ? 0 : 10000);
      }
    },
    [update, pushSync, flushSync, status],
  );

  const setWatched = useCallback(
    (id: string, watched: boolean) => {
      const at = new Date().toISOString();
      update(id, { watched, watchedAt: watched ? at : null, pendingSync: true, ...(watched ? {} : { positionMs: 0 }) });
      pushSync({ itemId: id, played: watched, at });
      if (status === 'signed-in') void flushSync().catch(() => undefined);
    },
    [update, pushSync, flushSync, status],
  );

  const setRule = useCallback(
    async (show: Pick<Item, 'id'>, keepCount: number | null) => {
      if (!api) return;
      const existing = rulesRef.current.find((r) => r.showId === show.id);
      if (keepCount == null) {
        if (existing) await api.deleteDownloadRule(existing.id);
      } else {
        const s = smartRef.current;
        await api.putDownloadRule(show.id, { keepCount, deleteWatchedAfterHours: existing?.deleteWatchedAfterHours ?? s.deleteWatchedAfterHours, wifiOnly: s.wifiOnly, chargingOnly: s.chargingOnly, quality: defaultQuality });
      }
      await refreshSmart();
    },
    [api, defaultQuality, refreshSmart],
  );

  const pauseAll = useCallback(() => setSmart({ paused: true }), [setSmart]);
  const resumeAll = useCallback(() => setSmart({ paused: false }), [setSmart]);

  const value = useMemo<DownloadsValue>(() => {
    const visible = server ? records.filter((r) => r.serverId === server.id) : records;
    const queued = visible.filter((r) => r.state === 'queued');
    const blocked = queued.length && !queued.some((r) => canTransfer(smart, conditions, rules.find((x) => x.id === r.ruleId)).ok);
    const reason = blocked ? (canTransfer(smart, conditions, rules.find((x) => x.id === queued[0].ruleId)) as { waitingFor?: WaitingFor }).waitingFor ?? null : null;
    return {
      supported,
      records: visible,
      get: (id) => records.find((r) => r.id === id),
      download,
      downloadShow,
      cancel,
      remove,
      retry,
      updateLocalPosition,
      setWatched,
      totalBytes: records.reduce((n, r) => n + (r.state === 'done' ? r.bytes : 0), 0),
      defaultQuality,
      setDefaultQuality,
      smart,
      setSmart,
      pauseAll,
      resumeAll,
      rules,
      ruleFor: (showId) => rules.find((r) => r.showId === showId),
      setRule,
      refreshSmart,
      waitingFor: reason ?? smartWaiting,
      conditions,
    };
  }, [supported, records, server, download, downloadShow, cancel, remove, retry, updateLocalPosition, setWatched, defaultQuality, setDefaultQuality, smart, setSmart, pauseAll, resumeAll, rules, setRule, refreshSmart, smartWaiting, conditions]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDownloads outside DownloadsProvider');
  return v;
}
