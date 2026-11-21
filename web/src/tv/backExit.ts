/**
 * "Press Back again to exit" on the TV home screen (web/src/tv/spatial.ts). The first Back on home shows a toast;
 * a second Back within EXIT_WINDOW_MS leaves the app through the platform's own exit.
 */

export const EXIT_WINDOW_MS = 2000;
export const EXIT_MESSAGE = 'Press Back again to exit';

/** Two-press confirmation. `press()` returns 'arm' for the first press (show the hint), 'exit' for a second in time. */
export function createBackToExit(now: () => number = () => Date.now(), windowMs = EXIT_WINDOW_MS) {
  let armedAt = Number.NEGATIVE_INFINITY;
  return {
    press(): 'arm' | 'exit' {
      const t = now();
      if (t - armedAt <= windowMs) {
        armedAt = Number.NEGATIVE_INFINITY;
        return 'exit';
      }
      armedAt = t;
      return 'arm';
    },
    reset() {
      armedAt = Number.NEGATIVE_INFINITY;
    },
  };
}

/** The app's root screen (Home), where Back has nowhere left to go inside the app. */
export function isHomeScreen(pathname: string, base = '/'): boolean {
  const b = base.endsWith('/') ? base : `${base}/`;
  return pathname === b || pathname === b.slice(0, -1) || pathname === `${b}index.html`;
}

interface ExitHost {
  tizen?: { application?: { getCurrentApplication?: () => { exit?: () => void } } };
  webOS?: { platformBack?: () => void };
  PalmSystem?: unknown;
  history: { length: number; back: () => void };
  close: () => void;
  navigator?: { userAgent?: string };
}

/**
 * Leave the app the way the platform expects:
 *   Samsung Tizen  → tizen.application.getCurrentApplication().exit()
 *   LG webOS       → webOS.platformBack() when webOSTV.js is present, else window.close() (closes a webOS web app)
 *   a browser      → back to the previous page if there is one (it may be outside Kinora), else window.close()
 *                    (which only works for windows a script opened; otherwise nothing happens)
 * The Android TV app is native and handles Back itself; Android TV / Fire TV browsers take the browser path.
 * Returns which way was used (for tests and logs).
 */
export function exitApp(w: ExitHost): 'tizen' | 'webos' | 'history' | 'close' {
  try {
    const app = w.tizen?.application?.getCurrentApplication?.();
    if (app?.exit) {
      app.exit();
      return 'tizen';
    }
  } catch {
    /* not Tizen, or no permission: fall through */
  }
  const ua = w.navigator?.userAgent ?? '';
  if (w.webOS?.platformBack) {
    w.webOS.platformBack();
    return 'webos';
  }
  if (w.PalmSystem || /Web0S|WebOS/i.test(ua)) {
    w.close();
    return 'webos';
  }
  if (w.history.length > 1) {
    w.history.back();
    return 'history';
  }
  w.close();
  return 'close';
}
