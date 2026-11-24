/**
 * Ambient light: the interface is lit by the artwork on screen.
 *
 * `paletteFor(url)` samples a tiny (80 px) copy of an image on a canvas and returns its three most characterful
 * colours. Results are cached in memory and in localStorage (bounded), so a title is sampled once per browser.
 * Images are same-origin (/api/v1/images/…); anything else (a remote URL, a tainted canvas) just has no palette.
 *
 * `setAmbient(palette)` lights the page: <AmbientLight/> (components/AmbientLight.tsx) cross-fades to the new colours.
 * Colours are clamped against the active theme so text keeps WCAG AA contrast over the light (see `fitToTheme`).
 */
import { useEffect, useSyncExternalStore } from 'react';

export type Rgb = [number, number, number];
export type Palette = [Rgb, Rgb, Rgb];

const STORE_KEY = 'mm.palettes.v1';
const MAX_STORED = 240;
const mem = new Map<string, Palette | null>();
const inflight = new Map<string, Promise<Palette | null>>();

let stored: Record<string, Palette> | null = null;
function storedPalettes(): Record<string, Palette> {
  if (stored) return stored;
  try {
    stored = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') as Record<string, Palette>;
  } catch {
    stored = {};
  }
  return stored;
}
let saveTimer = 0;
function remember(key: string, p: Palette) {
  const s = storedPalettes();
  delete s[key];
  s[key] = p;
  const keys = Object.keys(s);
  for (let i = 0; i < keys.length - MAX_STORED; i++) delete s[keys[i]];
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(s));
    } catch {
      /* quota / blocked */
    }
  }, 800);
}

/* ------------------------------ colour maths ------------------------------ */

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
export const luminance = ([r, g, b]: Rgb) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
export const contrast = (a: Rgb, b: Rgb) => {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
export const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
export const hex = (c: Rgb) => '#' + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
export function parseColor(s: string): Rgb | null {
  const m = s.trim().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (!m) return null;
  const h = m[1].length === 3 ? m[1].split('').map((x) => x + x).join('') : m[1];
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function hsl([r, g, b]: Rgb): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}

/** Pick three distinct, characterful colours from raw RGBA pixels (24×24 sample). Exported for tests. */
export function extractPalette(data: Uint8ClampedArray | number[]): Palette | null {
  // 4-bit-per-channel histogram, weighted towards saturated mid-tones (the colours a viewer remembers).
  const bins = new Map<number, { w: number; r: number; g: number; b: number }>();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 128) continue;
    const c: Rgb = [data[i], data[i + 1], data[i + 2]];
    const [, s, l] = hsl(c);
    const w = 0.15 + s * s * 2 + (l > 0.12 && l < 0.85 ? 0.6 : 0) - Math.abs(l - 0.5) * 0.5;
    if (w <= 0) continue;
    const key = ((c[0] >> 4) << 8) | ((c[1] >> 4) << 4) | (c[2] >> 4);
    const bin = bins.get(key) ?? { w: 0, r: 0, g: 0, b: 0 };
    bin.w += w;
    bin.r += c[0] * w;
    bin.g += c[1] * w;
    bin.b += c[2] * w;
    bins.set(key, bin);
  }
  const ranked = [...bins.values()].sort((a, b) => b.w - a.w).map((b) => [b.r / b.w, b.g / b.w, b.b / b.w] as Rgb);
  if (!ranked.length) return null;
  const picked: Rgb[] = [];
  const dist = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  for (const min of [90, 55, 25]) {
    for (const c of ranked) {
      if (picked.length >= 3) break;
      if (picked.every((p) => dist(p, c) > min)) picked.push(c);
    }
    if (picked.length >= 3) break;
  }
  while (picked.length < 3) picked.push(mix(picked[picked.length - 1], [0, 0, 0], 0.35));
  return [picked[0], picked[1], picked[2]];
}

function sample(src: string): Promise<Palette | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      try {
        const c = document.createElement('canvas');
        c.width = 24;
        c.height = 24;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        if (!ctx) return resolve(null);
        ctx.drawImage(img, 0, 0, 24, 24);
        resolve(extractPalette(ctx.getImageData(0, 0, 24, 24).data));
      } catch {
        resolve(null); // tainted canvas (cross-origin artwork)
      }
    };
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Palette of an image (cached). Only same-origin API images are sampled. */
export function paletteFor(url: string | null | undefined): Promise<Palette | null> {
  if (!url || !url.startsWith('/api/')) return Promise.resolve(null);
  const key = url.split('?')[0];
  if (mem.has(key)) return Promise.resolve(mem.get(key)!);
  const s = storedPalettes()[key];
  if (s) {
    mem.set(key, s);
    return Promise.resolve(s);
  }
  let p = inflight.get(key);
  if (!p) {
    p = sample(`${key}?w=80`).then((pal) => {
      mem.set(key, pal);
      if (pal) remember(key, pal.map((c) => c.map(Math.round)) as Palette);
      inflight.delete(key);
      return pal;
    });
    inflight.set(key, p);
  }
  return p;
}

/** Palette already known for an image, without sampling. */
export const cachedPalette = (url: string | null | undefined): Palette | null => {
  if (!url) return null;
  const key = url.split('?')[0];
  return mem.get(key) ?? storedPalettes()[key] ?? null;
};

/* ------------------------------ theme fitting ------------------------------ */

export interface ThemeTone { mode: 'dark' | 'light'; bg: Rgb; text: Rgb; muted: Rgb }

/**
 * Fit artwork colours to the theme so the light never costs readability: in a dark theme each colour is darkened
 * until the theme's *muted* text still has ≥ 4.5:1 on it (so body text has far more); in a light theme it is
 * lightened until the same holds. The light is drawn as gradients from these colours to transparent over the theme
 * background, so every pixel is a blend of colours that already pass. Exported for tests.
 */
export function fitToTheme(p: Palette, tone: ThemeTone): Palette {
  const target = 4.55;
  return p.map((c) => {
    // Keep some of the theme's own background in it, so a red film doesn't turn a blue theme magenta.
    let out = mix(c, tone.bg, tone.mode === 'dark' ? 0.15 : 0.5);
    for (let i = 0; i < 24 && contrast(out, tone.muted) < target; i++) out = mix(out, tone.mode === 'dark' ? tone.bg : [255, 255, 255], 0.18);
    if (contrast(out, tone.muted) < target) out = tone.bg;
    return out;
  }) as Palette;
}

/** A button colour from the artwork plus its readable label colour (≥ 4.5:1), or null when nothing works. */
export function tintFrom(p: Palette): { bg: Rgb; fg: Rgb } | null {
  // Most vivid first: chroma (max − min channel), so a deep navy doesn't beat a bright magenta on "saturation".
  const chroma = (c: Rgb) => Math.max(...c) - Math.min(...c);
  const ranked = [...p].sort((a, b) => chroma(b) - chroma(a));
  for (const c0 of ranked) {
    if (chroma(c0) < 70) continue;
    for (const fg of [[255, 255, 255], [8, 10, 16]] as Rgb[]) {
      let c = c0;
      for (let i = 0; i < 12 && contrast(c, fg) < 4.6; i++) c = mix(c, fg[0] > 128 ? [0, 0, 0] : [255, 255, 255], 0.12);
      if (contrast(c, fg) >= 4.6 && hsl(c)[1] > 0.12) return { bg: c, fg };
    }
  }
  return null;
}

/* ------------------------------ ambient store ------------------------------ */

type Listener = () => void;
let current: { palette: Palette | null; key: number } = { palette: null, key: 0 };
const listeners = new Set<Listener>();

export const getAmbient = () => current.palette;

export function setAmbient(palette: Palette | null) {
  if (palette === current.palette) return;
  current = { palette, key: current.key + 1 };
  for (const l of listeners) l();
}

export function useAmbientState() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}

/**
 * Light the page from an image. The light stays after unmount: Layout resets it on every route change (in a layout
 * effect, before pages' effects run), so a page without artwork falls back to the theme's own light.
 */
export function useAmbientFrom(url: string | null | undefined) {
  useEffect(() => {
    let alive = true;
    const known = cachedPalette(url);
    if (known) setAmbient(known);
    else
      void paletteFor(url).then((p) => {
        if (alive && p) setAmbient(p);
      });
    return () => {
      alive = false;
    };
  }, [url]);
}
