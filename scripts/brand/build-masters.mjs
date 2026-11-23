#!/usr/bin/env node
/**
 * Build the Kinora master SVGs in branding/kinora/ from the mark geometry (scripts/brand/mark.mjs) and the outlined
 * glyphs (branding/kinora/source/glyphs.json: "Kinora" in Bricolage Grotesque ExtraBold, the tagline in Figtree Bold,
 * the Lumen type pairing; see scripts/brand/extract-glyphs.py).
 *
 *   node scripts/brand/build-masters.mjs     (then: node scripts/brand-export.mjs --no-masters)
 *
 * Every shipped SVG is plain paths: no <text>, no fonts, no scripts, no external references.
 * Also writes web/src/brand/art.ts (inline SVG fragments used by the web app's logo components).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BBOX, CENTER, COLORS, centered, markFull, markMono, markSimple, keyPoints } from './mark.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..', '..');
const OUT = path.join(repo, 'branding/kinora');
const glyphs = JSON.parse(fs.readFileSync(path.join(OUT, 'source/glyphs.json'), 'utf8')).roles;
const f = (n) => +(+n).toFixed(2);
const NAME_TEXT = glyphs.name.text; // "Kinora"
const TAG_TEXT = glyphs.tagline.text;
const NAME_TRACK = -0.01;

// ---- palette ----------------------------------------------------------------------------------
export const PALETTE = {
  ground: COLORS.ground, // dark background
  groundGlow: COLORS.groundGlow,
  groundLight: '#F4F8F6',
  ink: COLORS.ink, // the name on light backgrounds
  white: '#FFFFFF',
  dotDark: ['#63DEC5', '#63DEC5'],
  dotLight: ['#137665', '#137665'],
  taglineDark: '#B1C2BE',
  taglineLight: '#52655F',
};

// ---- type -------------------------------------------------------------------------------------
/** Lay out `text` in `role` (name | tagline) at `size` px with `tracking` (em). Returns glyph placements + metrics. */
function typeset(text, role, size, tracking = 0) {
  const g = glyphs[role];
  const k = size / 1000;
  let x = 0;
  const items = [];
  [...text].forEach((c, i) => {
    const gl = g.glyphs[c];
    if (!gl) throw new Error(`glyph "${c}" missing from glyphs.json (${role}); rerun scripts/brand/extract-glyphs.py`);
    if (i > 0) x += (g.kern[text[i - 1] + c] ?? 0) * k + tracking * size;
    items.push({ c, x, d: gl.d, dot: gl.dot });
    x += gl.adv * k;
  });
  const dotTop = Math.max(0, ...items.filter((it) => it.dot).map((it) => -Math.min(...it.dot.match(/-?\d*\.?\d+/g).filter((_, j) => j % 2 === 1).map(Number))));
  return { items, width: x, k, cap: g.capHeight * k, top: Math.max(g.capHeight, dotTop) * k, size };
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
/** SVG for a typeset run with its baseline-left at (x, y). Tittles get `dotFill` (defaults to `fill`). */
function run(t, x, y, fill, dotFill = fill) {
  return t.items
    .map((it) => (it.d ? `<path d="${transformPath(it.d, t.k, x + it.x, y)}" fill="${fill}"/>` : '') + (it.dot ? `<path d="${transformPath(it.dot, t.k, x + it.x, y)}" fill="${dotFill}"/>` : ''))
    .join('');
}

// ---- helpers ----------------------------------------------------------------------------------
const svg = (w, h, inner, { title = 'Kinora', vb } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${f(w)}" height="${f(h)}" viewBox="${vb ?? `0 0 ${f(w)} ${f(h)}`}" role="img" aria-label="${title}"><title>${title}</title>${inner}</svg>\n`;
const grad = (id, x1, y1, x2, y2, stops) =>
  `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${f(x1)}" y1="${f(y1)}" x2="${f(x2)}" y2="${f(y2)}">${stops.map((c, i) => `<stop offset="${f(i / (stops.length - 1))}" stop-color="${c}"/>`).join('')}</linearGradient>`;

/** Place the mark (512-grid fragment) so its bounding box's top-left lands at (x, y) with height h. */
function placeMark(frag, x, y, h) {
  const s = h / BBOX.h;
  return { defs: frag.defs, body: `<g transform="translate(${f(x)} ${f(y)}) scale(${f(s * 10000) / 10000}) translate(${-BBOX.x} ${-BBOX.y})">${frag.body}</g>`, w: BBOX.w * s };
}

/**
 * The name "Kinora" set at `size`, baseline-left at (x, y). Variant: dark | light | mono:<colour>.
 * The letters take the text colour; the tittle of the "i" is lit in the beam colours. Returns { defs, body, width }.
 */
function name(x, y, size, variant, id) {
  const t = typeset(NAME_TEXT, 'name', size, NAME_TRACK);
  if (variant.startsWith('mono:')) {
    const c = variant.slice(5);
    return { defs: '', body: run(t, x, y, c), width: t.width, cap: t.cap, top: t.top };
  }
  const ink = variant === 'dark' ? PALETTE.white : PALETTE.ink;
  const stops = variant === 'dark' ? PALETTE.dotDark : PALETTE.dotLight;
  const i = t.items.find((it) => it.dot);
  const dx = x + i.x;
  const defs = grad(`${id}-dot`, dx, y - t.top, dx + glyphs.name.glyphs.i.adv * t.k, y - t.cap * 0.8, stops);
  return { defs, body: run(t, x, y, ink, `url(#${id}-dot)`), width: t.width, cap: t.cap, top: t.top };
}

/** Tagline justified to `width` (tracking solved so the ink spans exactly that width). */
function tagline(x, y, width, size, color) {
  const base = typeset(TAG_TEXT, 'tagline', size, 0);
  const n = TAG_TEXT.length - 1;
  const tracking = (width - base.width) / n / size;
  const t = typeset(TAG_TEXT, 'tagline', size, tracking);
  return { body: run(t, x, y, color), cap: t.cap, tracking };
}
const tagColor = (variant) => (variant === 'dark' ? PALETTE.taglineDark : variant === 'light' ? PALETTE.taglineLight : variant.slice(5));

// ---- masters ----------------------------------------------------------------------------------
const files = {};
const put = (n, content) => (files[n] = content);

// Marks (tight viewBox around the bounding box with 4% padding)
{
  const p = Math.round(BBOX.h * 0.04);
  const vb = `${f(BBOX.x - p)} ${f(BBOX.y - p)} ${f(BBOX.w + 2 * p)} ${f(BBOX.h + 2 * p)}`;
  const W = BBOX.w + 2 * p;
  const H = BBOX.h + 2 * p;
  const m = markFull('km');
  put('mark.svg', svg(W, H, `<defs>${m.defs}</defs>${m.body}`, { vb }));
  const s = markSimple('kms');
  put('mark-simple.svg', svg(W, H, `<defs>${s.defs}</defs>${s.body}`, { vb }));
  for (const [nm, c] of [['black', '#000000'], ['white', '#FFFFFF']]) {
    const mm = markMono(c);
    put(`mark-mono-${nm}.svg`, svg(W, H, mm.body, { vb }));
  }
}

// Horizontal wordmark (mark + name), optional tagline
function horizontal(variant, withTagline) {
  const id = `wm${variant[0]}${withTagline ? 't' : ''}`;
  const markH = 200;
  const pad = 24;
  const mono = variant.startsWith('mono:');
  const mark = placeMark(mono ? markMono(variant.slice(5)) : markFull(id + 'm', variant === 'light' ? '#137665' : undefined), pad, pad, markH);
  const size = 165;
  const x = pad + mark.w + markH * 0.16;
  const probe = typeset(NAME_TEXT, 'name', size, NAME_TRACK);
  const cy = pad + markH / 2;
  let baseline;
  let tag = { body: '' };
  if (withTagline) {
    const tagSize = 25;
    const gapT = size * 0.2;
    const tagCap = (glyphs.tagline.capHeight * tagSize) / 1000;
    const block = probe.cap + gapT + tagCap;
    baseline = cy - block / 2 + probe.cap;
    tag = tagline(x + 3, baseline + gapT + tagCap, probe.width - 6, tagSize, tagColor(variant));
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
  const size = 150;
  const t = typeset(NAME_TEXT, 'name', size, NAME_TRACK);
  const pad = 4;
  const nm = name(pad, pad + t.top + 2, size, variant, `n${variant[0]}`);
  // descender-free text: the box is the tallest ink (the i's tittle) + small overshoot
  return svg(nm.width + 2 * pad, t.top + 2 * pad + 6, `<defs>${nm.defs}</defs>${nm.body}`);
}
put('name-dark.svg', nameOnly('dark'));
put('name-light.svg', nameOnly('light'));

// Stacked lockup: mark over name over tagline
function stacked(variant, { width = 1000, height = 900, bg = null, markH = 300, withTagline = true } = {}) {
  const id = `st${variant[0]}`;
  const size = 150;
  const probe = typeset(NAME_TEXT, 'name', size, NAME_TRACK);
  const tagSize = 26;
  const tagCap = (glyphs.tagline.capHeight * tagSize) / 1000;
  const gap1 = markH * 0.22;
  const gap2 = size * 0.24;
  const block = markH + gap1 + probe.cap + (withTagline ? gap2 + tagCap : 0);
  const top = (height - block) / 2;
  const mono = variant.startsWith('mono:');
  const markW = (BBOX.w * markH) / BBOX.h;
  // centre the mark optically (same nudge as the square icons)
  const mark = placeMark(mono ? markMono(variant.slice(5)) : markFull(id + 'm', variant === 'light' ? '#137665' : undefined), width / 2 - markW / 2 + (CENTER.dx + (BBOX.x + BBOX.w / 2) - 256) * (markH / BBOX.h), top, markH);
  const x = (width - probe.width) / 2;
  const baseline = top + markH + gap1 + probe.cap;
  const nm = name(x, baseline, size, variant, id);
  const tag = withTagline ? tagline(x + 3, baseline + gap2 + tagCap, probe.width - 6, tagSize, tagColor(variant)) : { body: '' };
  const bgRect = bg ? `<rect width="${width}" height="${height}" fill="${bg}"/>` : '';
  return svg(width, height, `<defs>${mark.defs}${nm.defs}</defs>${bgRect}${mark.body}${nm.body}${tag.body}`);
}
put('lockup-stacked-dark.svg', stacked('dark'));
put('lockup-stacked-light.svg', stacked('light'));
put('lockup-stacked-mono-black.svg', stacked('mono:#000000'));
put('lockup-stacked-mono-white.svg', stacked('mono:#FFFFFF'));

// Backgrounds: the ground with a soft pool of light above the centre (the Lumen glow)
const bgDark = (id, w, h) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(w * 0.5)}" cy="${f(h * 0.34)}" r="${f(Math.max(w, h) * 0.75)}"><stop offset="0" stop-color="${PALETTE.groundGlow}"/><stop offset="1" stop-color="${PALETTE.ground}"/></radialGradient>`;
const bgLight = (id, w, h) =>
  `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${f(w * 0.5)}" cy="${f(h * 0.34)}" r="${f(Math.max(w, h) * 0.75)}"><stop offset="0" stop-color="#FFFFFF"/><stop offset="1" stop-color="#E5EFEB"/></radialGradient>`;

// App icons: 1024 square, opaque, mark optically centred
const APP_SCALE = 0.86;
for (const [nm, bg] of [['dark', bgDark], ['light', bgLight]]) {
  const m = centered(markFull('ai', nm === 'light' ? '#137665' : undefined), APP_SCALE);
  put(`app-icon-${nm}.svg`, svg(1024, 1024, `<defs>${bg('aibg', 512, 512)}${m.defs}</defs><rect width="512" height="512" fill="url(#aibg)"/>${m.body}`, { vb: '0 0 512 512' }));
}

// Android adaptive icon: 108 dp canvas; everything must sit in the 66 dp safe circle.
// Scale the mark so its farthest point from the centre is 99% of the safe radius.
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
  put('android-monochrome.svg', svg(1024, 1024, mm.body, { vb: '0 0 512 512' }));
  put('android-background.svg', svg(1024, 1024, `<defs>${bgDark('abg', 512, 512)}</defs><rect width="512" height="512" fill="url(#abg)"/>`, { vb: '0 0 512 512' }));
  // Notification small icon: white silhouette on transparent
  const nmk = centered(markMono('#FFFFFF'), 1.02);
  put('notification-icon.svg', svg(96, 96, nmk.body, { vb: '0 0 512 512' }));
}

// Favicon: simplified mark on the dark rounded square (reads on light and dark tab strips)
{
  const s = centered(markSimple('fv'), 0.98);
  put('favicon.svg', svg(32, 32, `<defs>${s.defs}</defs><rect width="512" height="512" rx="112" fill="${PALETTE.ground}"/>${s.body}`, { vb: '0 0 512 512' }));
  // Maskable PWA icon: full-bleed background, mark inside the 80% safe circle
  const m = centered(markFull('mk'), 0.64);
  put('icon-maskable.svg', svg(512, 512, `<defs>${bgDark('mkbg', 512, 512)}${m.defs}</defs><rect width="512" height="512" fill="url(#mkbg)"/>${m.body}`));
}

// Splash screens (1920 x 1080) and social preview (1200 x 630)
function splash(variant, w, h, markH, opts = {}) {
  const st = stacked(variant, { width: w, height: h, markH, ...opts });
  const bg = variant === 'dark' ? bgDark('spbg', w, h) : bgLight('spbg', w, h);
  return st.replace('<defs>', `<defs>${bg}`).replace('</defs>', `</defs><rect width="${w}" height="${h}" fill="url(#spbg)"/>`);
}
put('splash-dark.svg', splash('dark', 1920, 1080, 300));
put('splash-light.svg', splash('light', 1920, 1080, 300));
put('og-image.svg', splash('dark', 1200, 630, 220));

// TV and store art: a horizontal lockup centred on the dark ground
function banner(w, h, variant = 'dark', { markH = h * 0.42, maxW = 0.86 } = {}) {
  const inner = horizontal(variant, false);
  const [, iw, ih] = inner.match(/width="([\d.]+)" height="([\d.]+)"/);
  const s = Math.min((markH + 48 * (markH / 200)) / +ih, (w * maxW) / +iw);
  const tw = +iw * s;
  const th = +ih * s;
  const body = inner.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\n$/, '').replace(/<title>.*?<\/title>/, '');
  const bg = variant === 'dark' ? bgDark('tvbg', w, h) : bgLight('tvbg', w, h);
  return svg(w, h, `<defs>${bg}</defs><rect width="${w}" height="${h}" fill="url(#tvbg)"/><g transform="translate(${f((w - tw) / 2)} ${f((h - th) / 2)}) scale(${f(s * 10000) / 10000})">${body}</g>`);
}
put('tv-banner.svg', banner(320, 180));
put('play-feature-graphic.svg', banner(1024, 500, 'dark', { markH: 500 * 0.34 }));
// Apple TV app icon: layered for the focus parallax. Back = background, front = mark (transparent);
// tvOS shows the app name under the icon, so the icon itself has no type.
{
  const front = (w, h) => {
    const markH = h * 0.52;
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

// Roku: channel focus icons (mark over name; the launcher grid draws them on its own background), splash, spinner
function rokuIcon(w, h) {
  const st = stacked('dark', { width: w * 4, height: h * 4, markH: h * 4 * 0.46, withTagline: false });
  const body = st.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\n$/, '').replace(/<title>.*?<\/title>/, '');
  return svg(w, h, `<defs>${bgDark('rkbg', w * 4, h * 4)}</defs><rect width="${w * 4}" height="${h * 4}" fill="url(#rkbg)"/>${body}`, { vb: `0 0 ${w * 4} ${h * 4}` });
}
put('roku-icon-fhd.svg', rokuIcon(336, 210));
put('roku-icon-hd.svg', rokuIcon(290, 218));
put('roku-poster.svg', rokuIcon(540, 405));
{
  // Loading spinner: a three-quarter ring in the beam colours (Roku rotates the poster).
  const r = 38;
  const c = 48;
  const a = (deg) => [c + r * Math.cos((deg * Math.PI) / 180), c + r * Math.sin((deg * Math.PI) / 180)];
  const [sx, sy] = a(-90);
  const [ex, ey] = a(180);
  put('spinner.svg', svg(96, 96, `<defs>${grad('sp', 10, 10, 86, 86, [COLORS.beam[0], COLORS.beam[1], COLORS.beam[2]])}</defs><path d="M${f(sx)} ${f(sy)}A${r} ${r} 0 1 1 ${f(ex)} ${f(ey)}" fill="none" stroke="url(#sp)" stroke-width="9" stroke-linecap="round"/>`));
}

for (const [n, c] of Object.entries(files)) {
  if (/<text|<script|href=|<image/i.test(c)) throw new Error(`${n} contains forbidden markup`);
  fs.writeFileSync(path.join(OUT, n), c);
}
console.log(`Wrote ${Object.keys(files).length} master SVGs to ${path.relative(repo, OUT)}/ (adaptive scale ${ADAPTIVE.toFixed(3)})`);

// ---- web inline art ---------------------------------------------------------------------------
{
  const m = markFull('{id}');
  const s = markSimple('{id}');
  const t = typeset(NAME_TEXT, 'name', 100, NAME_TRACK);
  const ts = (fr) => JSON.stringify((fr.defs + fr.body).replaceAll('#63DEC5', 'var(--brand-mark-color, #63DEC5)'));
  const nameRun = t.items.map((it) => ({ x: f(it.x), d: transformPath(it.d, t.k, it.x, 0), ...(it.dot ? { dot: transformPath(it.dot, t.k, it.x, 0) } : {}) }));
  const ts1 = `// Generated by scripts/brand/build-masters.mjs. Do not edit.
/* eslint-disable */
/** Mark on the 512 grid; replace {id} with a unique prefix before inlining. */
export const MARK_VIEWBOX = '${f(BBOX.x - 8)} ${f(BBOX.y - 8)} ${f(BBOX.w + 16)} ${f(BBOX.h + 16)}';
export const MARK_ASPECT = ${f((BBOX.w + 16) / (BBOX.h + 16))};
export const MARK_FULL = ${ts(m)};
export const MARK_SIMPLE = ${ts(s)};
/** "${NAME_TEXT}" in ${glyphs.name.font} at 100 px; glyph paths are positioned (baseline y = 0); x is where glyph i starts. \`top\` is the tallest ink (the i's tittle, drawn separately in \`dot\`). */
export const NAME = { width: ${f(t.width)}, cap: ${f(t.cap)}, top: ${f(t.top)}, glyphs: ${JSON.stringify(nameRun)} };
/** Gradient for the i's tittle (a point of projector light), per theme mode. */
export const NAME_GRADIENT = { dark: ${JSON.stringify(PALETTE.dotDark)}, light: ${JSON.stringify(PALETTE.dotLight)} };
`;
  const dest = path.join(repo, 'web/src/brand/art.ts');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, ts1);
}
