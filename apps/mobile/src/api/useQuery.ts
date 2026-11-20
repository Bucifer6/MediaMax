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

  const run = useCallback(
    async (signal: AbortSignal, isRefresh: boolean) => {
      if (!fullKey || !api) return;
      if (isRefresh) setRefreshing(true);
      try {
        const result = await fnRef.current(api, signal);
        if (signal.aborted) return;
        cache.set(fullKey, { data: result, at: Date.now() });
        setDataState(result);
        setError(null);
      } catch (e) {
        if (signal.aborted) return;
        setError(e instanceof Error ? e : new Error(String(e)));
      } finally {
        if (!signal.aborted) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [fullKey, api],
  );

  useEffect(() => {
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
    const ctrl = new AbortController();
    await run(ctrl.signal, true);
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
