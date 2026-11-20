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
 */
import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import type { DownloadQuality, Item } from '@/api/types';
import { useSession } from './session';

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
}

interface DownloadsValue {
  supported: boolean;
  records: DownloadRecord[];
  get: (itemId: string) => DownloadRecord | undefined;
  /** Queue downloads. `quality` defaults to the user's default download quality. */
  download: (item: Item | Item[], quality?: DownloadQuality) => Promise<void>;
  cancel: (itemId: string) => void;
  remove: (itemId: string) => void;
  retry: (itemId: string) => void;
  updateLocalPosition: (itemId: string, positionMs: number) => void;
  totalBytes: number;
  defaultQuality: DownloadQuality;
  setDefaultQuality: (q: DownloadQuality) => void;
}

const KEY = 'mediamax.downloads';
const QUALITY_KEY = 'mediamax.downloads.quality';

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
  if (quality !== 'original') return item.type === 'track' ? 'm4a' : 'mp4';
  const c = containersOf(item)[0];
  if (c && /^[a-z0-9]{2,5}$/.test(c)) return c === 'matroska' ? 'mkv' : c;
  if (item.type === 'track') return 'mp3';
  return 'mp4';
}

function dirFor(serverId: string): Directory {
  const dir = new Directory(Paths.document, 'downloads', serverId);
  if (!dir.exists) dir.create({ intermediates: true, idempotent: true });
  return dir;
}

export function DownloadsProvider({ children }: { children: React.ReactNode }) {
  const { api, server, status } = useSession();
  const supported = !Platform.isTV && Platform.OS !== 'web';
  const [records, setRecords] = useState<DownloadRecord[]>([]);
  const [defaultQuality, setDefaultQualityState] = useState<DownloadQuality>('original');
  const recordsRef = useRef<DownloadRecord[]>([]);
  recordsRef.current = records;
  const tasks = useRef(new Map<string, DownloadTask>());
  const running = useRef(false);
  const loaded = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!supported) return;
    getJSON<DownloadRecord[]>(KEY, []).then((list) => {
      // Anything mid-flight when the app died goes back to the queue.
      setRecords(list.map((r) => (r.state === 'downloading' ? { ...r, state: 'queued' } : r)));
      loaded.current = true;
    });
    getJSON<DownloadQuality>(QUALITY_KEY, 'original').then((q) => setDefaultQualityState(DOWNLOAD_QUALITIES.some((x) => x.key === q) ? q : 'original'));
  }, [supported]);

  const setDefaultQuality = useCallback((q: DownloadQuality) => {
    setDefaultQualityState(q);
    void setJSON(QUALITY_KEY, q);
  }, []);

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

  // Sequential worker.
  const pump = useCallback(async () => {
    if (running.current || !api || !server) return;
    const nextRec = recordsRef.current.find((r) => r.state === 'queued' && r.serverId === server.id);
    if (!nextRec) return;
    running.current = true;
    const id = nextRec.id;
    try {
      update(id, { state: 'downloading', error: undefined });
      const dir = dirFor(server.id);
      const quality = nextRec.quality ?? 'original';
      const converted = isConverted(nextRec);
      const dest = new File(dir, `${id}.${extFor(nextRec.item, quality)}`);
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
      const task = File.createDownloadTask(api.downloadUrl(id, quality), dest, {
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
      tasks.current.set(id, task);
      const file = await task.downloadAsync();
      tasks.current.delete(id);
      if (!recordsRef.current.find((r) => r.id === id)) {
        // Removed while downloading.
        if (dest.exists) dest.delete();
      } else if (file) {
        update(id, { state: 'done', progress: 1, fileUri: file.uri, bytes: file.size, total: file.size });
      } else {
        update(id, { state: 'error', error: 'Cancelled' });
      }
    } catch (e) {
      tasks.current.delete(id);
      update(id, { state: 'error', error: e instanceof Error ? e.message : 'Download failed' });
    } finally {
      running.current = false;
      setTimeout(() => void pump(), 50);
    }
  }, [api, server, update]);

  useEffect(() => {
    if (status === 'signed-in' && records.some((r) => r.state === 'queued')) void pump();
  }, [records, status, pump]);

  // Sync offline progress when back online.
  useEffect(() => {
    if (status !== 'signed-in' || !api || !server) return;
    for (const r of recordsRef.current.filter((x) => x.pendingSync && x.serverId === server.id)) {
      api
        .itemProgress(r.id, { positionMs: r.positionMs, durationMs: r.item.durationMs ?? undefined, state: 'stopped' })
        .then(() => update(r.id, { pendingSync: false }))
        .catch(() => undefined);
    }
  }, [status, api, server, update]);

  const download = useCallback(
    async (input: Item | Item[], requested?: DownloadQuality) => {
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

  const deleteFiles = (r: DownloadRecord) => {
    for (const uri of [r.fileUri, r.posterUri, r.backdropUri]) {
      if (!uri) continue;
      try {
        const f = new File(uri);
        if (f.exists) f.delete();
      } catch {
        /* ignore */
      }
    }
  };

  const cancel = useCallback(
    (id: string) => {
      tasks.current.get(id)?.cancel();
      tasks.current.delete(id);
      update(id, { state: 'error', error: 'Cancelled' });
    },
    [update],
  );

  const remove = useCallback(
    (id: string) => {
      tasks.current.get(id)?.cancel();
      tasks.current.delete(id);
      setRecords((prev) => {
        const r = prev.find((x) => x.id === id);
        if (r) deleteFiles(r);
        const next = prev.filter((x) => x.id !== id);
        persist(next);
        return next;
      });
    },
    [persist],
  );

  const retry = useCallback((id: string) => update(id, (r) => ({ state: 'queued', error: undefined, progress: 0, bytes: 0, total: isConverted(r) ? 0 : r.total })), [update]);

  const updateLocalPosition = useCallback(
    (id: string, positionMs: number) => update(id, { positionMs, pendingSync: status !== 'signed-in' }),
    [update, status],
  );

  const value = useMemo<DownloadsValue>(
    () => ({
      supported,
      records: server ? records.filter((r) => r.serverId === server.id) : records,
      get: (id) => records.find((r) => r.id === id),
      download,
      cancel,
      remove,
      retry,
      updateLocalPosition,
      totalBytes: records.reduce((n, r) => n + (r.state === 'done' ? r.bytes : 0), 0),
      defaultQuality,
      setDefaultQuality,
    }),
    [supported, records, server, download, cancel, remove, retry, updateLocalPosition, defaultQuality, setDefaultQuality],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDownloads outside DownloadsProvider');
  return v;
}
