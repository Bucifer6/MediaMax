/**
 * Offline downloads (phones only, when the server enables downloads and the
 * user has `allowDownloads`). Files come from GET /stream/download/:itemId and
 * are stored under Documents/downloads/<serverId>/.
 */
import { Directory, File, Paths, type DownloadTask } from 'expo-file-system';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Platform } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import type { Item } from '@/api/types';
import { useSession } from './session';

export type DownloadState = 'queued' | 'downloading' | 'done' | 'error';

export interface DownloadRecord {
  id: string;
  serverId: string;
  item: Item;
  state: DownloadState;
  progress: number;
  bytes: number;
  total: number;
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
  download: (item: Item | Item[]) => Promise<void>;
  cancel: (itemId: string) => void;
  remove: (itemId: string) => void;
  retry: (itemId: string) => void;
  updateLocalPosition: (itemId: string, positionMs: number) => void;
  totalBytes: number;
}

const KEY = 'mediamax.downloads';
const Ctx = createContext<DownloadsValue | null>(null);

function extFor(item: Item): string {
  const c = item.media?.[0]?.container?.split(',')[0]?.trim().toLowerCase();
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
  }, [supported]);

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
      const dest = new File(dir, `${id}.${extFor(nextRec.item)}`);
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
      const task = File.createDownloadTask(api.downloadUrl(id), dest, {
        headers: api.headers(false),
        onProgress: ({ bytesWritten, totalBytes }) => {
          const now = Date.now();
          if (now - lastTick < 500) return;
          lastTick = now;
          update(id, { bytes: bytesWritten, total: totalBytes, progress: totalBytes > 0 ? bytesWritten / totalBytes : 0 });
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
    async (input: Item | Item[]) => {
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
        fresh.push({
          id: it.id,
          serverId: server.id,
          item: full,
          state: 'queued',
          progress: 0,
          bytes: 0,
          total: full.media?.[0]?.size ?? 0,
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
    [api, server, persist],
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

  const retry = useCallback((id: string) => update(id, { state: 'queued', error: undefined, progress: 0 }), [update]);

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
    }),
    [supported, records, server, download, cancel, remove, retry, updateLocalPosition],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDownloads(): DownloadsValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDownloads outside DownloadsProvider');
  return v;
}
