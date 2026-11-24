import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Library } from '@mediamax/shared';

/** Read / write a small JSON value in localStorage, tolerating blocked storage. */
function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}
function save(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage blocked */
  }
}

const COLLAPSED_KEY = 'vibe.sidebar.collapsed';

/** Sidebar collapsed to the 72 px icon rail (desktop). Remembered per device. */
export function useSidebarCollapsed(): [boolean, () => void] {
  const [collapsed, setCollapsed] = useState(() => load<boolean>(COLLAPSED_KEY, false));
  const toggle = useCallback(() => {
    setCollapsed((c) => {
      save(COLLAPSED_KEY, !c);
      return !c;
    });
  }, []);
  return [collapsed, toggle];
}

const GROUPS_KEY = 'vibe.sidebar.groups';

/** Open state of collapsible sidebar groups ("More"). Remembered per device. */
export function useSidebarGroups(): [Record<string, boolean>, (id: string) => void] {
  const [groups, setGroups] = useState<Record<string, boolean>>(() => load(GROUPS_KEY, { more: false }));
  const toggle = useCallback((id: string) => {
    setGroups((g) => {
      const next = { ...g, [id]: !g[id] };
      save(GROUPS_KEY, next);
      return next;
    });
  }, []);
  return [groups, toggle];
}

const orderKey = (userId: string) => `vibe.sidebar.libraryOrder.${userId}`;

/** Apply a saved id order: known ids first in that order, then the rest in server order. */
export function orderLibraries(libs: Library[], order: string[]): Library[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return libs
    .map((l, i) => ({ l, i, r: rank.get(l.id) }))
    .sort((a, b) => (a.r ?? Infinity) - (b.r ?? Infinity) || a.i - b.i)
    .map((x) => x.l);
}

/**
 * The viewer's own library order in the sidebar (Edit mode). Saved per user in localStorage for now; the shape (a list
 * of library ids) is ready to move into the profile's preferences.
 */
export function useLibraryOrder(userId: string | undefined, libs: Library[]): [Library[], (ids: string[]) => void, () => void] {
  const key = userId ? orderKey(userId) : null;
  const [order, setOrder] = useState<string[]>(() => (key ? load<string[]>(key, []) : []));
  useEffect(() => setOrder(key ? load<string[]>(key, []) : []), [key]);
  const ordered = useMemo(() => orderLibraries(libs, order), [libs, order]);
  const update = useCallback((ids: string[]) => {
    setOrder(ids);
    if (key) save(key, ids);
  }, [key]);
  const reset = useCallback(() => {
    setOrder([]);
    if (key) {
      try {
        localStorage.removeItem(key);
      } catch {
        /* storage blocked */
      }
    }
  }, [key]);
  return [ordered, update, reset];
}
