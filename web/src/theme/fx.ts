/**
 * Visual effects level ("lite mode") for the Lumen design.
 *
 * `html.lite` turns off the expensive layers: backdrop-filter blur (very slow on TV browsers), parallax, the drifting
 * ambient light, film grain, card tilt and edge masks. Everything still looks finished, just flatter.
 *
 * Lite turns itself on in TV mode and on low-end devices (≤ 4 logical cores, ≤ 2 GB device memory, or a measured
 * frame rate that can't keep up). Viewers can force it either way in Settings → Appearance ("mm.fx" in localStorage).
 * JS-driven motion (tilt, parallax, view transitions) checks `isCalm()`, which also honours prefers-reduced-motion.
 */

export type FxPref = 'auto' | 'full' | 'lite';
const KEY = 'mm.fx';
const EVENT = 'mm:fx';

export function getFxPref(): FxPref {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'full' || v === 'lite' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

export function setFxPref(p: FxPref) {
  try {
    if (p === 'auto') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
  } catch {
    /* storage blocked: applies for this page only */
  }
  apply();
  window.dispatchEvent(new CustomEvent(EVENT));
}

/** Why lite would be on in "auto" (for the settings hint), or null when the device looks capable. */
let slowFrames = false;
export function autoLiteReason(): string | null {
  const root = document.documentElement;
  if (root.classList.contains('tv')) return 'TV mode';
  const nav = navigator as Navigator & { deviceMemory?: number };
  if (nav.hardwareConcurrency && nav.hardwareConcurrency <= 4) return `${nav.hardwareConcurrency} processor cores`;
  if (nav.deviceMemory && nav.deviceMemory <= 2) return `${nav.deviceMemory} GB memory`;
  if (slowFrames) return 'slow frame rate';
  return null;
}

export const isLite = () => document.documentElement.classList.contains('lite');
/** True when movement should be kept to fades: lite mode or the OS asks for reduced motion. */
export const isCalm = () => isLite() || !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function apply() {
  const pref = getFxPref();
  const lite = pref === 'lite' || (pref === 'auto' && autoLiteReason() !== null);
  document.documentElement.classList.toggle('lite', lite);
}

/** Sample the frame rate for ~1.2 s once the page is idle; consistently long frames switch "auto" to lite. */
function measureFrames() {
  if (getFxPref() !== 'auto' || isLite() || typeof requestAnimationFrame !== 'function') return;
  const deltas: number[] = [];
  let last = 0;
  const tick = (t: number) => {
    if (document.visibilityState === 'hidden') return;
    if (last) deltas.push(t - last);
    last = t;
    if (deltas.length < 72) requestAnimationFrame(tick);
    else {
      deltas.sort((a, b) => a - b);
      const median = deltas[deltas.length >> 1];
      // Median frame over ~28 ms (< ~36 fps) while idle: the device will struggle with blur and parallax.
      if (median > 28) {
        slowFrames = true;
        apply();
        window.dispatchEvent(new CustomEvent(EVENT));
      }
    }
  };
  window.setTimeout(() => requestAnimationFrame(tick), 2500);
}

/** Call once at start-up, after TV detection. */
export function installFx() {
  apply();
  measureFrames();
}

export function onFxChange(fn: () => void): () => void {
  window.addEventListener(EVENT, fn);
  return () => window.removeEventListener(EVENT, fn);
}
