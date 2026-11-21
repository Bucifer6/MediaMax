/**
 * Artwork for the review pack, drawn on a canvas in Chromium (Playwright) from seeded maths: posters, backdrops,
 * title cards, album and podcast covers, photos and channel logos. No images or fonts are downloaded; text uses
 * whatever sans-serif fonts the machine has (Inter, DejaVu Sans or Liberation Sans in the stack). The only logo
 * used is Kinora's own mark, read from branding/kinora/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export function loadPlaywright() {
  try {
    return require('playwright');
  } catch {
    throw new Error('The review pack needs the `playwright` package: run `npm install --no-save playwright@1.63.0` in the repo root (and `npx playwright install chromium`, or set CHROMIUM_PATH to a Chrome/Chromium binary).');
  }
}

export async function launchBrowser(args = []) {
  const { chromium } = loadPlaywright();
  return chromium.launch({ args, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}) });
}

const FONT = `Inter, 'Inter Display', 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif`;

/** The canvas painter, shipped to the page as source. paint(ctx, W, H, motif, pal, seed, t) */
const PAINTER = String.raw`
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }; }
function paint(c, W, H, motif, pal, seed) {
  const r = rng(seed);
  const [deep, mid, bright, accent] = pal;
  const g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, deep); g.addColorStop(1, mid); c.fillStyle = g; c.fillRect(0, 0, W, H);
  const glow = (x, y, rad, col, a) => { const rg = c.createRadialGradient(x, y, 0, x, y, rad); rg.addColorStop(0, col + a); rg.addColorStop(1, col + '00'); c.fillStyle = rg; c.fillRect(0, 0, W, H); };
  if (motif === 'aurora') {
    for (let i = 0; i < 70; i++) { c.fillStyle = '#ffffff'; c.globalAlpha = r() * 0.8; c.fillRect(r() * W, r() * H * 0.6, 1.5 + r() * 1.5, 1.5 + r() * 1.5); }
    c.globalAlpha = 1;
    for (let k = 0; k < 5; k++) {
      const col = k % 2 ? accent : bright, base = H * (0.25 + k * 0.07), amp = H * (0.05 + r() * 0.08), f = 1.5 + r() * 2, ph = r() * 6;
      for (let x = 0; x < W; x += 3) {
        const y = base + Math.sin(x / W * Math.PI * f + ph) * amp;
        const gr = c.createLinearGradient(0, y - H * 0.25, 0, y); gr.addColorStop(0, col + '00'); gr.addColorStop(1, col + '55');
        c.fillStyle = gr; c.fillRect(x, y - H * 0.25, 3, H * 0.25);
      }
    }
    c.fillStyle = deep; c.beginPath(); c.moveTo(0, H);
    for (let x = 0; x <= W; x += W / 24) c.lineTo(x, H * (0.78 + r() * 0.08)); c.lineTo(W, H); c.fill();
  } else if (motif === 'mountains' || motif === 'forest') {
    glow(W * (0.25 + r() * 0.5), H * 0.3, H * 0.5, accent, 'aa');
    for (let layer = 0; layer < 4; layer++) {
      const y0 = H * (0.45 + layer * 0.12), col = layer === 3 ? deep : [bright, accent, mid][layer % 3];
      c.fillStyle = col; c.globalAlpha = 0.35 + layer * 0.2; c.beginPath(); c.moveTo(0, H);
      let y = y0; for (let x = 0; x <= W; x += W / 40) { y += (r() - 0.5) * H * 0.06; y = Math.min(Math.max(y, y0 - H * 0.12), y0 + H * 0.06); c.lineTo(x, y); }
      c.lineTo(W, H); c.fill();
    }
    c.globalAlpha = 1;
    if (motif === 'forest') for (let i = 0; i < 60; i++) { const x = r() * W, h = H * (0.08 + r() * 0.1), y = H * 0.85 + r() * H * 0.1; c.fillStyle = deep; c.beginPath(); c.moveTo(x, y - h); c.lineTo(x - h * 0.3, y); c.lineTo(x + h * 0.3, y); c.fill(); }
  } else if (motif === 'waves' || motif === 'dusk') {
    glow(W * 0.5, H * 0.35, H * 0.45, accent, '99');
    for (let k = 0; k < 26; k++) {
      c.beginPath(); const y0 = H * 0.45 + k * H * 0.022;
      for (let x = 0; x <= W; x += 8) { const y = y0 + Math.sin(x / (60 + k * 6) + k * 0.7) * (6 + k * 0.8) + Math.sin(x / 17 + k) * 2; x ? c.lineTo(x, y) : c.moveTo(x, y); }
      c.strokeStyle = k % 3 ? bright + '55' : accent + 'aa'; c.lineWidth = 1.5 + k * 0.08; c.stroke();
    }
  } else if (motif === 'orbits') {
    glow(W * 0.5, H * 0.5, Math.min(W, H) * 0.35, accent, 'cc');
    for (let i = 0; i < 9; i++) { c.beginPath(); c.ellipse(W / 2, H / 2, Math.min(W, H) * (0.1 + i * 0.05), Math.min(W, H) * (0.05 + i * 0.03), i * 0.35, 0, Math.PI * 2); c.strokeStyle = i % 2 ? bright + '88' : accent + 'cc'; c.lineWidth = 2; c.stroke();
      const a = r() * Math.PI * 2; c.fillStyle = bright; c.beginPath(); c.arc(W / 2 + Math.cos(a) * Math.min(W, H) * (0.1 + i * 0.05), H / 2 + Math.sin(a) * Math.min(W, H) * (0.05 + i * 0.03), 4 + r() * 6, 0, Math.PI * 2); c.fill(); }
  } else if (motif === 'rings') {
    for (let i = 30; i > 0; i--) { c.beginPath(); c.arc(W * 0.5, H * 0.55, i * Math.min(W, H) * 0.025, 0, Math.PI * 2); c.strokeStyle = i % 4 ? bright + '44' : accent; c.lineWidth = i % 4 ? 2 : 5; c.stroke(); }
    glow(W * 0.5, H * 0.55, Math.min(W, H) * 0.3, accent, 'aa');
  } else if (motif === 'grid') {
    const hz = H * 0.58;
    const sun = c.createLinearGradient(0, hz - H * 0.35, 0, hz); sun.addColorStop(0, accent); sun.addColorStop(1, bright);
    c.fillStyle = sun; c.beginPath(); c.arc(W / 2, hz, H * 0.25, Math.PI, 0); c.fill();
    c.fillStyle = deep; for (let i = 0; i < 6; i++) c.fillRect(0, hz - H * 0.03 - i * H * 0.035, W, H * 0.008 + i * 0.002 * H);
    c.fillStyle = deep; c.fillRect(0, hz, W, H - hz);
    c.strokeStyle = accent + 'aa'; c.lineWidth = 2;
    for (let i = -20; i <= 20; i++) { c.beginPath(); c.moveTo(W / 2 + i * W * 0.01, hz); c.lineTo(W / 2 + i * W * 0.12, H); c.stroke(); }
    for (let k = 1; k < 14; k++) { const y = hz + (H - hz) * Math.pow(k / 14, 1.8); c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
  } else if (motif === 'cells') {
    const n = 26, s = Math.min(W, H) / n;
    for (let y = 0; y < H / s; y++) for (let x = 0; x < W / s; x++) { if (r() < 0.45) continue; c.fillStyle = [bright, accent, mid][Math.floor(r() * 3)]; c.globalAlpha = 0.4 + r() * 0.6; c.beginPath(); c.arc(x * s + s / 2, y * s + s / 2, s * (0.2 + r() * 0.25), 0, Math.PI * 2); c.fill(); }
    c.globalAlpha = 1;
  }
  const v = c.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75); v.addColorStop(0, 'rgba(0,0,0,0)'); v.addColorStop(1, 'rgba(0,0,0,0.55)'); c.fillStyle = v; c.fillRect(0, 0, W, H);
}
`;

const seedOf = (s) => [...String(s)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function canvasPage({ w, h, motif, pal, seed, overlay = '', transparent = false }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden;background:${transparent ? 'transparent' : '#000'};font-family:${FONT}}
canvas{position:absolute;inset:0}
.o{position:absolute;inset:0}
</style></head><body>${transparent ? '' : `<canvas id="c" width="${w}" height="${h}"></canvas>`}<div class="o">${overlay}</div>
<script>${PAINTER}${transparent ? '' : `paint(document.getElementById('c').getContext('2d'), ${w}, ${h}, ${JSON.stringify(motif)}, ${JSON.stringify(pal)}, ${seed});`}</script></body></html>`;
}

let MARK = null;
/** Kinora's own mark (white, single colour) as inline SVG. */
export function kinoraMark(repo, px) {
  MARK ??= fs.readFileSync(path.join(repo, 'branding', 'kinora', 'mark-mono-white.svg'), 'utf8').replace(/<\?xml[^>]*>/, '');
  return MARK.replace('<svg', `<svg style="width:${px}px;height:${px}px;display:block"`);
}

export const posterHtml = (it, { badge } = {}) => canvasPage({
  w: 1000, h: 1500, motif: it.motif, pal: it.pal, seed: seedOf(it.slug ?? it.title),
  overlay: `<div style="position:absolute;left:70px;right:70px;bottom:120px;color:#fff;text-shadow:0 4px 30px rgba(0,0,0,.6)">
    ${badge ? `<div style="display:inline-block;font:700 34px/1 ${FONT};letter-spacing:4px;padding:12px 20px;border:3px solid #fff;border-radius:12px;margin-bottom:34px">${esc(badge)}</div>` : ''}
    <div style="font:800 ${it.title.length > 16 ? 96 : 128}px/0.95 ${FONT};letter-spacing:-2px">${esc(it.title)}</div>
    <div style="font:500 40px/1.3 ${FONT};margin-top:30px;opacity:.85">${esc(it.tagline ?? '')}</div>
  </div>
  <div style="position:absolute;left:70px;top:70px;font:600 30px ${FONT};color:#fff;opacity:.75;letter-spacing:6px">${esc(String(it.year ?? ''))}</div>`,
});

export const backdropHtml = (it, seedSuffix = '') => canvasPage({ w: 1920, h: 1080, motif: it.motif, pal: it.pal, seed: seedOf((it.slug ?? it.title) + seedSuffix) });

/** Transparent title card overlaid on the first seconds of a generated film. */
export const titleCardHtml = (repo, title, sub, w, h) => {
  const k = w / 1920;
  return canvasPage({ w, h, transparent: true, overlay: `<div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#fff;text-shadow:0 ${6 * k}px ${40 * k}px rgba(0,0,0,.7)">
    <div style="font:800 ${150 * k}px/1 ${FONT};letter-spacing:${-3 * k}px">${esc(title)}</div>
    <div style="font:500 ${44 * k}px/1.2 ${FONT};margin-top:${30 * k}px;opacity:.9">${esc(sub)}</div>
    <div style="display:flex;align-items:center;gap:${16 * k}px;margin-top:${60 * k}px;font:600 ${30 * k}px ${FONT};opacity:.8">${kinoraMark(repo, Math.round(48 * k))}<span>Generated by Kinora · CC0</span></div>
  </div>` });
};

export const coverHtml = (it, line1, line2, size = 1000) => canvasPage({
  w: size, h: size, motif: it.motif, pal: it.pal, seed: seedOf(line1 + line2),
  overlay: `<div style="position:absolute;left:0;right:0;bottom:0;padding:${size * 0.06}px;background:linear-gradient(transparent,rgba(0,0,0,.65));color:#fff">
    <div style="font:800 ${size * 0.085}px/1 ${FONT}">${esc(line1)}</div>
    <div style="font:500 ${size * 0.045}px/1.3 ${FONT};margin-top:${size * 0.02}px;opacity:.85">${esc(line2)}</div></div>`,
});

export const photoHtml = (motif, pal, name) => canvasPage({ w: 2400, h: 1600, motif, pal, seed: seedOf(name) });

export const channelLogoHtml = (repo, ch) => canvasPage({ w: 400, h: 240, transparent: true, overlay: `<div style="position:absolute;inset:20px;border-radius:28px;background:linear-gradient(135deg,${ch.pal[1]},${ch.pal[0]});display:flex;align-items:center;justify-content:center;gap:16px;color:#fff;font:800 40px/1.05 ${FONT}">${kinoraMark(repo, 64)}<span>${esc(ch.name.replace('Kinora ', ''))}</span></div>` });

/** Full frame for a live test channel (the stream loops it with a moving clock from ffmpeg). */
export const channelFrameHtml = (repo, ch) => canvasPage({ w: 1280, h: 720, motif: ch.visual === 'testcard' ? 'grid' : 'aurora', pal: ch.pal, seed: seedOf(ch.id),
  overlay: `<div style="position:absolute;left:48px;top:40px;display:flex;align-items:center;gap:14px;color:#fff;font:700 30px ${FONT}">${kinoraMark(repo, 44)}<span>${esc(ch.name)}</span></div>
  <div style="position:absolute;left:48px;bottom:44px;color:#fff;opacity:.8;font:500 24px ${FONT}">Generated test channel · no broadcast content</div>` });

/** Renders HTML to an image file with one reused page. */
export class Renderer {
  constructor(browser) {
    this.browser = browser;
  }
  async open() {
    this.page = await this.browser.newPage();
  }
  async render(html, w, h, out, { type, quality = 90 } = {}) {
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await this.page.setViewportSize({ width: w, height: h });
    await this.page.setContent(html, { waitUntil: 'load' });
    await this.page.evaluate(() => document.fonts.ready);
    const t = type ?? (out.endsWith('.png') ? 'png' : 'jpeg');
    await this.page.screenshot({ path: out, type: t, ...(t === 'jpeg' ? { quality } : { omitBackground: true }), clip: { x: 0, y: 0, width: w, height: h } });
    return out;
  }
  async close() {
    await this.page?.close();
  }
}
