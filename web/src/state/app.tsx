import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AuthResponse, Branding, FeatureFlags, Library, SystemInfo, Theme, User } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { ApiRequestError, getToken, setToken } from '../api/client';
import { realtime } from '../api/ws';
import { DEFAULT_BRANDING, DEFAULT_FEATURES } from '../theme/defaults';
import { applyBrandingChrome, applyCustomCss, applyTheme, resolveTheme } from '../theme/applyTheme';

export type BootStatus = 'loading' | 'ready' | 'offline';

interface AppState {
  status: BootStatus;
  system: SystemInfo | null;
  branding: Branding;
  brandingError: boolean;
  features: FeatureFlags;
  user: User | null;
  libraries: Library[];
  theme: Theme;
  wsOpen: boolean;
  /** Temporary theme override (branding studio "preview on app"). */
  setPreviewTheme: (t: Theme | null) => void;
  setPreviewCss: (css: string | null) => void;
  login: (auth: AuthResponse) => void;
  logout: () => Promise<void>;
  setUser: (u: User) => void;
  setBranding: (b: Branding) => void;
  refreshBranding: () => Promise<void>;
  refreshLibraries: () => Promise<void>;
  refreshSystem: () => Promise<void>;
  retryBoot: () => void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<BootStatus>('loading');
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [branding, setBrandingState] = useState<Branding>(DEFAULT_BRANDING);
  const [brandingError, setBrandingError] = useState(false);
  const [user, setUserState] = useState<User | null>(null);
  const [libraries, setLibraries] = useState<Library[]>([]);
  const [previewTheme, setPreviewTheme] = useState<Theme | null>(null);
  const [previewCss, setPreviewCss] = useState<string | null>(null);
  const [wsOpen, setWsOpen] = useState(false);
  const [bootKey, setBootKey] = useState(0);
  const brandingRef = useRef(branding);
  brandingRef.current = branding;

  const setBranding = useCallback((b: Branding) => {
    setBrandingState({
      ...DEFAULT_BRANDING,
      ...b,
      features: { ...DEFAULT_FEATURES, ...(b.features ?? {}) },
      splash: { ...DEFAULT_BRANDING.splash, ...(b.splash ?? {}) },
      themes: b.themes?.length ? b.themes : DEFAULT_BRANDING.themes,
      homeRows: b.homeRows ?? [],
    });
  }, []);

  const refreshBranding = useCallback(async () => {
    try {
      setBranding(await api.branding.get());
      setBrandingError(false);
    } catch {
      setBrandingError(true);
    }
  }, [setBranding]);

  const refreshLibraries = useCallback(async () => {
    if (!getToken()) return;
    try {
      const libs = await api.libraries.list();
      setLibraries([...libs].sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)));
    } catch {
      /* keep previous */
    }
  }, []);

  const refreshSystem = useCallback(async () => {
    try {
      setSystem(await api.system.info());
    } catch {
      /* ignore */
    }
  }, []);

  // Boot sequence.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setStatus('loading');
      const [sys, brand] = await Promise.allSettled([api.system.info(), api.branding.get()]);
      if (cancelled) return;
      if (brand.status === 'fulfilled') {
        setBranding(brand.value);
        setBrandingError(false);
      } else setBrandingError(true);
      if (sys.status === 'rejected') {
        setStatus('offline');
        return;
      }
      setSystem(sys.value);
      if (getToken() && !sys.value.setupRequired) {
        try {
          const me = await api.auth.me();
          if (cancelled) return;
          setUserState(me);
        } catch (e) {
          if (e instanceof ApiRequestError && (e.status === 401 || e.status === 403)) setToken(null);
          else if (e instanceof ApiRequestError && e.status === 0) {
            setStatus('offline');
            return;
          }
        }
      }
      setStatus('ready');
    })();
    return () => {
      cancelled = true;
    };
  }, [bootKey, setBranding]);

  // Effective theme.
  const theme = useMemo(
    () => previewTheme ?? resolveTheme(branding, user?.preferences?.themeId),
    [previewTheme, branding, user?.preferences?.themeId],
  );
  useEffect(() => applyTheme(theme), [theme]);
  useEffect(() => applyCustomCss(previewCss ?? branding.customCss), [previewCss, branding.customCss]);
  useEffect(() => applyBrandingChrome(branding), [branding]);

  // Realtime connection while signed in.
  useEffect(() => {
    if (!user) {
      realtime.disconnect();
      return;
    }
    realtime.connect();
    const offStatus = realtime.onStatus(setWsOpen);
    const off = realtime.subscribe((ev) => {
      if (ev.type === 'branding.updated') {
        if (ev.revision !== brandingRef.current.revision) void refreshBranding();
      } else if (ev.type === 'library.updated' || (ev.type === 'library.scan' && ev.status === 'finished')) {
        void refreshLibraries();
      }
    });
    return () => {
      off();
      offStatus();
    };
  }, [user?.id, refreshBranding, refreshLibraries]);

  useEffect(() => {
    if (user) void refreshLibraries();
    else setLibraries([]);
  }, [user?.id, refreshLibraries]);

  // Global 401 handling.
  useEffect(() => {
    const h = () => {
      setToken(null);
      setUserState(null);
    };
    window.addEventListener('mm:unauthorized', h);
    return () => window.removeEventListener('mm:unauthorized', h);
  }, []);

  const login = useCallback((auth: AuthResponse) => {
    setToken(auth.token);
    setUserState(auth.user);
    setSystem((s) => (s ? { ...s, setupRequired: false } : s));
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.auth.logout();
    } catch {
      /* ignore */
    }
    setToken(null);
    realtime.disconnect();
    setUserState(null);
  }, []);

  const value: AppState = {
    status,
    system,
    branding,
    brandingError,
    features: brandingError ? { ...DEFAULT_FEATURES, ...(system?.features ?? {}) } : { ...DEFAULT_FEATURES, ...(branding.features ?? {}) },
    user,
    libraries,
    theme,
    wsOpen,
    setPreviewTheme,
    setPreviewCss,
    login,
    logout,
    setUser: setUserState,
    setBranding,
    refreshBranding,
    refreshLibraries,
    refreshSystem,
    retryBoot: () => setBootKey((k) => k + 1),
  };

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
