import type { Branding, Theme } from '@mediamax/shared';

/**
 * The service worker (web/sw/, built by web/sw/plugin.ts) only exists to show a branded "server offline" page on a
 * reload or fresh open while the server is unreachable, and to serve the hashed app files from cache.
 *
 * Registered in production builds in browsers and installed web apps. Not in the Samsung/LG wrapper apps: their own
 * start page already handles an unreachable server at launch, and service workers in the older TV web runtimes are
 * an unnecessary risk there (an existing registration is removed).
 */
export function isTvWrapper(ua = navigator.userAgent, w: object = window): boolean {
  return 'tizen' in w || 'webOS' in w || 'PalmSystem' in w || /Tizen|Web0S|WebOS|NetCast/i.test(ua);
}

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  const sw = navigator.serviceWorker;
  if (isTvWrapper()) {
    void sw.getRegistrations().then((rs) => rs.forEach((r) => void r.unregister())).catch(() => undefined);
    return;
  }
  const base = import.meta.env.BASE_URL;
  const register = () => {
    // updateViaCache 'none': the browser checks sw.js against the server on every load, so a new build is picked up
    // on the next visit (the server also sends sw.js with Cache-Control: no-cache).
    sw.register(`${base}sw.js`, { scope: base, updateViaCache: 'none' }).catch(() => undefined);
  };
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

export const OFFLINE_BRAND_KEY = 'mm.offlineBrand';

export interface OfflineBrand {
  name: string;
  logo: string | null;
  mode: 'dark' | 'light';
  colors: { bg: string; text: string; muted: string; accent: string; primary: string; primaryText: string };
}

/** What the offline page (web/sw/offline.js) needs to look like this server: name, logo URL and theme colours. */
export function offlineBrand(b: Branding, t: Theme): OfflineBrand {
  return {
    name: b.serverName || 'Kinora',
    logo: b.logoWideUrl ?? b.logoUrl ?? b.splash?.logoUrl ?? null,
    mode: t.mode === 'light' ? 'light' : 'dark',
    colors: { bg: t.colors.background, text: t.colors.text, muted: t.colors.textMuted, accent: t.colors.accent, primary: t.colors.primary, primaryText: t.colors.primaryText },
  };
}

export function rememberOfflineBrand(b: Branding, t: Theme) {
  try {
    const next = JSON.stringify(offlineBrand(b, t));
    if (localStorage.getItem(OFFLINE_BRAND_KEY) !== next) localStorage.setItem(OFFLINE_BRAND_KEY, next);
  } catch {
    /* storage blocked */
  }
}
