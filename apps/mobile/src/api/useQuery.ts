/**
 * Minimal stale-while-revalidate data hook (no extra dependency).
 * Results are cached per server+user so navigating back is instant.
 */
import * as Network from 'expo-network';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useSession } from '@/state/session';
import { isNetworkError, type MediaMaxClient } from './client';

/** Waits between automatic retries after a network error (the last one repeats). */
const NETWORK_RECOVERY_DELAYS_MS = [3000, 10000, 30000];

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

  // A network error is usually temporary (the device was asleep, Wi-Fi is reconnecting): retry on our own
  // instead of leaving "Network error" on screen until someone presses Try again. Retries back off, and also
  // run as soon as the app returns to the foreground or the network comes back.
  const networkFailed = isNetworkError(error);
  useEffect(() => {
    if (!networkFailed || !fullKey) return;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let ctrl: AbortController | null = null;
    const retry = () => {
      if (timer) clearTimeout(timer);
      ctrl?.abort();
      ctrl = new AbortController();
      void run(ctrl.signal, false);
    };
    const schedule = () => {
      timer = setTimeout(() => {
        attempt++;
        retry();
        schedule();
      }, NETWORK_RECOVERY_DELAYS_MS[Math.min(attempt, NETWORK_RECOVERY_DELAYS_MS.length - 1)]);
    };
    schedule();
    const appSub = AppState.addEventListener('change', (s) => {
      if (s === 'active') retry();
    });
    let netSub: { remove(): void } | null = null;
    try {
      netSub = Network.addNetworkStateListener((n) => {
        if (n.isConnected) retry();
      });
    } catch {
      /* expo-network unavailable: the timer and foreground retries still run */
    }
    return () => {
      if (timer) clearTimeout(timer);
      ctrl?.abort();
      appSub.remove();
      netSub?.remove();
    };
  }, [networkFailed, fullKey, run]);

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
