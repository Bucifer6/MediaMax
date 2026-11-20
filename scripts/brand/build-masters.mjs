#!/usr/bin/env node
/**
 * Build the MediaMax master SVGs in branding/mediamax/ from the mark geometry (scripts/brand/mark.mjs)
 * and the outlined Plus Jakarta Sans glyphs (branding/mediamax/source/glyphs.json).
 *
 *   node scripts/brand/build-masters.mjs     (then: node scripts/brand-export.mjs)
 *
 * Every shipped SVG is plain paths: no <text>, no fonts, no scripts, no external references.
 * Also writes web/src/brand/art.ts (inline SVG fragments used by the web app's logo components).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, CENTER, COLORS, G, centered, markFull, markMono, markSimple, keyPoints } from './mark.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OUT = path.join(repo, 'branding/mediamax');
const glyphs = JSON.parse(fs.readFileSync(path.join(OUT, 'source/glyphs.json'), 'utf8'));
const f = (n) => +(+n).toFixed(2);

// ---- palette ----------------------------------------------------------------------------------
export const PALETTE = {
  ground: COLORS.ground, // dark background
  groundLight: '#F5F7FF',
  ink: COLORS.ink, // "Media" on light backgrounds
  white: '#FFFFFF',
  maxDark: ['#00F5E9', '#04BDF2', '#2362FA'], // "Max" on dark
  maxLight: ['#0891B2', '#1D6FE8', '#2362FA'], // "Max" on light: deeper start so it reads on white (>= 3:1)
  taglineDark: '#B9C3E6',
  taglineLight: '#48537A',
};

// ---- type -------------------------------------------------------------------------------------
/** Lay out `text` in weight `w` at `size` px with `tracking` (em). Returns glyph placements + metrics. */
function typeset(text, w, size, tracking = 0) {
  const g = glyphs.weights[w];
  const k = size / 1000;
  let x = 0;
  const items = [];
  [...text].forEach((c, i) => {
    const gl = g.glyphs[c];
    if (i > 0) x += (g.kern[text[i - 1] + c] ?? 0) * k + tracking * size;
    items.push({ c, x, d: gl.d });
    x += gl.adv * k;
  });
  return { items, width: x, k, cap: g.capHeight * k, size };
}
/** Transform absolute M/L/Q/C/Z path data: x' = x * k + tx, y' = y * k + ty. */
export function transformPath(d, k, tx, ty) {
  const toks = d.match(/[MLQCZ]|-?\d*\.?\d+(?:e-?\d+)?/gi);
  let out = '';
  let pair = 0;
  for (const t of toks) {
    if (/^[MLQCZ]$/i.test(t)) {
      if (t !== t.toUpperCase()) throw new Error('relative path commands are not supported');
      out += t;
      pair = 0;
    } else {
      const v = pair % 2 === 0 ? +t * k + tx : +t * k + ty;
      out += (pair % 2 === 1 ? ' ' : out.endsWith('Z') || /[A-Z]$/.test(out) ? '' : ' ') + f(v);
      pair++;
    }
  }
  return out;
}
/** SVG for a typeset run with its baseline-left at (x, y). `fill` may be a colour or a function of index. */
function run(t, x, y, fill) {
  return t.items
    .filter((it) => it.d)
    .map((it, i) => `<path d="${transformPath(it.d, t.k, x + it.x, y)}" fill="${typeof fill === 'function' ? fill(i, it) : fill}"/>`)
    .join('');
}

// ---- helpers ----------------------------------------------------------------------------------
const svg = (w, h, inner, { title = 'MediaMax', vb } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="${vb ?? `0 0 ${f(w)} ${f(h)}`}" role="img" aria-label="${title}"><title>${title}</title>${inner}</svg>\n`;
const grad = (id, x1, y1, x2, y2, stops) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">${stops.map((c, i) => `<stop offset="${f(i / (stops.length - 1))}" stop-color="${c}"/>`).join('')}</linearGradient>`;

/** Place the mark (512-grid fragment) so its bounding box's top-left lands at (x, y) with height h. */
function placeMark(frag, x, y, h) {
  const s = h / BBOX.h;
  return { defs: frag.defs, body: `<g transform="translate(${f(x)} ${f(y)}) scale(${f(s * 10000) / 10000}) translate(${-BBOX.x} ${-BBOX.y})">${frag.body}</g>`, w: BBOX.w * s };
}

/**
 * The name "MediaMax" set at `size`, baseline-left at (x, y). Variant: dark | light | mono:<colour>.
 * Returns { defs, body, width }.
 */
function name(x, y, size, variant, id) {
  const t = typeset('MediaMax', 800, size, -0.012);
  const maxStart = t.items[5].x;
  if (variant.startsWith('mono:')) {
    const c = variant.slice(5);
    return { defs: '', body: run(t, x, y, c), width: t.width, cap: t.cap };
  }
  const media = variant === 'dark' ? PALETTE.white : PALETTE.ink;
  const stops = variant === 'dark' ? PALETTE.maxDark : PALETTE.maxLight;
  const defs = grad(`${id}-max`, x + maxStart, y - t.cap, x + t.width, y, stops);
  return { defs, body: run(t, x, y, (i) => (i < 5 ? media : `url(#${id}-max)`)), width: t.width, cap: t.cap };
}

/** Tagline justified to `width` (tracking solved so the ink spans exactly that width). */
function tagline(x, y, width, size, color) {
  const text = 'STREAM WITHOUT LIMITS.';
  const base = typeset(text, 700, size, 0);
  const n = text.length - 1;
  const tracking = (width - base.width) / n / size;
  const t = typeset(text, 700, size, tracking);
  return { body: run(t, x, y, color), cap: t.cap, tracking };
}

// ---- masters ----------------------------------------------------------------------------------
const files = {};
const put = (name, content) => (files[name] = content);

// Marks (tight viewBox around the bounding box with 4% padding)
{
  const p = Math.round(BBOX.h * 0.04);
  const vb = `${f(BBOX.x - p)} ${f(BBOX.y - p)} ${f(BBOX.w + 2 * p)} ${f(BBOX.h + 2 * p)}`;
  const W = BBOX.w + 2 * p;
  const H = BBOX.h + 2 * p;
  const m = markFull('mm');
  put('mark.svg', svg(W, H, `<defs>${m.defs}</defs>${m.body}`, { vb }));
  const s = markSimple('mms');
  put('mark-simple.svg', svg(W, H, `<defs>${s.defs}</defs>${s.body}`, { vb }));
  for (const [nm, c] of [['black', '#000000'], ['white', '#FFFFFF']]) {
    const mm = markMono(c);
    put(`mark-mono-${nm}.svg`, svg(W, H, `<defs>${mm.defs}</defs>${mm.body}`, { vb }));
  }
}

// Horizontal wordmark (mark + name), optional tagline
function horizontal(variant, withTagline) {
  const id = `wm${variant[0]}${withTagline ? 't' : ''}`;
  const markH = 200;
  const pad = 24;
  const mark =
    variant.startsWith('mono:') ? placeMark(markMono(variant.slice(5)), pad, pad, markH) : placeMark(markFull(id + 'm'), pad, pad, markH);
  const size = 128;
  const x = pad + mark.w + markH * 0.2;
  const probe = typeset('MediaMax', 800, size, -0.012);
  const cy = pad + markH / 2;
  let baseline;
  let tag = { body: '' };
  if (withTagline) {
    const tagSize = 27;
    const gapT = size * 0.26;
    const tagCap = (glyphs.weights[700].capHeight * tagSize) / 1000;
    const block = probe.cap + gapT + tagCap;
    baseline = cy - block / 2 + probe.cap;
    tag = tagline(x + 4, baseline + gapT + tagCap, probe.width - 8, tagSize, variant === 'dark' ? PALETTE.taglineDark : variant === 'light' ? PALETTE.taglineLight : variant.slice(5));
  } else {
    baseline = cy + probe.cap / 2;
  }
  const nm = name(x, baseline, size, variant, id);
  const W = x + nm.width + pad;
  const H = markH + 2 * pad;
  return svg(W, H, `<defs>${mark.defs}${nm.defs}</defs>${mark.body}${nm.body}${tag.body}`);
}
put('wordmark-dark.svg', horizontal('dark', false));
put('wordmark-light.svg', horizontal('light', false));
put('wordmark-tagline-dark.svg', horizontal('dark', true));
put('wordmark-tagline-light.svg', horizontal('light', true));
put('wordmark-mono-black.svg', horizontal('mono:#000000', false));
put('wordmark-mono-white.svg', horizontal('mono:#FFFFFF', false));

// Name only (no mark), for places that show the mark separately
function nameOnly(variant) {
  const size = 128;
  const t = typeset('MediaMax', 800, size, -0.012);
  const pad = 4;
  const nm = name(pad, pad + t.cap + 2, size, variant, `n${variant[0]}`);
  // descender-free text: the box is cap height (+ small overshoot)
  return svg(nm.width + 2 * pad, t.cap + 2 * pad + 6, `<defs>${nm.defs}</defs>${nm.body}`);
}
put('name-dark.svg', nameOnly('dark'));
put('name-light.svg', nameOnly('light'));

// Stacked lockup: mark over name over tagline
function stacked(variant, { width = 1000, height = 900, bg = null, markH = 300 } = {}) {
  const id = `st${variant[0]}`;
  const size = 132;
  const probe = typeset('MediaMax', 800, size, -0.012);
  const tagSize = 28;
  const tagCap = (glyphs.weights[700].capHeight * tagSize) / 1000;
  const gap1 = markH * 0.24;
  const gap2 = size * 0.3;
  const block = markH + gap1 + probe.cap + gap2 + tagCap;
  const top = (height - block) / 2;
  const mono = variant.startsWith('mono:');
  const markW = (BBOX.w * markH) / BBOX.h;
  // centre the mark optically (same nudge as the square icons)
  const mark = placeMark(mono ? markMono(variant.slice(5)) : markFull(id + 'm'), width / 2 - markW / 2 + (CENTER.dx + (BBOX.x + BBOX.w / 2) - 256) * (markH / BBOX.h), top, markH);
  const x = (width - probe.width) / 2;
  const baseline = top + markH + gap1 + probe.cap;
  const nm = name(x, baseline, size, variant, id);
  const tagColor = variant === 'dark' ? PALETTE.taglineDark : variant === 'light' ? PALETTE.taglineLight : variant.slice(5);
  const tag = tagline(x + 4, baseline + gap2 + tagCap, probe.width - 8, tagSize, tagColor);
  const bgRect = bg ? `<rect width="${width}" height="${height}" fill="${bg}"/>` : '';
  return svg(width, height, `<defs>${mark.defs}${nm.defs}</defs>${bgRect}${mark.body}${nm.body}${tag.body}`);
}
put('lockup-stacked-dark.svg', stacked('dark'));
put('lockup-stacked-light.svg', stacked('light'));
put('lockup-stacked-mono-black.svg', stacked('mono:#000000'));
put('lockup-stacked-mono-white.svg', stacked('mono:#FFFFFF'));

// Backgrounds
const bgDark = (id, w, h) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(w * 0.5)}" cy="${f(h * 0.32)}" r="${f(Math.max(w, h) * 0.75)}"><stop offset="0" stop-color="#151D45"/><stop offset="1" stop-color="${PALETTE.ground}"/></radialGradient>`;
const bgLight = (id, w, h) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(w * 0.5)}" cy="${f(h * 0.32)}" r="${f(Math.max(w, h) * 0.75)}"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E9EEFF"/></radialGradient>`;

// App icons: 1024 square, opaque, mark ~68% of the width, optically centred
const APP_SCALE = 0.855;
for (const [nm, bg] of [['dark', bgDark], ['light', bgLight]]) {
  const m = centered(markFull('ai'), APP_SCALE);
  put(`app-icon-${nm}.svg`, svg(1024, 1024, `<defs>${bg('aibg', 512, 512)}${m.defs}</defs><rect width="512" height="512" fill="url(#aibg)"/>${m.body}`, { vb: '0 0 512 512' }));
}

// Android adaptive icon: 108 dp canvas; everything must sit in the 66 dp safe circle.
// Scale the mark so its farthest point from the centre is 96% of the safe radius.
function safeScale() {
  const pts = keyPoints().map(([x, y]) => [x + CENTER.dx, y + CENTER.dy]);
  // vertices only: rounded corners keep the real ink a little further inside
  const maxR = Math.max(...pts.map(([x, y]) => Math.hypot(x - 256, y - 256)));
  const safeR = (256 * 66) / 108;
  return (0.99 * safeR) / maxR;
}
const ADAPTIVE = safeScale();
{
  const m = centered(markFull('af'), ADAPTIVE);
  put('android-foreground.svg', svg(1024, 1024, `<defs>${m.defs}</defs>${m.body}`, { vb: '0 0 512 512' }));
  const mm = centered(markMono('#FFFFFF'), ADAPTIVE);
  put('android-monochrome.svg', svg(1024, 1024, `<defs>${mm.defs}</defs>${mm.body}`, { vb: '0 0 512 512' }));
  put('android-background.svg', svg(1024, 1024, `<defs>${bgDark('abg', 512, 512)}</defs><rect width="512" height="512" fill="url(#abg)"/>`, { vb: '0 0 512 512' }));
  // Notification small icon: white silhouette on transparent, no crease cuts (too fine at 24 dp)
  const nmk = centered(markMono('#FFFFFF', { creases: false }), 0.98);
  put('notification-icon.svg', svg(96, 96, nmk.body, { vb: '0 0 512 512' }));
}

// Favicon: simplified mark on the dark rounded square (reads on light and dark tab strips)
{
  const s = centered(markSimple('fv'), 0.9);
  put('favicon.svg', svg(32, 32, `<defs>${s.defs}</defs><rect width="512" height="512" rx="112" fill="${PALETTE.ground}"/>${s.body}`, { vb: '0 0 512 512' }));
  // Maskable PWA icon: full-bleed background, mark inside the 80% safe circle
  const m = centered(markFull('mk'), 0.62);
  put('icon-maskable.svg', svg(512, 512, `<defs>${bgDark('mkbg', 512, 512)}${m.defs}</defs><rect width="512" height="512" fill="url(#mkbg)"/>${m.body}`));
}

// Splash screens (1920 x 1080) and social preview (1200 x 630)
function splash(variant, w, h, markH) {
  const st = stacked(variant, { width: w, height: h, markH });
  const bg = variant === 'dark' ? bgDark('spbg', w, h) : bgLight('spbg', w, h);
  return st.replace('<defs>', `<defs>${bg}`).replace('</defs>', `</defs><rect width="${w}" height="${h}" fill="url(#spbg)"/>`);
}
put('splash-dark.svg', splash('dark', 1920, 1080, 300));
put('splash-light.svg', splash('light', 1920, 1080, 300));
put('og-image.svg', splash('dark', 1200, 630, 220));

// TV: Android TV banner (320 x 180 at xhdpi) and Apple TV top shelf / icon artwork
function banner(w, h, variant = 'dark', { markH = h * 0.42 } = {}) {
  const inner = horizontal(variant, false);
  const [, iw, ih] = inner.match(/width="([\d.]+)" height="([\d.]+)"/);
  const s = Math.min((markH + 48 * (markH / 200)) / +ih, (w * 0.86) / +iw);
  const tw = +iw * s;
  const th = +ih * s;
  const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\n$/, '').replace(/<title>.*?<\/title>/, '');
  const bg = variant === 'dark' ? bgDark('tvbg', w, h) : bgLight('tvbg', w, h);
  return svg(w, h, `<defs>${bg}</defs><rect width="${w}" height="${h}" fill="url(#tvbg)"/><g transform="translate(${f((w - tw) / 2)} ${f((h - th) / 2)}) scale(${f(s * 10000) / 10000})">${body}</g>`);
}
put('tv-banner.svg', banner(320, 180));
// Apple TV app icon: layered for the focus parallax. Back = background, front = mark (transparent);
// tvOS shows the app name under the icon, so the icon itself has no type.
{
  const front = (w, h) => {
    const markH = h * 0.5;
    const s = markH / BBOX.h;
    const m = markFull('atv');
    const x = w / 2 - (BBOX.w * s) / 2 + (CENTER.dx + BBOX.x + BBOX.w / 2 - 256) * s;
    return placeMark(m, x, h / 2 - markH / 2 + CENTER.dy * s, markH);
  };
  const m = front(1280, 768);
  put('appletv-icon-front.svg', svg(1280, 768, `<defs>${m.defs}</defs>${m.body}`));
  put('appletv-icon-back.svg', svg(1280, 768, `<defs>${bgDark('atvbg', 1280, 768)}</defs><rect width="1280" height="768" fill="url(#atvbg)"/>`));
  put('appletv-icon.svg', svg(1280, 768, `<defs>${bgDark('atvbg', 1280, 768)}${m.defs}</defs><rect width="1280" height="768" fill="url(#atvbg)"/>${m.body}`));
}
put('appletv-topshelf.svg', banner(1920, 720, 'dark', { markH: 720 * 0.3 }));
put('appletv-topshelfwide.svg', banner(2320, 720, 'dark', { markH: 720 * 0.3 }));

for (const [n, c] of Object.entries(files)) {
  if (/<text|<script|href=|<image/i.test(c)) throw new Error(`${n} contains forbidden markup`);
  fs.writeFileSync(path.join(OUT, n), c);
}
console.log(`Wrote ${Object.keys(files).length} master SVGs to ${path.relative(repo, OUT)}/ (adaptive scale ${ADAPTIVE.toFixed(3)})`);

// ---- web inline art ---------------------------------------------------------------------------
{
  const m = markFull('{id}');
  const s = markSimple('{id}');
  const t = typeset('MediaMax', 800, 100, -0.012);
  const ts = (fr) => JSON.stringify(fr.defs + fr.body);
  const nameRun = t.items.map((it) => ({ x: f(it.x), d: transformPath(it.d, t.k, it.x, 0) }));
  const ts1 = `// Generated by scripts/brand/build-masters.mjs. Do not edit.
/* eslint-disable */
/** Mark on the 512 grid; replace {id} with a unique prefix before inlining. */
export const MARK_VIEWBOX = '${f(BBOX.x - 8)} ${f(BBOX.y - 8)} ${f(BBOX.w + 16)} ${f(BBOX.h + 16)}';
export const MARK_ASPECT = ${f((BBOX.w + 16) / (BBOX.h + 16))};
export const MARK_FULL = ${ts(m)};
export const MARK_SIMPLE = ${ts(s)};
/** "MediaMax" in Plus Jakarta Sans ExtraBold at 100 px; glyph paths are positioned (baseline y = 0); x is where glyph i starts. "Max" starts at index 5. */
export const NAME = { width: ${f(t.width)}, cap: ${f(t.cap)}, glyphs: ${JSON.stringify(nameRun)} };
export const NAME_GRADIENT = { dark: ${JSON.stringify(PALETTE.maxDark)}, light: ${JSON.stringify(PALETTE.maxLight)} };
`;
  const dest = path.join(repo, 'web/src/brand/art.ts');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, ts1);
}
