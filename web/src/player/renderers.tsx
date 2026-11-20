/**
 * "Play to" network renderers (DLNA/UPnP TVs, Sonos, Kodi): the device list, the renderer this
 * browser is remote-controlling, and its polled state. The server does the actual work; this is a
 * thin remote. State lives in a tiny module store so the cast menu (in the players) and the remote
 * bar (in the layout) share it.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { Renderer, RendererAction, RendererCommandRequest, RendererPlayRequest, RendererState } from '@mediamax/shared';
import { api } from '../api/endpoints';

interface Store {
  active: { id: string; name: string } | null;
  state: RendererState | null;
}

const KEY = 'mm.renderer';
function load(): Store['active'] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? 'null') as Store['active'];
    return v && typeof v.id === 'string' ? v : null;
  } catch {
    return null;
  }
}

let store: Store = { active: typeof window === 'undefined' ? null : load(), state: null };
const subs = new Set<() => void>();
function set(p: Partial<Store>) {
  store = { ...store, ...p };
  try {
    if ('active' in p) {
      if (store.active) sessionStorage.setItem(KEY, JSON.stringify(store.active));
      else sessionStorage.removeItem(KEY);
    }
  } catch {
    /* storage unavailable */
  }
  subs.forEach((f) => f());
}
const subscribe = (f: () => void) => {
  subs.add(f);
  return () => subs.delete(f);
};

export function useRendererRemote() {
  const s = useSyncExternalStore(subscribe, () => store);
  const start = useCallback(async (r: Pick<Renderer, 'id' | 'name'>, req: RendererPlayRequest) => {
    const st = await api.renderers.play(r.id, req);
    set({ active: { id: r.id, name: r.name }, state: st });
    return st;
  }, []);
  const command = useCallback(async (action: RendererAction, body?: RendererCommandRequest) => {
    const a = store.active;
    if (!a) return;
    const st = await api.renderers.command(a.id, action, body);
    set({ state: st });
  }, []);
  const dismiss = useCallback(() => set({ active: null, state: null }), []);
  return { active: s.active, state: s.state, start, command, dismiss };
}

/** Poll the active renderer: every 1.5 s while playing, slower when paused. */
export function useRendererPolling() {
  const { active, state } = useSyncExternalStore(subscribe, () => store);
  const playing = state?.state === 'playing' || state?.state === 'buffering';
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let fails = 0;
    const tick = async () => {
      try {
        const st = await api.renderers.state(active.id);
        if (!alive) return;
        fails = 0;
        set({ state: st });
      } catch {
        if (++fails >= 5 && alive) set({ active: null, state: null });
      }
    };
    void tick();
    const t = window.setInterval(tick, playing ? 1500 : 4000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [active, playing]);
}

/** The household's renderers (loaded when `enabled`; the server refreshes discovery in the background). */
export function useRenderers(enabled: boolean) {
  const [list, setList] = useState<Renderer[]>([]);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    let retry = 0;
    api.renderers.list().then((l) => {
      if (!alive) return;
      setList(l);
      // The first request starts a background search on the server: look again shortly.
      if (!l.length) retry = window.setTimeout(() => api.renderers.list().then((x) => alive && setList(x)).catch(() => undefined), 4500);
    }).catch(() => undefined);
    return () => {
      alive = false;
      window.clearTimeout(retry);
    };
  }, [enabled]);
  const search = useCallback(async () => {
    setLoading(true);
    try {
      setList(await api.renderers.discover());
    } catch {
      /* keep the old list */
    } finally {
      setLoading(false);
      setSearched(true);
    }
  }, []);
  return { renderers: list, loading, searched, search };
}

/* ------------------------------ AirPlay (Safari) ------------------------------ */

type AirPlayEl = HTMLMediaElement & { webkitShowPlaybackTargetPicker?: () => void; webkitCurrentPlaybackTargetIsWireless?: boolean };

/** Safari exposes AirPlay on media elements; available when a target is on the network. */
export function useAirPlay(getEl: () => HTMLMediaElement | null) {
  const [available, setAvailable] = useState(false);
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || !('WebKitPlaybackTargetAvailabilityEvent' in window)) return;
    const el = getEl() as AirPlayEl | null;
    if (!el) return;
    const onAvail = (e: Event) => setAvailable((e as Event & { availability?: string }).availability === 'available');
    const onChange = () => setActive(!!el.webkitCurrentPlaybackTargetIsWireless);
    el.addEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
    el.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', onChange);
    return () => {
      el.removeEventListener('webkitplaybacktargetavailabilitychanged', onAvail);
      el.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', onChange);
    };
  }, [getEl]);
  const show = useCallback(() => {
    const el = getEl() as AirPlayEl | null;
    el?.webkitShowPlaybackTargetPicker?.();
  }, [getEl]);
  return { available, active, show };
}

export const RENDERER_KIND_LABEL: Record<Renderer['kind'], string> = { dlna: 'DLNA', sonos: 'Sonos', kodi: 'Kodi' };
