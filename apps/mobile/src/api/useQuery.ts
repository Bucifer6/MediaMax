/**
 * Minimal stale-while-revalidate data hook (no extra dependency).
 * Results are cached per server+user so navigating back is instant.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from '@/state/session';
import type { MediaMaxClient } from './client';

interface Entry {
  data: unknown;
  at: number;
}
const cache = new Map<string, Entry>();

export function invalidate(prefix: string) {
  for (const k of cache.keys()) if (k.includes(prefix)) cache.delete(k);
}

export interface QueryResult<T> {
  data: T | undefined;
  error: Error | null;
  loading: boolean;
  refreshing: boolean;
  refresh: () => Promise<void>;
  setData: (updater: (prev: T | undefined) => T | undefined) => void;
}

export function useQuery<T>(
  key: string | null,
  fn: (api: MediaMaxClient, signal: AbortSignal) => Promise<T>,
  opts: { staleMs?: number } = {},
): QueryResult<T> {
  const { api, server, user } = useSession();
  const fullKey = key && api ? `${server?.id}:${user?.id ?? 'anon'}:${key}` : null;
  const cached = fullKey ? (cache.get(fullKey) as Entry | undefined) : undefined;
  const [data, setDataState] = useState<T | undefined>(cached?.data as T | undefined);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(!cached);
  const [refreshing, setRefreshing] = useState(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const stale = opts.staleMs ?? 30000;
  // Every fetch takes a generation; only the latest one may write state. A pull-to-refresh that resolves after the
  // key changed (or after a newer fetch started) must not put old data into the new view.
  const genRef = useRef(0);
  const refreshCtrlRef = useRef<AbortController | null>(null);

  const run = useCallback(
    async (signal: AbortSignal, isRefresh: boolean) => {
      if (!fullKey || !api) return;
      const gen = ++genRef.current;
      const current = () => !signal.aborted && gen === genRef.current;
      if (isRefresh) setRefreshing(true);
      try {
        const result = await fnRef.current(api, signal);
        if (!current()) return;
        cache.set(fullKey, { data: result, at: Date.now() });
        setDataState(result);
        setError(null);
      } catch (e) {
        if (!current()) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (current()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fullKey, api],
  );

  useEffect(() => {
    // A new key (or unmount) supersedes whatever was in flight, refreshes included.
    genRef.current++;
    refreshCtrlRef.current?.abort();
    refreshCtrlRef.current = null;
    setRefreshing(false);
    if (!fullKey) {
      setLoading(false);
      return;
    }
    const entry = cache.get(fullKey);
    setDataState(entry?.data as T | undefined);
    setLoading(!entry);
    const ctrl = new AbortController();
    if (!entry || Date.now() - entry.at > stale) void run(ctrl.signal, false);
    return () => ctrl.abort();
  }, [fullKey, run, stale]);

  const refresh = useCallback(async () => {
    refreshCtrlRef.current?.abort();
    const ctrl = new AbortController();
    refreshCtrlRef.current = ctrl;
    await run(ctrl.signal, true);
    if (refreshCtrlRef.current === ctrl) refreshCtrlRef.current = null;
  }, [run]);

  const setData = useCallback(
    (updater: (prev: T | undefined) => T | undefined) => {
      setDataState((prev) => {
        const next = updater(prev);
        if (fullKey) cache.set(fullKey, { data: next, at: Date.now() });
        return next;
      });
    },
    [fullKey],
  );

  return { data, error, loading, refreshing, refresh, setData };
}
