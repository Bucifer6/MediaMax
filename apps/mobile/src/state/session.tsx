/**
 * Session: saved servers, the active server + its branding, the signed-in
 * user, the typed API client and the realtime socket.
 */
import Constants from 'expo-constants';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { ApiError, MediaMaxClient, probeServer } from '@/api/client';
import { getDeviceInfo } from '@/api/device';
import { getJSON, secureGet, secureRemove, secureSet, setJSON } from '@/api/storage';
import type { AuthResponse, Branding, DeviceInfo, FeatureFlags, SystemInfo, User, UserPreferences } from '@/api/types';
import { RealtimeSocket } from '@/api/ws';
import { ALL_FEATURES } from '@/theme/defaults';
import { emit } from '@/utils/events';

export interface SavedServer {
  /** SystemInfo.id */
  id: string;
  name: string;
  url: string;
  addedAt: string;
  lastUsedAt: string;
  /** Last signed-in user, shown on the server list. */
  userName?: string | null;
  logoUrl?: string | null;
}

export type SessionStatus = 'booting' | 'no-server' | 'signed-out' | 'signed-in' | 'offline';

interface SessionValue {
  status: SessionStatus;
  device: DeviceInfo | null;
  servers: SavedServer[];
  server: SavedServer | null;
  info: SystemInfo | null;
  branding: Branding | null;
  user: User | null;
  /** Client for the active server (token may be null when signed out). */
  api: MediaMaxClient | null;
  features: FeatureFlags;
  lockServer: boolean;
  error: string | null;
  addServer: (input: string) => Promise<SavedServer>;
  selectServer: (id: string) => Promise<void>;
  removeServer: (id: string) => Promise<void>;
  completeLogin: (auth: AuthResponse) => Promise<void>;
  signOut: () => Promise<void>;
  /** Drop the token but keep the server: returns to the profile picker. */
  switchProfile: () => Promise<void>;
  refreshBranding: () => Promise<void>;
  refreshUser: () => Promise<void>;
  updatePreferences: (p: Partial<UserPreferences>) => Promise<void>;
  retry: () => Promise<void>;
  socket: RealtimeSocket | null;
}

const SessionContext = createContext<SessionValue | null>(null);

const SERVERS_KEY = 'mediamax.servers';
const LAST_SERVER_KEY = 'mediamax.lastServer';
const brandingKey = (id: string) => `mediamax.branding.${id}`;
const userKey = (id: string) => `mediamax.user.${id}`;
const tokenKey = (id: string) => `mediamax.token.${id}`;

const extra = (Constants.expoConfig?.extra ?? {}) as { defaultServerUrl?: string | null; lockServer?: boolean };

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<SessionStatus>('booting');
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [servers, setServers] = useState<SavedServer[]>([]);
  const [server, setServer] = useState<SavedServer | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [branding, setBranding] = useState<Branding | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [socket, setSocket] = useState<RealtimeSocket | null>(null);
  const serversRef = useRef<SavedServer[]>([]);
  serversRef.current = servers;
  const handleUnauthorizedRef = useRef<() => void>(() => undefined);

  const api = useMemo(() => {
    if (!server || !device) return null;
    return new MediaMaxClient({ baseUrl: server.url, token, device, onUnauthorized: () => handleUnauthorizedRef.current() });
  }, [server, device, token]);

  const persistServers = useCallback(async (list: SavedServer[]) => {
    setServers(list);
    await setJSON(SERVERS_KEY, list);
  }, []);

  /** Load a server: cached branding first (instant themed splash), then live data. */
  const activate = useCallback(
    async (srv: SavedServer, dev: DeviceInfo) => {
      setError(null);
      setServer(srv);
      await setJSON(LAST_SERVER_KEY, srv.id);
      const [cachedBranding, cachedUser, storedToken] = await Promise.all([
        getJSON<Branding | null>(brandingKey(srv.id), null),
        getJSON<User | null>(userKey(srv.id), null),
        secureGet(tokenKey(srv.id)),
      ]);
      if (cachedBranding) setBranding(cachedBranding);
      setToken(storedToken);
      const anon = new MediaMaxClient({ baseUrl: srv.url, token: storedToken, device: dev });
      try {
        const [sys, brand] = await Promise.all([anon.systemInfo(), anon.branding()]);
        setInfo(sys);
        setBranding(brand);
        void setJSON(brandingKey(srv.id), brand);
        if (!storedToken) {
          setUser(null);
          setStatus('signed-out');
          return;
        }
        try {
          const me = await anon.me();
          setUser(me);
          void setJSON(userKey(srv.id), me);
          setStatus('signed-in');
        } catch (e) {
          if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
            await secureRemove(tokenKey(srv.id));
            setToken(null);
            setUser(null);
            setStatus('signed-out');
          } else throw e;
        }
      } catch (e) {
        // Server unreachable: offline mode if we were signed in before (downloads still work).
        if (storedToken && cachedUser) {
          setUser(cachedUser);
          setStatus('offline');
        } else {
          setStatus('signed-out');
        }
        setError(e instanceof Error ? e.message : 'Server unreachable');
      }
    },
    [],
  );

  // Boot.
  useEffect(() => {
    let alive = true;
    (async () => {
      const dev = await getDeviceInfo();
      if (!alive) return;
      setDevice(dev);
      let list = await getJSON<SavedServer[]>(SERVERS_KEY, []);
      // White-label builds can bake in a server URL.
      if (!list.length && extra.defaultServerUrl) {
        try {
          const { baseUrl, info: sys } = await probeServer(extra.defaultServerUrl);
          const now = new Date().toISOString();
          list = [{ id: sys.id, name: sys.name, url: baseUrl, addedAt: now, lastUsedAt: now }];
          await setJSON(SERVERS_KEY, list);
        } catch {
          /* fall through to connect screen */
        }
      }
      setServers(list);
      const lastId = await getJSON<string | null>(LAST_SERVER_KEY, null);
      const srv = list.find((s) => s.id === lastId) ?? list[0];
      if (!srv) {
        setStatus('no-server');
        return;
      }
      await activate(srv, dev);
    })();
    return () => {
      alive = false;
    };
  }, [activate]);

  const refreshBranding = useCallback(async () => {
    if (!api || !server) return;
    try {
      const b = await api.branding();
      setBranding(b);
      void setJSON(brandingKey(server.id), b);
    } catch {
      /* keep the old branding */
    }
  }, [api, server]);

  const refreshUser = useCallback(async () => {
    if (!api?.token || !server) return;
    try {
      const me = await api.me();
      setUser(me);
      void setJSON(userKey(server.id), me);
    } catch {
      /* ignore */
    }
  }, [api, server]);

  const clearToken = useCallback(async () => {
    if (server) await secureRemove(tokenKey(server.id));
    setToken(null);
    setUser(null);
    setStatus((s) => (s === 'no-server' ? s : 'signed-out'));
  }, [server]);

  handleUnauthorizedRef.current = () => {
    if (status === 'signed-in') void clearToken();
  };

  // Realtime socket while signed in.
  useEffect(() => {
    if (status !== 'signed-in' || !api?.token) return;
    const url = api.wsUrl();
    if (!url) return;
    const ws = new RealtimeSocket(url);
    const unsub = ws.subscribe((evt) => {
      switch (evt.type) {
        case 'branding.updated':
          void refreshBranding();
          break;
        case 'userdata.updated':
          emit('userdata', { itemId: evt.itemId, userData: evt.userData });
          break;
        case 'recording.updated':
          emit('recording', evt.recording);
          break;
        case 'library.updated':
          emit('libraryUpdated', { libraryId: evt.libraryId });
          break;
        case 'session.terminated':
          emit('sessionTerminated', { sessionId: evt.sessionId, reason: evt.reason });
          break;
      }
    });
    ws.start();
    setSocket(ws);
    return () => {
      unsub();
      ws.stop();
      setSocket(null);
    };
  }, [status, api, refreshBranding]);

  // Refresh branding when returning to the foreground (cheap and catches missed WS events).
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') void refreshBranding();
    });
    return () => sub.remove();
  }, [refreshBranding]);

  const addServer = useCallback(
    async (input: string) => {
      const dev = device ?? (await getDeviceInfo());
      const { baseUrl, info: sys } = await probeServer(input);
      const now = new Date().toISOString();
      const existing = serversRef.current.find((s) => s.id === sys.id);
      const srv: SavedServer = existing
        ? { ...existing, url: baseUrl, name: sys.name, lastUsedAt: now }
        : { id: sys.id, name: sys.name, url: baseUrl, addedAt: now, lastUsedAt: now };
      await persistServers([srv, ...serversRef.current.filter((s) => s.id !== sys.id)]);
      setUser(null);
      setStatus('booting');
      await activate(srv, dev);
      return srv;
    },
    [device, activate, persistServers],
  );

  const selectServer = useCallback(
    async (id: string) => {
      const srv = serversRef.current.find((s) => s.id === id);
      if (!srv || !device) return;
      const updated = { ...srv, lastUsedAt: new Date().toISOString() };
      await persistServers(serversRef.current.map((s) => (s.id === id ? updated : s)));
      setUser(null);
      setInfo(null);
      setStatus('booting');
      await activate(updated, device);
    },
    [device, activate, persistServers],
  );

  const removeServer = useCallback(
    async (id: string) => {
      await secureRemove(tokenKey(id));
      const list = serversRef.current.filter((s) => s.id !== id);
      await persistServers(list);
      if (server?.id === id) {
        setServer(null);
        setBranding(null);
        setUser(null);
        setToken(null);
        if (list[0] && device) await activate(list[0], device);
        else setStatus('no-server');
      }
    },
    [server, device, activate, persistServers],
  );

  const completeLogin = useCallback(
    async (auth: AuthResponse) => {
      if (!server) return;
      await secureSet(tokenKey(server.id), auth.token);
      void setJSON(userKey(server.id), auth.user);
      setToken(auth.token);
      setUser(auth.user);
      await persistServers(
        serversRef.current.map((s) => (s.id === server.id ? { ...s, userName: auth.user.displayName, lastUsedAt: new Date().toISOString() } : s)),
      );
      setStatus('signed-in');
    },
    [server, persistServers],
  );

  const signOut = useCallback(async () => {
    try {
      await api?.logout();
    } catch {
      /* best effort */
    }
    await clearToken();
  }, [api, clearToken]);

  const switchProfile = signOut;

  const updatePreferences = useCallback(
    async (p: Partial<UserPreferences>) => {
      if (!api || !user) return;
      const optimistic: User = { ...user, preferences: { ...user.preferences, ...p } };
      setUser(optimistic);
      try {
        const updated = await api.updateMe({ preferences: p });
        setUser(updated);
        if (server) void setJSON(userKey(server.id), updated);
      } catch (e) {
        setUser(user);
        throw e;
      }
    },
    [api, user, server],
  );

  const retry = useCallback(async () => {
    if (server && device) {
      setStatus('booting');
      await activate(server, device);
    }
  }, [server, device, activate]);

  const features = useMemo<FeatureFlags>(() => ({ ...ALL_FEATURES, ...(branding?.features ?? info?.features ?? {}) }), [branding, info]);

  const value: SessionValue = {
    status,
    device,
    servers,
    server,
    info,
    branding,
    user,
    api,
    features,
    lockServer: !!extra.lockServer,
    error,
    addServer,
    selectServer,
    removeServer,
    completeLogin,
    signOut,
    switchProfile,
    refreshBranding,
    refreshUser,
    updatePreferences,
    retry,
    socket,
  };
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionValue {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession outside SessionProvider');
  return ctx;
}

/** The client for a signed-in screen. Throws if used before sign-in (guarded by the router). */
export function useApi(): MediaMaxClient {
  const { api } = useSession();
  if (!api) throw new Error('No active server');
  return api;
}

/** Effective permissions: server features AND the user's own allowances. */
export function useCapabilities() {
  const { features, user, status } = useSession();
  return useMemo(
    () => ({
      liveTv: features.liveTv && (user?.allowLiveTv ?? true),
      dvr: features.dvr && features.liveTv && (user?.allowDvr ?? false),
      music: features.music,
      photos: features.photos,
      downloads: features.downloads && (user?.allowDownloads ?? false),
      linkCodes: features.linkCodes,
      requests: !!features.requests && status === 'signed-in',
      syncPlay: features.syncPlay && status === 'signed-in',
      profilePicker: features.profilePicker,
      offline: status === 'offline',
    }),
    [features, user, status],
  );
}
