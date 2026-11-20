import fs from 'node:fs';
import path from 'node:path';

/**
 * Artwork templates (HTML + inline SVG) rendered to JPEG/PNG with Playwright.
 * Every function returns an HTML fragment; `Renderer.render()` lays it out at the requested size and saves it.
 */

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

export function rng(seedText) {
  let h = 1779033703 ^ seedText.length;
  for (let i = 0; i < seedText.length; i++) {
    h = Math.imul(h ^ seedText.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  let a = h >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  next.range = (lo, hi) => lo + next() * (hi - lo);
  next.int = (lo, hi) => Math.floor(lo + next() * (hi - lo + 1));
  next.pick = (arr) => arr[Math.floor(next() * arr.length)];
  return next;
}

export const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n) => Math.round(n * 10) / 10;

/** Film grain overlay. */
const grain = (op = 0.18, freq = 0.85) => `<svg class="grain" style="opacity:${op}" xmlns="http://www.w3.org/2000/svg"><filter id="gr"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="3" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 0 0.5  0 0 0 1.4 -0.2"/></filter><rect width="100%" height="100%" filter="url(#gr)"/></svg>`;

export const FONT = {
  scifi: "'Orbitron', 'Inter Display', 'DejaVu Sans', sans-serif",
  noir: "'DM Serif Display', 'Playfair Display', 'DejaVu Serif', serif",
  drama: "'Cormorant Garamond', 'Libre Baskerville', 'DejaVu Serif', serif",
  family: "'Fredoka', 'Lilita One', 'Inter', sans-serif",
  horror: "'Cinzel', 'DejaVu Serif', serif",
  action: "'Bebas Neue', 'Oswald', 'Inter Display', sans-serif",
  adventure: "'Cinzel', 'Libre Baskerville', serif",
  comedy: "'Lilita One', 'Fredoka', 'Inter Display', sans-serif",
  condensed: "'Oswald', 'Bebas Neue', 'Liberation Sans Narrow', sans-serif",
  sans: "'Space Grotesk', 'Inter', sans-serif",
  hand: "'Caveat', 'Fredoka', cursive",
  retro: "'Monoton', 'Orbitron', sans-serif",
  serif: "'Libre Baskerville', 'DejaVu Serif', serif",
};

/* ------------------------------------------------------------------ */
/* Scenes (SVG), parametrised by size so posters and backdrops share   */
/* ------------------------------------------------------------------ */

function stars(r, w, h, n, maxY = 1, op = 0.9) {
  let s = '';
  for (let i = 0; i < n; i++) s += `<circle cx="${f(r() * w)}" cy="${f(r() * h * maxY)}" r="${f(r.range(0.5, 2.2))}" fill="#fff" opacity="${f(r.range(0.2, op))}"/>`;
  return s;
}

function ridge(r, w, h, baseY, amp, steps, smooth = true) {
  const pts = [];
  for (let i = 0; i <= steps; i++) pts.push([(w / steps) * i, baseY - r.range(0, amp)]);
  let d = `M0 ${h} L0 ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length; i++) {
    if (smooth) {
      const [x0, y0] = pts[i - 1];
      const [x1, y1] = pts[i];
      d += ` C${f(x0 + (x1 - x0) / 2)} ${f(y0)} ${f(x0 + (x1 - x0) / 2)} ${f(y1)} ${f(x1)} ${f(y1)}`;
    } else d += ` L${f(pts[i][0])} ${f(pts[i][1])}`;
  }
  return d + ` L${w} ${h} Z`;
}

function skyline(r, w, h, baseY, color, maxH, windows) {
  let s = '';
  let x = -10;
  while (x < w) {
    const bw = r.range(w * 0.03, w * 0.08);
    const bh = r.range(maxH * 0.25, maxH);
    s += `<rect x="${f(x)}" y="${f(baseY - bh)}" width="${f(bw)}" height="${f(bh + h)}" fill="${color}"/>`;
    if (r() < 0.3) s += `<rect x="${f(x + bw / 2 - 1)}" y="${f(baseY - bh - maxH * 0.12)}" width="2" height="${f(maxH * 0.12)}" fill="${color}"/>`;
    if (windows) {
      for (let wy = baseY - bh + 10; wy < baseY - 6; wy += 14) for (let wx = x + 5; wx < x + bw - 6; wx += 10) if (r() < 0.16) s += `<rect x="${f(wx)}" y="${f(wy)}" width="4" height="6" fill="${windows}" opacity="${f(r.range(0.4, 1))}"/>`;
    }
    x += bw + r.range(0, 6);
  }
  return s;
}

function tree(r, x, y, len, ang, depth, color, width) {
  if (depth === 0 || len < 4) return '';
  const x2 = x + Math.cos(ang) * len;
  const y2 = y + Math.sin(ang) * len;
  let s = `<path d="M${f(x)} ${f(y)} L${f(x2)} ${f(y2)}" stroke="${color}" stroke-width="${f(width)}" stroke-linecap="round"/>`;
  const n = depth > 5 ? 2 : r.int(2, 3);
  for (let i = 0; i < n; i++) s += tree(r, x2, y2, len * r.range(0.62, 0.8), ang + r.range(-0.7, 0.7), depth - 1, color, width * 0.68);
  return s;
}

function figure(cx, baseY, hgt, color) {
  // A trench-coat silhouette with a brimmed hat.
  const s = hgt / 100;
  return `<g fill="${color}" transform="translate(${f(cx)} ${f(baseY)}) scale(${f(s)})">
    <ellipse cx="0" cy="-88" rx="12" ry="2.6"/><path d="M-6 -88 Q-6 -97 0 -97 Q6 -97 6 -88 Z"/>
    <ellipse cx="0" cy="-82" rx="5" ry="6.2"/>
    <path d="M-5 -76 L5 -76 L13 -68 L16 -30 L11 -28 L9 -6 L4 0 L1 -6 L-1 -6 L-4 0 L-9 -6 L-11 -28 L-16 -30 L-13 -68 Z"/>
  </g>`;
}

function scene(style, pal, w, h, seed, opts = {}) {
  const r = rng(seed);
  const [c0, c1, ac, lt] = pal;
  const focusX = opts.focusX ?? 0.5;
  const motif = opts.motif ?? null;
  const P = !!opts.poster;
  const u = Math.min(w, h) / 800; // unit scale
  const id = 's' + Math.floor(r() * 1e9);
  let defs = `<filter id="${id}bl" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f(8 * u)}"/></filter><filter id="${id}bl2" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="${f(30 * u)}"/></filter>`;
  let body = '';
  const fx = w * focusX;
  switch (style) {
    case 'scifi': {
      const sunR = Math.min(w, h) * (P ? 0.33 : 0.3);
      const sy = h * (P ? 0.42 : 0.48);
      const horizon = h * (P ? 0.64 : 0.7);
      defs += `<linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.65" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></linearGradient>
        <linearGradient id="${id}sun" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lt}"/><stop offset="0.55" stop-color="${ac}"/><stop offset="1" stop-color="${c1}"/></linearGradient>
        <mask id="${id}m"><rect width="${w}" height="${h}" fill="#fff"/>${Array.from({ length: 7 }, (_, i) => `<rect x="0" y="${f(sy + sunR * (0.12 + i * 0.13))}" width="${w}" height="${f((2 + i * 2.6) * u)}" fill="#000"/>`).join('')}</mask>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}sky)"/>${stars(r, w, h, 180, 0.7)}`;
      const glowSun = (x, y, R, striped = true) => `<circle cx="${f(x)}" cy="${f(y)}" r="${f(R * 1.25)}" fill="${ac}" opacity="0.45" filter="url(#${id}bl2)"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(R)}" fill="url(#${id}sun)" ${striped ? `mask="url(#${id}m)"` : ''}/>`;
      if (motif === 'lighthouse') {
        // ringed planet, ice field, lighthouse with a sweeping beam
        const px = w * (focusX > 0.5 ? 0.72 : 0.3);
        body += glowSun(px, sy * 0.8, sunR * 0.8, false);
        body += `<ellipse cx="${f(px)}" cy="${f(sy * 0.8)}" rx="${f(sunR * 1.5)}" ry="${f(sunR * 0.28)}" fill="none" stroke="${lt}" stroke-width="${f(6 * u)}" opacity="0.7" transform="rotate(-14 ${f(px)} ${f(sy * 0.8)})"/>`;
        for (let i = 0; i < 3; i++) body += `<path d="${ridge(r, w, h, horizon + i * h * 0.07, h * 0.06, 7 + i * 3, false)}" fill="${mix(lt, c1, 0.55 + i * 0.18)}"/>`;
        const lx = w * (focusX > 0.5 ? 0.3 : 0.72);
        const top = horizon - h * 0.28;
        body += `<path d="M${f(lx)} ${f(top)} L${f(lx + w * 0.08)} ${f(top - h * 0.12)} L${f(lx + w * 0.55)} ${f(top - h * 0.22)} L${f(lx + w * 0.55)} ${f(top + h * 0.1)} Z" fill="${lt}" opacity="0.18" filter="url(#${id}bl)"/>`;
        body += `<g fill="${c0}"><path d="M${f(lx - 28 * u)} ${f(horizon + 8 * u)} L${f(lx - 16 * u)} ${f(top + 30 * u)} L${f(lx + 16 * u)} ${f(top + 30 * u)} L${f(lx + 28 * u)} ${f(horizon + 8 * u)} Z"/><rect x="${f(lx - 22 * u)}" y="${f(top + 12 * u)}" width="${f(44 * u)}" height="${f(20 * u)}"/><path d="M${f(lx - 18 * u)} ${f(top + 12 * u)} L${f(lx)} ${f(top - 10 * u)} L${f(lx + 18 * u)} ${f(top + 12 * u)} Z"/></g><rect x="${f(lx - 14 * u)}" y="${f(top + 14 * u)}" width="${f(28 * u)}" height="${f(14 * u)}" fill="${ac}"/><circle cx="${f(lx)}" cy="${f(top + 21 * u)}" r="${f(30 * u)}" fill="${ac}" opacity="0.6" filter="url(#${id}bl)"/>`;
      } else if (motif === 'dish') {
        body += glowSun(fx, sy, sunR, true);
        body += `<rect x="0" y="${f(horizon)}" width="${w}" height="${f(h - horizon)}" fill="${c0}"/>`;
        for (let i = 0; i < 50; i++) body += `<rect x="${f(fx + r.range(-0.3, 0.3) * w)}" y="${f(horizon + r() * (h - horizon))}" width="${f(r.range(20, 120) * u)}" height="${f(2 * u)}" fill="${ac}" opacity="${f(r.range(0.15, 0.5))}"/>`;
        const dx = w * (focusX > 0.5 ? 0.24 : 0.76);
        body += `<path d="M${f(dx - w * 0.25)} ${f(horizon + 2)} Q${f(dx)} ${f(horizon - h * 0.08)} ${f(dx + w * 0.25)} ${f(horizon + 2)} Z" fill="${c0}"/>`;
        const ds = 1.4 * u;
        body += `<g transform="translate(${f(dx)} ${f(horizon - h * 0.05)}) scale(${f(ds)})" fill="${c0}"><path d="M-6 0 L6 0 L14 -60 L-14 -60 Z"/><path d="M-80 -110 Q0 -20 80 -150 Z" transform="rotate(-10)"/><line x1="0" y1="-120" x2="20" y2="-160" stroke="${c0}" stroke-width="5"/></g>`;
        for (let i = 1; i <= 4; i++) body += `<path d="M${f(dx + 40 * u + i * 30 * u)} ${f(horizon - h * 0.2 - i * 30 * u)} a${f(i * 50 * u)} ${f(i * 50 * u)} 0 0 1 ${f(i * 20 * u)} ${f(i * 60 * u)}" stroke="${lt}" stroke-width="${f(3 * u)}" fill="none" opacity="${f(0.8 - i * 0.15)}"/>`;
      } else if (motif === 'orbit' || motif === 'ship') {
        const pr = Math.max(w, h) * 0.9;
        const pcy = h + pr * 0.72;
        defs += `<radialGradient id="${id}pl" cx="0.5" cy="0.2" r="0.6"><stop offset="0" stop-color="${ac}"/><stop offset="0.4" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></radialGradient>`;
        body += `<circle cx="${f(w / 2)}" cy="${f(pcy)}" r="${f(pr * 1.02)}" fill="${lt}" opacity="0.5" filter="url(#${id}bl2)"/><circle cx="${f(w / 2)}" cy="${f(pcy)}" r="${f(pr)}" fill="url(#${id}pl)"/>`;
        for (let i = 0; i < 6; i++) body += `<ellipse cx="${f(w / 2)}" cy="${f(pcy)}" rx="${f(pr * (0.98 - i * 0.04))}" ry="${f(pr * (0.98 - i * 0.04))}" fill="none" stroke="${lt}" stroke-width="${f(2 * u)}" opacity="0.08"/>`;
        if (motif === 'orbit') {
          body += `<ellipse cx="${f(fx)}" cy="${f(h * 0.4)}" rx="${f(w * 0.4)}" ry="${f(h * 0.12)}" fill="none" stroke="${lt}" stroke-width="${f(3 * u)}" stroke-dasharray="${f(10 * u)} ${f(10 * u)}" opacity="0.7" transform="rotate(-12 ${f(fx)} ${f(h * 0.4)})"/>`;
          body += `<ellipse cx="${f(fx)}" cy="${f(h * 0.4)}" rx="${f(w * 0.4)}" ry="${f(h * 0.12)}" fill="none" stroke="${ac}" stroke-width="${f(3 * u)}" stroke-dasharray="${f(10 * u)} ${f(10 * u)}" opacity="0.7" transform="rotate(12 ${f(fx)} ${f(h * 0.4)})"/>`;
          const st = (x, y) => `<g transform="translate(${f(x)} ${f(y)}) scale(${f(u)})"><rect x="-60" y="-6" width="120" height="12" fill="${lt}"/><rect x="-100" y="-26" width="40" height="52" fill="${c1}" stroke="${lt}" stroke-width="3"/><rect x="60" y="-26" width="40" height="52" fill="${c1}" stroke="${lt}" stroke-width="3"/><circle r="22" fill="${lt}"/><circle r="10" fill="${ac}"/></g>`;
          const sd = P ? w * 0.36 : w * 0.24;
          body += st(fx - sd, h * 0.36) + st(fx + sd, h * 0.36);
          body += `<circle cx="${f(fx)}" cy="${f(h * 0.4)}" r="${f(60 * u)}" fill="${ac}" opacity="0.6" filter="url(#${id}bl2)"/>`;
        } else {
          // colony ship crossing the sky
          const sx = fx;
          const sy2 = h * 0.36;
          const L = w * (P ? 0.9 : 0.6);
          body += `<g transform="translate(${f(sx)} ${f(sy2)}) rotate(-8)"><path d="M${f(-L / 2)} 0 L${f(-L / 2 + 40 * u)} ${f(-26 * u)} L${f(L / 2 - 80 * u)} ${f(-30 * u)} L${f(L / 2)} 0 L${f(L / 2 - 80 * u)} ${f(30 * u)} L${f(-L / 2 + 40 * u)} ${f(26 * u)} Z" fill="${c0}" stroke="${lt}" stroke-opacity="0.35" stroke-width="${f(2 * u)}"/>${Array.from({ length: 22 }, (_, i) => `<rect x="${f(-L / 2 + 60 * u + i * (L - 160 * u) / 22)}" y="${f(-4 * u)}" width="${f(6 * u)}" height="${f(4 * u)}" fill="${ac}"/>`).join('')}<circle cx="${f(-L / 2)}" cy="0" r="${f(26 * u)}" fill="${ac}" filter="url(#${id}bl)"/><rect x="${f(-L / 2 - 80 * u)}" y="${f(-4 * u)}" width="${f(80 * u)}" height="${f(8 * u)}" fill="${ac}" opacity="0.6" filter="url(#${id}bl)"/></g>`;
        }
      } else {
        // neon city with a spire
        body += glowSun(fx, sy, sunR, true);
        body += skyline(r, w, h, horizon, c0, h * 0.18, lt);
        if (motif === 'spire') body += `<path d="M${f(fx - 30 * u)} ${f(horizon)} L${f(fx - 8 * u)} ${f(horizon - h * 0.42)} L${f(fx)} ${f(horizon - h * 0.5)} L${f(fx + 8 * u)} ${f(horizon - h * 0.42)} L${f(fx + 30 * u)} ${f(horizon)} Z" fill="${c0}"/><circle cx="${f(fx)}" cy="${f(horizon - h * 0.5)}" r="${f(6 * u)}" fill="${ac}"/><circle cx="${f(fx)}" cy="${f(horizon - h * 0.5)}" r="${f(26 * u)}" fill="${ac}" opacity="0.7" filter="url(#${id}bl)"/>`;
        let g = '';
        for (let i = -24; i <= 24; i++) g += `<line x1="${f(fx + i * w * 0.012)}" y1="${f(horizon)}" x2="${f(fx + i * w * 0.14)}" y2="${h}" stroke="${lt}" stroke-width="${f(1.6 * u)}"/>`;
        for (let i = 1; i < 14; i++) {
          const y = horizon + (h - horizon) * Math.pow(i / 13, 2.1);
          g += `<line x1="0" y1="${f(y)}" x2="${w}" y2="${f(y)}" stroke="${lt}" stroke-width="${f(1.6 * u)}"/>`;
        }
        body += `<rect x="0" y="${f(horizon)}" width="${w}" height="${f(h - horizon)}" fill="${c0}"/><g opacity="0.7">${g}</g>`;
        body += `<rect x="0" y="${f(horizon - 2)}" width="${w}" height="${f(3 * u)}" fill="${ac}" opacity="0.9"/>`;
      }
      break;
    }
    case 'noir': {
      defs += `<radialGradient id="${id}lamp" cx="${focusX}" cy="0.22" r="0.55"><stop offset="0" stop-color="${lt}" stop-opacity="0.55"/><stop offset="0.5" stop-color="${c1}" stop-opacity="0.35"/><stop offset="1" stop-color="${c0}" stop-opacity="0"/></radialGradient>
        <linearGradient id="${id}wet" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></linearGradient>`;
      body += `<rect width="${w}" height="${h}" fill="${c0}"/><rect width="${w}" height="${h}" fill="url(#${id}lamp)"/>`;
      const ground = h * (P ? 0.86 : 0.84);
      const sign = (x, y, text, col) => {
        const ch = [...text];
        const s = 34 * u;
        return `<g><rect x="${f(x - s * 0.75)}" y="${f(y - s * 0.4)}" width="${f(s * 1.5)}" height="${f(ch.length * s * 1.1 + s * 0.2)}" rx="${f(6 * u)}" fill="#000" opacity="0.6" stroke="${col}" stroke-width="${f(3 * u)}"/>${ch.map((c, i) => `<text x="${f(x)}" y="${f(y + s * 0.6 + i * s * 1.1)}" text-anchor="middle" font-family="Bebas Neue, Oswald, sans-serif" font-size="${f(s)}" fill="${col}" filter="url(#${id}bl)">${esc(c)}</text><text x="${f(x)}" y="${f(y + s * 0.6 + i * s * 1.1)}" text-anchor="middle" font-family="Bebas Neue, Oswald, sans-serif" font-size="${f(s)}" fill="${mix(col, '#ffffff', 0.5)}">${esc(c)}</text>`).join('')}</g>`;
      };
      if (motif === 'curtain') {
        // velvet stage curtains, spotlight on a microphone
        defs += `<linearGradient id="${id}cur" x1="0" y1="0" x2="1" y2="0">${Array.from({ length: 9 }, (_, i) => `<stop offset="${i / 8}" stop-color="${i % 2 ? mix(c1, '#000000', 0.5) : c1}"/>`).join('')}</linearGradient>`;
        body += `<path d="M${f(fx - w * 0.2)} 0 L${f(fx + w * 0.2)} 0 L${f(fx + w * 0.35)} ${f(ground)} L${f(fx - w * 0.35)} ${f(ground)} Z" fill="${lt}" opacity="0.14" filter="url(#${id}bl2)"/>`;
        body += `<path d="M0 0 L${f(w * 0.32)} 0 Q${f(w * 0.2)} ${f(h * 0.5)} ${f(w * 0.26)} ${f(h)} L0 ${h} Z" fill="url(#${id}cur)"/><path d="M${w} 0 L${f(w * 0.68)} 0 Q${f(w * 0.8)} ${f(h * 0.5)} ${f(w * 0.74)} ${f(h)} L${w} ${h} Z" fill="url(#${id}cur)"/><path d="M0 0 L${w} 0 L${w} ${f(h * 0.08)} Q${f(w / 2)} ${f(h * 0.16)} 0 ${f(h * 0.08)} Z" fill="${c1}"/><rect x="0" y="${f(h * 0.02)}" width="${w}" height="${f(6 * u)}" fill="${ac}" opacity="0.8"/>`;
        body += `<g fill="#000"><rect x="${f(fx - 3 * u)}" y="${f(ground - h * 0.3)}" width="${f(6 * u)}" height="${f(h * 0.3)}"/><ellipse cx="${f(fx)}" cy="${f(ground)}" rx="${f(40 * u)}" ry="${f(8 * u)}"/><rect x="${f(fx - 12 * u)}" y="${f(ground - h * 0.3 - 40 * u)}" width="${f(24 * u)}" height="${f(46 * u)}" rx="${f(12 * u)}"/></g>`;
        body += `<rect x="0" y="${f(ground)}" width="${w}" height="${f(h - ground)}" fill="#000"/>`;
        for (let i = 0; i < 30; i++) body += `<circle cx="${f(r() * w)}" cy="${f(r() * h * 0.8)}" r="${f(r.range(1, 3) * u)}" fill="${ac}" opacity="${f(r.range(0.3, 0.9))}"/>`;
      } else if (motif === 'hotel') {
        const bw = w * (P ? 0.8 : 0.42);
        const bx = fx - bw / 2;
        const by = h * 0.18;
        body += `<rect x="${f(bx)}" y="${f(by)}" width="${f(bw)}" height="${f(ground - by)}" fill="${mix(c0, c1, 0.6)}"/><path d="M${f(bx - 10 * u)} ${f(by)} L${f(fx)} ${f(by - h * 0.06)} L${f(bx + bw + 10 * u)} ${f(by)} Z" fill="${mix(c0, c1, 0.4)}"/>`;
        const cols = 7;
        const rows = 7;
        for (let yy = 0; yy < rows; yy++) for (let xx = 0; xx < cols; xx++) {
          const lit = r() < 0.22 || (yy === 3 && xx === 4);
          body += `<rect x="${f(bx + bw * (0.06 + xx * 0.13))}" y="${f(by + (ground - by) * (0.08 + yy * 0.11))}" width="${f(bw * 0.08)}" height="${f((ground - by) * 0.07)}" fill="${lit ? '#ffd88a' : '#0b0d14'}" opacity="${lit ? 0.95 : 0.9}"/>`;
        }
        body += `<circle cx="${f(fx)}" cy="${f(by + 10 * u)}" r="${f(22 * u)}" fill="${lt}" opacity="0.9"/><line x1="${f(fx)}" y1="${f(by + 10 * u)}" x2="${f(fx)}" y2="${f(by - 6 * u)}" stroke="#111" stroke-width="${f(3 * u)}"/>`;
        body += sign(bx - 40 * u, by + h * 0.08, 'HOTEL', ac);
        for (let i = 0; i < 260; i++) body += `<circle cx="${f(r() * w)}" cy="${f(r() * h)}" r="${f(r.range(1, 3.2) * u)}" fill="#fff" opacity="${f(r.range(0.3, 0.9))}"/>`;
        body += `<rect x="0" y="${f(ground)}" width="${w}" height="${f(h - ground)}" fill="#e9edf5" opacity="0.85"/>`;
      } else if (motif === 'harbor') {
        body += `<rect x="0" y="${f(ground - h * 0.12)}" width="${w}" height="${f(h)}" fill="url(#${id}wet)"/>`;
        const lx = w * (focusX > 0.5 ? 0.78 : 0.22);
        body += `<path d="M${f(lx)} ${f(ground - h * 0.42)} L${f(lx + w * 0.6)} ${f(ground - h * 0.6)} L${f(lx + w * 0.6)} ${f(ground - h * 0.3)} Z" fill="${ac}" opacity="0.18" filter="url(#${id}bl)"/><path d="M${f(lx)} ${f(ground - h * 0.42)} L${f(lx - w * 0.6)} ${f(ground - h * 0.58)} L${f(lx - w * 0.6)} ${f(ground - h * 0.32)} Z" fill="${ac}" opacity="0.12" filter="url(#${id}bl)"/>`;
        body += `<g fill="#000"><path d="M${f(lx - 20 * u)} ${f(ground - h * 0.1)} L${f(lx - 12 * u)} ${f(ground - h * 0.4)} L${f(lx + 12 * u)} ${f(ground - h * 0.4)} L${f(lx + 20 * u)} ${f(ground - h * 0.1)} Z"/><rect x="${f(lx - 60 * u)}" y="${f(ground - h * 0.11)}" width="${f(120 * u)}" height="${f(h * 0.1)}"/></g><rect x="${f(lx - 10 * u)}" y="${f(ground - h * 0.435)}" width="${f(20 * u)}" height="${f(14 * u)}" fill="${ac}"/>`;
        // trawler
        const tx = fx;
        const ty = ground - h * 0.06;
        body += `<g fill="#000" transform="translate(${f(tx)} ${f(ty)}) scale(${f(u * 1.3)})"><path d="M-120 0 L120 0 L90 34 L-100 34 Z"/><rect x="-40" y="-50" width="70" height="50"/><rect x="-6" y="-150" width="5" height="100"/><line x1="-3" y1="-150" x2="-110" y2="0" stroke="#000" stroke-width="2"/><line x1="-3" y1="-150" x2="110" y2="0" stroke="#000" stroke-width="2"/></g><rect x="${f(tx - 30 * u)}" y="${f(ty - 50 * u)}" width="${f(16 * u)}" height="${f(12 * u)}" fill="${ac}" opacity="0.9"/>`;
        for (let i = 0; i < 70; i++) body += `<rect x="${f(r() * w)}" y="${f(ground + r() * (h - ground))}" width="${f(r.range(20, 100) * u)}" height="${f(2 * u)}" fill="${r() < 0.4 ? ac : lt}" opacity="${f(r.range(0.1, 0.4))}"/>`;
      } else {
        // rainy alley: buildings either side, a lamp and a figure
        const sideW = w * 0.22;
        for (const side of [0, 1]) {
          const x0 = side ? w - sideW : 0;
          body += `<rect x="${f(x0)}" y="${f(h * 0.05)}" width="${f(sideW)}" height="${f(h)}" fill="${mix(c0, c1, 0.5)}"/>`;
          for (let yy = h * 0.1; yy < ground - 40 * u; yy += 60 * u) for (let xx = x0 + 20 * u; xx < x0 + sideW - 30 * u; xx += 50 * u) if (r() < 0.25) body += `<rect x="${f(xx)}" y="${f(yy)}" width="${f(26 * u)}" height="${f(34 * u)}" fill="#ffcf7a" opacity="${f(r.range(0.5, 0.9))}"/>`;
        }
        const sx = focusX > 0.5 ? sideW + 20 * u : w - sideW - 20 * u;
        body += sign(sx, h * 0.14, motif === 'jazz' ? 'JAZZ' : 'BAR', ac);
        body += `<rect x="0" y="${f(ground)}" width="${w}" height="${f(h - ground)}" fill="url(#${id}wet)"/>`;
        body += `<rect x="${f(fx - w * 0.04)}" y="${f(ground)}" width="${f(w * 0.08)}" height="${f(h - ground)}" fill="${lt}" opacity="0.12" filter="url(#${id}bl)"/>`;
        body += `<rect x="${f(sx - 8 * u)}" y="${f(ground)}" width="${f(16 * u)}" height="${f(h - ground)}" fill="${ac}" opacity="0.35" filter="url(#${id}bl)"/>`;
      }
      // blinds of light, figure, rain
      let blinds = '';
      for (let i = 0; i < 16; i++) blinds += `<rect x="${f(-w * 0.5)}" y="${f(i * h * 0.06)}" width="${f(w * 2)}" height="${f(h * 0.028)}" fill="${lt}"/>`;
      if (motif !== 'curtain' && motif !== 'hotel' && motif !== 'harbor') {
        body += `<g opacity="0.07" transform="rotate(-24 ${w / 2} ${h / 2})" filter="url(#${id}bl)">${blinds}</g>`;
        body += figure(fx, ground + 4 * u, h * (P ? 0.36 : 0.42), '#000');
        body += `<path d="M${f(fx - 6 * u)} ${f(ground + 4 * u)} L${f(fx + 6 * u)} ${f(ground + 4 * u)} L${f(fx + w * 0.05)} ${h} L${f(fx - w * 0.05)} ${h} Z" fill="#000" opacity="0.5"/>`;
      }
      let rain = '';
      for (let i = 0; i < 300; i++) {
        const x = r() * w;
        const y = r() * h;
        const l = r.range(h * 0.015, h * 0.04);
        rain += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x - l * 0.18)}" y2="${f(y + l)}" stroke="${lt}" stroke-width="${f(1.2 * u)}" opacity="${f(r.range(0.08, 0.3))}"/>`;
      }
      if (motif !== 'curtain' && motif !== 'hotel') body += rain;
      break;
    }
    case 'drama': {
      defs += `<linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${lt}"/><stop offset="0.45" stop-color="${ac}"/><stop offset="0.8" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></linearGradient>
        <radialGradient id="${id}sun"><stop offset="0" stop-color="#fff" stop-opacity="0.95"/><stop offset="0.3" stop-color="${lt}" stop-opacity="0.85"/><stop offset="1" stop-color="${ac}" stop-opacity="0"/></radialGradient>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}sky)"/>`;
      const sr = Math.min(w, h) * 0.42;
      body += `<circle cx="${f(fx)}" cy="${f(h * 0.56)}" r="${f(sr)}" fill="url(#${id}sun)"/>`;
      const layers = 5;
      for (let i = 0; i < layers; i++) {
        const t = i / (layers - 1);
        const y = h * (0.6 + t * 0.26);
        body += `<path d="${ridge(r, w, h, y, h * (0.12 - t * 0.06), 5 + i)}" fill="${mix(c1, c0, t)}" opacity="${f(0.55 + t * 0.45)}"/>`;
        if (motif === 'grove' && i === 2) {
          for (let k = 0; k < 9; k++) {
            const tx = w * (0.05 + k * 0.115) + r.range(-10, 10) * u;
            const ty = y - h * 0.02;
            const tr = r.range(34, 52) * u;
            body += `<rect x="${f(tx - 4 * u)}" y="${f(ty)}" width="${f(8 * u)}" height="${f(h * 0.08)}" fill="${c0}"/><circle cx="${f(tx)}" cy="${f(ty - tr * 0.4)}" r="${f(tr)}" fill="${mix(c1, c0, 0.4)}"/>`;
            for (let q = 0; q < 6; q++) body += `<circle cx="${f(tx + r.range(-0.7, 0.7) * tr)}" cy="${f(ty - tr * 0.4 + r.range(-0.7, 0.6) * tr)}" r="${f(5 * u)}" fill="${ac}"/>`;
          }
        }
        if (motif === 'street' && i === 3) {
          let x = 0;
          while (x < w) {
            const hw = r.range(70, 120) * u;
            const hh = r.range(90, 150) * u;
            body += `<path d="M${f(x)} ${f(y + 20 * u)} L${f(x)} ${f(y - hh)} L${f(x + hw / 2)} ${f(y - hh - 40 * u)} L${f(x + hw)} ${f(y - hh)} L${f(x + hw)} ${f(y + 20 * u)} Z" fill="${mix(c1, c0, 0.7)}"/>`;
            if (r() < 0.7) body += `<rect x="${f(x + hw * 0.35)}" y="${f(y - hh * 0.6)}" width="${f(hw * 0.3)}" height="${f(hh * 0.3)}" fill="${lt}" opacity="0.9"/>`;
            x += hw + 6 * u;
          }
        }
      }
      if (motif === 'kites') {
        for (let i = 0; i < 4; i++) {
          const kx = w * (0.15 + i * 0.22) + r.range(-20, 20) * u;
          const ky = h * r.range(0.12, 0.34);
          const s = r.range(28, 44) * u;
          const col = [ac, '#e63946', '#457b9d', '#ffffff'][i];
          body += `<g transform="rotate(${f(r.range(-20, 20))} ${f(kx)} ${f(ky)})"><path d="M${f(kx)} ${f(ky - s)} L${f(kx + s * 0.7)} ${f(ky)} L${f(kx)} ${f(ky + s * 1.3)} L${f(kx - s * 0.7)} ${f(ky)} Z" fill="${col}" stroke="${c0}" stroke-width="${f(2 * u)}"/><path d="M${f(kx)} ${f(ky + s * 1.3)} q${f(20 * u)} ${f(40 * u)} 0 ${f(80 * u)} t0 ${f(80 * u)}" stroke="${c0}" stroke-width="${f(1.5 * u)}" fill="none"/></g><line x1="${f(kx)}" y1="${f(ky + s * 1.3)}" x2="${f(w * 0.5)}" y2="${h}" stroke="${c0}" stroke-width="${f(1 * u)}" opacity="0.5"/>`;
        }
      } else {
        for (let i = 0; i < 7; i++) {
          const bx = w * r.range(0.1, 0.9);
          const by = h * r.range(0.12, 0.42);
          const s = r.range(6, 14) * u;
          body += `<path d="M${f(bx - s)} ${f(by)} Q${f(bx - s / 2)} ${f(by - s * 0.6)} ${f(bx)} ${f(by)} Q${f(bx + s / 2)} ${f(by - s * 0.6)} ${f(bx + s)} ${f(by)}" stroke="${c0}" stroke-width="${f(1.5 * u)}" fill="none" opacity="0.7"/>`;
        }
      }
      break;
    }
    case 'family': {
      defs += `<linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.7" stop-color="${c1}"/><stop offset="1" stop-color="${lt}"/></linearGradient>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}sky)"/>${stars(r, w, h, 70, 0.55)}`;
      const mr = Math.min(w, h) * 0.22;
      const my = h * (P ? 0.42 : 0.34);
      if (motif !== 'socks') {
        body += `<circle cx="${f(fx)}" cy="${f(my)}" r="${f(mr * 1.35)}" fill="${ac}" opacity="0.25"/><circle cx="${f(fx)}" cy="${f(my)}" r="${f(mr)}" fill="${ac}"/>`;
        for (let i = 0; i < 5; i++) body += `<circle cx="${f(fx + r.range(-0.6, 0.6) * mr)}" cy="${f(my + r.range(-0.6, 0.6) * mr)}" r="${f(r.range(0.08, 0.18) * mr)}" fill="#000" opacity="0.08"/>`;
      }
      for (let i = 0; i < 4; i++) {
        const cx = w * [0.1, 0.35, 0.68, 0.92][i] + r.range(-20, 20) * u;
        const cy = h * r.range(0.6, 0.68);
        const s = r.range(0.05, 0.08) * w;
        body += `<g fill="#fff" opacity="${f(r.range(0.8, 0.95))}"><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(s)}"/><circle cx="${f(cx + s)}" cy="${f(cy + s * 0.2)}" r="${f(s * 0.8)}"/><circle cx="${f(cx - s)}" cy="${f(cy + s * 0.25)}" r="${f(s * 0.7)}"/><rect x="${f(cx - s * 1.7)}" y="${f(cy + s * 0.2)}" width="${f(s * 3.4)}" height="${f(s * 0.75)}" rx="${f(s * 0.37)}"/></g>`;
      }
      const hills = motif === 'socks' ? [mix(c1, '#ffffff', 0.2), c2(c1), mix(c1, '#000000', 0.15)] : [mix(ac, '#3bb273', 0.7), '#2fa866', '#1f8a55'];
      hills.forEach((c, i) => {
        body += `<path d="${ridge(r, w, h, h * (0.78 + i * 0.07), h * 0.07, 3)}" fill="${c}"/>`;
      });
      if (motif === 'socks') {
        const sock = (x, y, s, rot, col, stripe) => `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(s)})"><path d="M-30 -90 L30 -90 L30 10 Q30 40 60 40 L80 40 Q100 40 100 60 Q100 84 76 84 L10 84 Q-30 84 -30 40 Z" fill="${col}" stroke="#00000033" stroke-width="4"/><rect x="-30" y="-90" width="60" height="22" fill="${stripe}"/><rect x="-30" y="-56" width="60" height="10" fill="${stripe}"/><circle cx="76" cy="62" r="10" fill="${stripe}" opacity=".6"/></g>`;
        const cols = ['#ff5e5b', '#ffb84c', '#2ec4b6', '#7b2cbf', '#ffffff', '#3a86ff'];
        for (let i = 0; i < 7; i++) body += sock(w * (0.12 + i * 0.13), h * r.range(0.45, 0.62), u * r.range(0.8, 1.3), r.range(-40, 40), cols[i % cols.length], cols[(i + 2) % cols.length]);
        body += `<g transform="translate(${f(fx)} ${f(h * (P ? 0.5 : 0.38))}) scale(${f(u * 1.1)})"><path d="M-60 -40 L-40 -80 L-20 -50 L0 -90 L20 -50 L40 -80 L60 -40 Z" fill="${ac}" stroke="#000" stroke-opacity=".2" stroke-width="4"/></g>`;
      } else {
        const tx = w * (focusX > 0.5 ? 0.22 : 0.78);
        body += `<g fill="${c0}"><rect x="${f(tx - 24 * u)}" y="${f(h * 0.6)}" width="${f(48 * u)}" height="${f(h * 0.22)}"/><path d="M${f(tx - 36 * u)} ${f(h * 0.6)} L${f(tx)} ${f(h * 0.6 - 60 * u)} L${f(tx + 36 * u)} ${f(h * 0.6)} Z"/></g><circle cx="${f(tx)}" cy="${f(h * 0.6 + 30 * u)}" r="${f(14 * u)}" fill="${lt}"/>`;
        // little rocket / machine heading for the moon
        body += `<g transform="translate(${f(fx - mr * 1.4)} ${f(my + mr * 1.1)}) rotate(-35) scale(${f(u)})"><path d="M0 -60 Q22 -30 18 20 L-18 20 Q-22 -30 0 -60 Z" fill="#fff"/><circle cy="-15" r="9" fill="${c1}"/><path d="M-18 8 L-32 30 L-18 22 Z M18 8 L32 30 L18 22 Z" fill="#ff5e5b"/><path d="M-10 22 L0 50 L10 22 Z" fill="${ac}"/></g>`;
      }
      for (let i = 0; i < 40; i++) body += `<rect x="${f(r() * w)}" y="${f(r() * h * 0.7)}" width="${f(r.range(4, 10) * u)}" height="${f(r.range(8, 16) * u)}" rx="2" fill="${r.pick([ac, lt, '#ff5e5b', '#2ec4b6', '#ffb84c'])}" transform="rotate(${f(r.range(0, 180))} ${f(r() * w)} ${f(r() * h)})" opacity="0.85"/>`;
      break;
    }
    case 'horror': {
      defs += `<radialGradient id="${id}bg" cx="${focusX}" cy="0.35" r="0.75"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></radialGradient>
        <radialGradient id="${id}moon"><stop offset="0" stop-color="${lt}"/><stop offset="0.7" stop-color="${lt}" stop-opacity="0.9"/><stop offset="1" stop-color="${lt}" stop-opacity="0"/></radialGradient>
        <radialGradient id="${id}vig" cx="0.5" cy="0.5" r="0.75"><stop offset="0.55" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.85"/></radialGradient>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}bg)"/>${stars(r, w, h, 40, 0.5, 0.5)}`;
      const ground = h * 0.86;
      const mr = Math.min(w, h) * 0.2;
      if (motif !== 'bloom') body += `<circle cx="${f(fx)}" cy="${f(h * 0.3)}" r="${f(mr * 1.6)}" fill="${lt}" opacity="0.12" filter="url(#${id}bl2)"/><circle cx="${f(fx)}" cy="${f(h * 0.3)}" r="${f(mr)}" fill="url(#${id}moon)"/>`;
      body += `<path d="${ridge(r, w, h, ground, h * 0.04, 5)}" fill="#020202"/>`;
      if (motif === 'birch') {
        for (let i = 0; i < 9; i++) {
          const tx = w * (0.04 + i * 0.12) + r.range(-15, 15) * u;
          if (Math.abs(tx - fx) < w * 0.1) continue;
          const tw = r.range(12, 22) * u;
          body += `<rect x="${f(tx)}" y="0" width="${f(tw)}" height="${f(ground)}" fill="#d9dedd" opacity="${f(r.range(0.55, 0.9))}"/>`;
          for (let k = 0; k < 12; k++) body += `<rect x="${f(tx + (r() < 0.5 ? 0 : tw * 0.4))}" y="${f(r() * ground)}" width="${f(tw * 0.6)}" height="${f(3 * u)}" fill="#111"/>`;
        }
        const hx = fx;
        body += `<path d="M${f(hx - 90 * u)} ${f(ground)} L${f(hx - 90 * u)} ${f(ground - 110 * u)} L${f(hx)} ${f(ground - 190 * u)} L${f(hx + 90 * u)} ${f(ground - 110 * u)} L${f(hx + 90 * u)} ${f(ground)} Z" fill="#030303"/><rect x="${f(hx - 14 * u)}" y="${f(ground - 90 * u)}" width="${f(28 * u)}" height="${f(36 * u)}" fill="${ac}"/><rect x="${f(hx - 30 * u)}" y="${f(ground - 100 * u)}" width="${f(60 * u)}" height="${f(56 * u)}" fill="${ac}" opacity="0.35" filter="url(#${id}bl)"/>`;
      } else if (motif === 'chapel') {
        const cx = fx;
        body += `<g fill="#030303"><path d="M${f(cx - 120 * u)} ${f(ground)} L${f(cx - 120 * u)} ${f(ground - 160 * u)} L${f(cx)} ${f(ground - 260 * u)} L${f(cx + 120 * u)} ${f(ground - 160 * u)} L${f(cx + 120 * u)} ${f(ground)} Z"/><rect x="${f(cx + 70 * u)}" y="${f(ground - 340 * u)}" width="${f(60 * u)}" height="${f(340 * u)}"/><path d="M${f(cx + 62 * u)} ${f(ground - 340 * u)} L${f(cx + 100 * u)} ${f(ground - 440 * u)} L${f(cx + 138 * u)} ${f(ground - 340 * u)} Z"/></g><circle cx="${f(cx)}" cy="${f(ground - 165 * u)}" r="${f(36 * u)}" fill="${ac}"/><circle cx="${f(cx)}" cy="${f(ground - 165 * u)}" r="${f(70 * u)}" fill="${ac}" opacity="0.4" filter="url(#${id}bl)"/>${Array.from({ length: 8 }, (_, i) => `<line x1="${f(cx)}" y1="${f(ground - 165 * u)}" x2="${f(cx + Math.cos(i * Math.PI / 4) * 36 * u)}" y2="${f(ground - 165 * u + Math.sin(i * Math.PI / 4) * 36 * u)}" stroke="#030303" stroke-width="${f(4 * u)}"/>`).join('')}<path d="M${f(cx - 22 * u)} ${f(ground)} L${f(cx - 22 * u)} ${f(ground - 60 * u)} Q${f(cx)} ${f(ground - 90 * u)} ${f(cx + 22 * u)} ${f(ground - 60 * u)} L${f(cx + 22 * u)} ${f(ground)} Z" fill="${ac}" opacity="0.6"/>`;
        for (let i = 0; i < 4; i++) {
          const tx = i < 2 ? w * (0.06 + i * 0.12) : w * (0.82 + (i - 2) * 0.12);
          body += tree(r, tx, ground + 4, h * r.range(0.13, 0.2), -Math.PI / 2 + r.range(-0.12, 0.12), 8, '#020202', w * 0.01);
        }
      } else if (motif === 'bloom') {
        // arctic station, mast, glowing spores
        body += `<circle cx="${f(fx)}" cy="${f(h * 0.62)}" r="${f(mr * 2.4)}" fill="${ac}" opacity="0.18" filter="url(#${id}bl2)"/>`;
        body += `<g fill="#020202"><rect x="${f(fx - 160 * u)}" y="${f(ground - 70 * u)}" width="${f(320 * u)}" height="${f(70 * u)}"/><path d="M${f(fx - 160 * u)} ${f(ground - 70 * u)} Q${f(fx)} ${f(ground - 130 * u)} ${f(fx + 160 * u)} ${f(ground - 70 * u)} Z"/><rect x="${f(fx + 110 * u)}" y="${f(ground - 380 * u)}" width="${f(8 * u)}" height="${f(320 * u)}"/></g><circle cx="${f(fx + 114 * u)}" cy="${f(ground - 384 * u)}" r="${f(7 * u)}" fill="${ac}"/>`;
        for (let i = 0; i < 18; i++) {
          let d = `M${f(fx + r.range(-150, 150) * u)} ${f(ground - 20 * u)}`;
          let x = fx + r.range(-150, 150) * u;
          let y = ground - 20 * u;
          for (let k = 0; k < 6; k++) {
            x += r.range(-40, 40) * u;
            y -= r.range(20, 60) * u;
            d += ` Q${f(x + r.range(-30, 30) * u)} ${f(y + 20 * u)} ${f(x)} ${f(y)}`;
          }
          body += `<path d="${d}" stroke="${ac}" stroke-width="${f(r.range(1.5, 4) * u)}" fill="none" opacity="0.75"/>`;
        }
        for (let i = 0; i < 160; i++) body += `<circle cx="${f(fx + r.range(-0.5, 0.5) * w)}" cy="${f(r.range(0.15, 0.9) * h)}" r="${f(r.range(1, 4) * u)}" fill="${ac}" opacity="${f(r.range(0.2, 0.9))}"/>`;
      } else {
        const nTrees = P ? 3 : 5;
        for (let i = 0; i < nTrees; i++) {
          const tx = w * (0.08 + (0.84 * i) / Math.max(1, nTrees - 1)) + r.range(-30, 30);
          body += tree(r, tx, ground, h * r.range(0.13, 0.2), -Math.PI / 2 + r.range(-0.12, 0.12), 8, '#020202', w * 0.012);
        }
      }
      for (let i = 0; i < 4; i++) body += `<ellipse cx="${f(w * r.range(0.1, 0.9))}" cy="${f(h * r.range(0.8, 0.95))}" rx="${f(w * r.range(0.3, 0.6))}" ry="${f(h * 0.04)}" fill="${lt}" opacity="0.12" filter="url(#${id}bl2)"/>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}vig)"/>`;
      break;
    }
    case 'action': {
      defs += `<linearGradient id="${id}sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset="0.5" stop-color="${c1}"/><stop offset="0.78" stop-color="${ac}"/><stop offset="1" stop-color="${c0}"/></linearGradient>
        <radialGradient id="${id}boom" cx="${focusX}" cy="0.72" r="0.5"><stop offset="0" stop-color="${lt}"/><stop offset="0.25" stop-color="${ac}"/><stop offset="1" stop-color="${ac}" stop-opacity="0"/></radialGradient>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}sky)"/><rect width="${w}" height="${h}" fill="url(#${id}boom)" opacity="0.85"/>`;
      body += `<path d="${ridge(r, w, h, h * 0.76, h * 0.12, 7, false)}" fill="${mix(c0, c1, 0.3)}"/>`;
      const ty = h * 0.8;
      body += `<rect x="0" y="${f(ty)}" width="${w}" height="${f(h * 0.012)}" fill="#000"/>`;
      for (let i = 0; i < 16; i++) body += `<rect x="${f(w * 0.02 + i * w * 0.075)}" y="${f(ty - h * 0.045)}" width="${f(w * 0.07)}" height="${f(h * 0.042)}" rx="3" fill="#000"/>`;
      for (let i = 0; i < 14; i++) body += `<rect x="${f(i * w * 0.08)}" y="${f(ty)}" width="${f(w * 0.01)}" height="${f(h)}" fill="#000"/>`;
      body += `<rect x="0" y="${f(h * 0.86)}" width="${w}" height="${f(h * 0.14)}" fill="#000"/>`;
      for (let i = 0; i < 3; i++) body += `<rect x="${f(w * r.range(-0.2, 0.8))}" y="${f(-h * 0.1)}" width="${f(w * 0.05)}" height="${f(h * 1.4)}" fill="${ac}" opacity="0.08" transform="rotate(28 ${w / 2} ${h / 2})"/>`;
      for (let i = 0; i < 140; i++) {
        const x = fx + r.range(-0.4, 0.4) * w;
        const y = h * 0.72 + r.range(-0.4, 0.15) * h;
        body += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + r.range(-8, 8) * u)}" y2="${f(y - r.range(4, 18) * u)}" stroke="${r() < 0.5 ? lt : ac}" stroke-width="${f(r.range(1, 2.5) * u)}" opacity="${f(r.range(0.4, 1))}" stroke-linecap="round"/>`;
      }
      break;
    }
    case 'adventure': {
      defs += `<radialGradient id="${id}bg" cx="0.5" cy="0.45" r="0.8"><stop offset="0" stop-color="${lt}"/><stop offset="0.7" stop-color="${mix(lt, ac, 0.45)}"/><stop offset="1" stop-color="${c1}"/></radialGradient>`;
      body += `<rect width="${w}" height="${h}" fill="url(#${id}bg)"/>`;
      const iy = h * (P ? 0.38 : 0.5);
      for (let k = 0; k < 7; k++) {
        const rr = Math.min(w, h) * (0.3 - k * 0.038);
        let d = '';
        const n = 24;
        for (let i = 0; i <= n; i++) {
          const a = (i / n) * Math.PI * 2;
          const rad = rr * (1 + 0.16 * Math.sin(a * 3 + k * 0.4) + 0.07 * Math.cos(a * 5 + 1));
          d += `${i ? 'L' : 'M'}${f(fx + Math.cos(a) * rad * 1.25)} ${f(iy + Math.sin(a) * rad)}`;
        }
        body += `<path d="${d}Z" fill="${k === 6 ? ac : 'none'}" stroke="${c1}" stroke-width="${f((k === 0 ? 3 : 1.5) * u)}" opacity="${k === 6 ? 0.5 : 0.55}" stroke-linejoin="round"/>`;
      }
      for (let i = 0; i < 50; i++) {
        const x = r() * w;
        const y = r() * h;
        if (Math.hypot(x - fx, y - iy) < Math.min(w, h) * 0.42) continue;
        body += `<path d="M${f(x)} ${f(y)} q${f(8 * u)} ${f(-6 * u)} ${f(16 * u)} 0 q${f(8 * u)} ${f(6 * u)} ${f(16 * u)} 0" stroke="${c1}" stroke-width="${f(1.6 * u)}" fill="none" opacity="0.45"/>`;
      }
      const ex = fx + w * 0.06;
      const ey = iy - h * 0.02;
      body += `<path d="M${f(w * 0.04)} ${f(h * 0.96)} C${f(w * 0.3)} ${f(h * 0.75)} ${f(w * 0.12)} ${f(iy + h * 0.1)} ${f(ex)} ${f(ey)}" stroke="#8a1c1c" stroke-width="${f(4 * u)}" stroke-dasharray="${f(12 * u)} ${f(10 * u)}" fill="none"/>`;
      body += `<g stroke="#8a1c1c" stroke-width="${f(7 * u)}" stroke-linecap="round"><line x1="${f(ex - 16 * u)}" y1="${f(ey - 16 * u)}" x2="${f(ex + 16 * u)}" y2="${f(ey + 16 * u)}"/><line x1="${f(ex + 16 * u)}" y1="${f(ey - 16 * u)}" x2="${f(ex - 16 * u)}" y2="${f(ey + 16 * u)}"/></g>`;
      const cx = w * (focusX > 0.5 ? 0.16 : 0.84);
      const cy = h * 0.16;
      const cr = 60 * u;
      body += `<g fill="${c1}" opacity="0.8"><circle cx="${f(cx)}" cy="${f(cy)}" r="${f(cr)}" fill="none" stroke="${c1}" stroke-width="${f(2 * u)}"/>${[0, 90, 180, 270].map((a) => `<path d="M${f(cx)} ${f(cy - cr * 1.3)} L${f(cx + cr * 0.18)} ${f(cy)} L${f(cx - cr * 0.18)} ${f(cy)} Z" transform="rotate(${a} ${f(cx)} ${f(cy)})"/>`).join('')}</g>`;
      // a tall ship
      const sx = w * (focusX > 0.5 ? 0.2 : 0.8);
      body += `<g fill="${c1}" opacity="0.85" transform="translate(${f(sx)} ${f(h * 0.78)}) scale(${f(u)})"><path d="M-70 0 L70 0 L50 26 L-55 26 Z"/><rect x="-3" y="-120" width="5" height="120"/><path d="M5 -110 Q50 -70 5 -20 Z"/><path d="M-5 -100 Q-45 -60 -5 -20 Z"/></g>`;
      body += `<rect width="${w}" height="${h}" fill="none" stroke="${c1}" stroke-width="${f(16 * u)}" opacity="0.35"/>`;
      break;
    }
    case 'comedy': {
      body += `<rect width="${w}" height="${h}" fill="${c0}"/>`;
      let rays = '';
      const cy = h * (P ? 0.55 : 0.45);
      for (let i = 0; i < 24; i += 2) {
        const a1 = (i / 24) * Math.PI * 2;
        const a2 = ((i + 1) / 24) * Math.PI * 2;
        const R = Math.max(w, h) * 1.2;
        rays += `<path d="M${f(fx)} ${f(cy)} L${f(fx + Math.cos(a1) * R)} ${f(cy + Math.sin(a1) * R)} L${f(fx + Math.cos(a2) * R)} ${f(cy + Math.sin(a2) * R)} Z"/>`;
      }
      body += `<g fill="#fff" opacity="0.25">${rays}</g>`;
      let dots = '';
      const step = w / 40;
      for (let y = h * 0.7; y < h; y += step) for (let x = 0; x < w; x += step) dots += `<circle cx="${f(x)}" cy="${f(y)}" r="${f(((y - h * 0.7) / (h * 0.3)) * step * 0.42)}"/>`;
      body += `<g fill="${c1}" opacity="0.55">${dots}</g>`;
      body += `<circle cx="${f(w * 0.86)}" cy="${f(h * (P ? 0.5 : 0.18))}" r="${f(50 * u)}" fill="${ac}"/><circle cx="${f(w * 0.12)}" cy="${f(h * 0.68)}" r="${f(34 * u)}" fill="${c1}"/>`;
      if (motif === 'bakery') {
        const crois = (x, y, s, rot) => `<g transform="translate(${f(x)} ${f(y)}) rotate(${f(rot)}) scale(${f(s)})"><path d="M-90 10 Q-60 -60 0 -62 Q60 -60 90 10 Q60 -10 40 0 Q20 -30 0 -30 Q-20 -30 -40 0 Q-60 -10 -90 10 Z" fill="#e9a03b" stroke="#8a4b12" stroke-width="5"/><path d="M-40 0 Q-30 -40 0 -40 M40 0 Q30 -40 0 -40" stroke="#8a4b12" stroke-width="4" fill="none"/></g>`;
        body += crois(fx, cy, u * 2.2, -8) + crois(fx - w * 0.28, cy + h * 0.14, u * 1.1, 20) + crois(fx + w * 0.3, cy + h * 0.12, u * 1.2, -24);
        for (let i = 0; i < 26; i++) body += `<circle cx="${f(r() * w)}" cy="${f(r() * h * 0.6)}" r="${f(r.range(2, 5) * u)}" fill="#fff" opacity="0.8"/>`;
      } else {
        body += `<g fill="none" stroke="${lt}" stroke-width="${f(14 * u)}"><circle cx="${f(fx - 40 * u)}" cy="${f(cy)}" r="${f(72 * u)}"/><circle cx="${f(fx + 40 * u)}" cy="${f(cy)}" r="${f(72 * u)}"/></g>`;
      }
      break;
    }
    default:
      body += `<rect width="${w}" height="${h}" fill="${c0}"/>`;
  }
  return `<svg class="scene" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid slice"><defs>${defs}</defs>${body}</svg>`;
}
const c2 = (c) => mix(c, '#ffffff', 0.45);

/** Hex colour mix. */
function mix(a, b, t) {
  const p = (c) => [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
}

/* ------------------------------------------------------------------ */
/* Title typography per style                                          */
/* ------------------------------------------------------------------ */

function titleCss(style, pal) {
  const [c0, c1, ac, lt] = pal;
  switch (style) {
    case 'scifi': return `font-family:${FONT.scifi};font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:#fff;text-shadow:0 0 8px ${ac},0 0 24px ${ac},0 0 60px ${ac};`;
    case 'noir': return `font-family:${FONT.noir};font-weight:400;text-transform:uppercase;letter-spacing:.04em;color:${lt};text-shadow:0 4px 30px #000;`;
    case 'drama': return `font-family:${FONT.drama};font-weight:700;letter-spacing:.02em;color:#fff;text-shadow:0 2px 24px ${c0}aa;`;
    case 'family': return `font-family:${FONT.family};font-weight:700;color:#fff;-webkit-text-stroke:.09em ${c0};paint-order:stroke fill;text-shadow:0 .08em 0 ${c0};letter-spacing:.01em;`;
    case 'horror': return `font-family:${FONT.horror};font-weight:800;text-transform:uppercase;letter-spacing:.14em;color:${lt};text-shadow:0 0 18px ${ac},0 0 50px ${ac}88;`;
    case 'action': return `font-family:${FONT.action};font-weight:400;text-transform:uppercase;letter-spacing:.03em;background:linear-gradient(180deg,#fff 0%,${lt} 45%,${ac} 100%);-webkit-background-clip:text;background-clip:text;color:transparent;filter:drop-shadow(0 6px 18px #000a);`;
    case 'adventure': return `font-family:${FONT.adventure};font-weight:800;text-transform:uppercase;letter-spacing:.06em;color:${c0};text-shadow:0 2px 0 ${lt};`;
    case 'comedy': return `font-family:${FONT.comedy};color:${lt};letter-spacing:.01em;text-shadow:.05em .05em 0 ${c1};`;
    default: return `font-family:${FONT.sans};font-weight:700;color:#fff;`;
  }
}

/* ------------------------------------------------------------------ */
/* Public templates                                                    */
/* ------------------------------------------------------------------ */

const BASE_CSS = `
.art{position:relative;overflow:hidden;width:100%;height:100%}
.art .scene{position:absolute;inset:0;width:100%;height:100%}
.grain{position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:overlay;pointer-events:none}
.fit{display:block}
`;

export function posterHtml(it, opts = {}) {
  const { style, pal } = it;
  const [c0, , ac, lt] = pal;
  const dark = !['adventure', 'comedy'].includes(style);
  const ink = dark ? '#fff' : c0;
  const credits = [it.studio?.toUpperCase(), 'PRESENTS', it.director ? `A ${it.director.toUpperCase()} FILM` : null, ...(it.cast ?? []).slice(0, 4).map((c) => c.name.toUpperCase())].filter(Boolean).join('   ');
  const top = (it.cast ?? []).slice(0, 2).map((c) => c.name.toUpperCase()).join('   ·   ');
  const label = opts.label ?? it.tagline;
  const titleTop = ['scifi', 'family', 'comedy'].includes(style);
  return `<div class="art poster" style="background:${c0}">
    ${scene(style, pal, 800, 1200, it.slug + (opts.seed ?? ''), { poster: true, focusX: 0.5, motif: it.motif })}
    <div style="position:absolute;inset:0;background:linear-gradient(180deg,${dark ? '#0008' : '#0000'} 0%,#0000 22%,#0000 58%,${dark ? c0 + 'ee' : '#0000'} 100%)"></div>
    <div style="position:absolute;top:44px;left:0;right:0;text-align:center;font:500 22px/1 ${FONT.condensed};letter-spacing:.28em;color:${ink};opacity:.85;white-space:nowrap">${esc(top)}</div>
    <div class="title-box" style="position:absolute;left:56px;right:56px;${titleTop ? 'top:120px' : 'bottom:220px'};height:${titleTop ? 300 : 330}px;display:flex;align-items:${titleTop ? 'flex-start' : 'flex-end'};justify-content:center;text-align:center">
      <div class="fit" data-max="150" data-min="40" style="${titleCss(style, pal)};line-height:.98;width:100%">${esc(it.title)}</div>
    </div>
    ${opts.badge ? `<div style="position:absolute;left:0;right:0;bottom:250px;text-align:center"><span style="display:inline-block;padding:12px 28px;border-radius:999px;background:${ac};color:${c0};font:700 30px/1 ${FONT.sans};letter-spacing:.18em;text-transform:uppercase;box-shadow:0 10px 30px #0006">${esc(opts.badge)}</span></div>` : ''}
    <div style="position:absolute;left:70px;right:70px;bottom:${titleTop ? 150 : 150}px;text-align:center;font:${style === 'drama' || style === 'noir' ? `italic 500 34px/1.25 ${FONT.drama}` : `500 26px/1.3 ${FONT.sans}`};color:${ink};opacity:.92;text-shadow:${dark ? '0 2px 12px #000' : 'none'}">${esc(label ?? '')}</div>
    <div style="position:absolute;left:60px;right:60px;bottom:58px;text-align:center;font:400 15px/1.5 ${FONT.condensed};letter-spacing:.12em;color:${ink};opacity:.6">${esc(credits)}</div>
    <div style="position:absolute;left:0;right:0;bottom:30px;text-align:center;font:600 14px/1 ${FONT.condensed};letter-spacing:.4em;color:${lt};opacity:.75">${it.year ? (opts.tv ? `NOW STREAMING · ${it.year}` : `IN CINEMAS · ${it.year}`) : ''}</div>
    ${grain(0.16)}
  </div>`;
}

export function backdropHtml(it, opts = {}) {
  const [c0] = it.pal;
  return `<div class="art" style="background:${c0}">${scene(it.style, it.pal, opts.w ?? 1920, opts.h ?? 1080, it.slug + (opts.seed ?? '-bd'), { focusX: opts.focusX ?? 0.68, motif: it.motif })}${grain(0.12)}</div>`;
}

export function logoHtml(it) {
  return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:20px 30px;box-sizing:border-box">
    <div class="fit" data-max="180" data-min="40" style="${titleCss(it.style, it.pal)};line-height:.95;text-align:center;width:100%">${esc(it.title)}</div></div>`;
}

export function headshotHtml(name) {
  const r = rng(name);
  const hue = Math.floor(r() * 360);
  const skin = r.pick(['#5a3d2e', '#7a5440', '#9a6b50', '#b98668', '#d3a487', '#e2b99a']);
  const hair = r.pick(['#141010', '#2b1d14', '#4a3020', '#6b4a2e', '#1a1a22', '#8a6a4a', '#b07a3c']);
  const style = r.int(0, 3);
  const top = mix(hue2hex(hue, 0.45, 0.55), '#ffffff', 0.1);
  const shirt = hue2hex((hue + 180) % 360, 0.3, 0.3);
  const hairBack = style === 1 ? `<path d="M116 240 Q104 120 200 108 Q296 120 284 240 L304 430 Q200 462 96 430 Z" fill="${hair}"/>` : style === 3 ? `<circle cx="200" cy="128" r="42" fill="${hair}"/>` : '';
  const hairTop = style === 2
    ? `<path d="M120 236 Q116 162 200 158 Q284 162 280 236 Q270 196 200 194 Q130 196 120 236 Z" fill="${hair}" opacity=".85"/>`
    : `<path d="M116 250 Q108 146 200 142 Q292 146 284 250 Q276 196 236 186 Q200 214 150 196 Q124 210 116 250 Z" fill="${hair}"/>`;
  return `<div class="art" style="background:radial-gradient(circle at 50% 30%,${top},${hue2hex((hue + 25) % 360, 0.5, 0.16)})">
    <svg viewBox="0 0 400 600" width="100%" height="100%" class="scene">
      <defs><radialGradient id="face" cx=".42" cy=".38" r=".75"><stop offset="0" stop-color="${mix(skin, '#ffffff', 0.15)}"/><stop offset="1" stop-color="${mix(skin, '#000000', 0.22)}"/></radialGradient>
      <linearGradient id="sh" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${mix(shirt, '#ffffff', 0.12)}"/><stop offset="1" stop-color="${mix(shirt, '#000000', 0.4)}"/></linearGradient></defs>
      ${hairBack}
      <path d="M30 600 Q40 452 200 432 Q360 452 370 600 Z" fill="url(#sh)"/>
      <path d="M160 440 L200 492 L240 440 Z" fill="${mix(shirt, '#ffffff', 0.5)}" opacity=".5"/>
      <rect x="170" y="330" width="60" height="112" rx="26" fill="${mix(skin, '#000000', 0.18)}"/>
      <ellipse cx="117" cy="270" rx="13" ry="22" fill="${mix(skin, '#000000', 0.1)}"/><ellipse cx="283" cy="270" rx="13" ry="22" fill="${mix(skin, '#000000', 0.1)}"/>
      <ellipse cx="200" cy="262" rx="84" ry="104" fill="url(#face)"/>
      <path d="M150 238 q16 -9 32 0 M218 238 q16 -9 32 0" stroke="${mix(hair, '#000000', 0.3)}" stroke-width="5" fill="none" stroke-linecap="round"/>
      <ellipse cx="166" cy="262" rx="7" ry="8" fill="#1b1410"/><ellipse cx="234" cy="262" rx="7" ry="8" fill="#1b1410"/>
      <circle cx="168.5" cy="259" r="2" fill="#fff" opacity=".8"/><circle cx="236.5" cy="259" r="2" fill="#fff" opacity=".8"/>
      <path d="M200 270 q-8 24 2 30" stroke="${mix(skin, '#000000', 0.3)}" stroke-width="3" fill="none" stroke-linecap="round"/>
      <path d="M176 318 q24 ${r() < 0.6 ? 16 : 8} 48 0" stroke="${mix(skin, '#5a1a1a', 0.55)}" stroke-width="5" fill="none" stroke-linecap="round"/>
      ${hairTop}
    </svg>${grain(0.08)}</div>`;
}

function hue2hex(h, s, l) {
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const fn = (n) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1))))).toString(16).padStart(2, '0');
  return `#${fn(0)}${fn(8)}${fn(4)}`;
}

export function seasonLabel(n) {
  return `Season ${n}`;
}

/* ---------------- Music ---------------- */

export function albumCoverHtml(a) {
  const [c0, c1, c2, lt] = a.pal;
  const r = rng(a.album);
  let art = '';
  switch (a.style) {
    case 'synthwave':
      art = scene('scifi', [c0, '#3a0b5e', c1, lt], 1000, 1000, a.album, { poster: false, focusX: 0.5 });
      return `<div class="art">${art}<div style="position:absolute;top:70px;left:0;right:0;text-align:center;font:400 92px/1 ${FONT.retro};color:#fff;text-shadow:0 0 18px ${c1},0 0 40px ${c1}">${esc(a.artist.split(' ')[0].toUpperCase())}</div><div style="position:absolute;top:180px;left:0;right:0;text-align:center;font:700 34px/1 ${FONT.scifi};letter-spacing:.5em;color:${c2};text-shadow:0 0 12px ${c2}">${esc(a.artist.split(' ').slice(1).join(' ').toUpperCase())}</div><div style="position:absolute;bottom:48px;left:0;right:0;text-align:center;font:italic 700 44px/1 ${FONT.noir};color:#fff">${esc(a.album)}</div>${grain(0.12)}</div>`;
    case 'lofi': {
      let drops = '';
      for (let i = 0; i < 90; i++) {
        const x = 230 + r() * 540;
        const y = 170 + r() * 470;
        drops += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x - 2)}" y2="${f(y + r.range(8, 22))}" stroke="#fff" stroke-width="2" opacity="${f(r.range(0.2, 0.6))}" stroke-linecap="round"/>`;
      }
      art = `<svg class="scene" viewBox="0 0 1000 1000"><defs><linearGradient id="win" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#7d93b2"/><stop offset="1" stop-color="#c8b6c9"/></linearGradient></defs>
        <rect width="1000" height="1000" fill="${lt}"/><rect x="200" y="140" width="600" height="530" rx="18" fill="#6c584c"/><rect x="225" y="165" width="550" height="480" rx="8" fill="url(#win)"/>
        <clipPath id="wclip"><rect x="225" y="165" width="550" height="480"/></clipPath><g clip-path="url(#wclip)">${skyline(r, 1000, 1000, 645, '#5b6d8a', 170, '#ffd6a5')}</g>
        <rect x="225" y="165" width="550" height="480" fill="none"/>${drops}
        <rect x="492" y="165" width="16" height="480" fill="#6c584c"/><rect x="225" y="398" width="550" height="14" fill="#6c584c"/>
        <rect x="150" y="670" width="700" height="40" rx="10" fill="#8b6f5c"/>
        <path d="M300 670 L320 590 L380 590 L400 670 Z" fill="${c2}"/><path d="M350 590 C300 520 330 470 350 440 C370 470 400 520 350 590" fill="${c1}"/><path d="M350 590 C390 530 430 520 450 500 C440 550 410 580 350 590" fill="${c1}" opacity=".85"/><path d="M350 590 C310 540 270 540 250 520 C265 560 300 585 350 590" fill="${c1}" opacity=".85"/>
        <rect x="560" y="610" width="70" height="60" rx="10" fill="${c0}"/><path d="M630 625 q28 0 28 18 q0 18 -28 18" stroke="${c0}" stroke-width="10" fill="none"/>
        <path d="M580 600 q10 -20 0 -40 M600 600 q10 -20 0 -40" stroke="#fff" stroke-width="5" fill="none" opacity=".6" stroke-linecap="round"/>
      </svg>`;
      return `<div class="art">${art}<div style="position:absolute;bottom:150px;left:0;right:0;text-align:center;font:600 92px/1 ${FONT.hand};color:${c0}">${esc(a.album)}</div><div style="position:absolute;bottom:90px;left:0;right:0;text-align:center;font:500 30px/1 ${FONT.sans};letter-spacing:.4em;color:${c0};opacity:.75">${esc(a.artist.toUpperCase())}</div>${grain(0.2)}</div>`;
    }
    case 'house': {
      art = `<svg class="scene" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="${lt}"/>
        <circle cx="620" cy="420" r="300" fill="${c1}"/><path d="M200 1000 A300 300 0 0 1 800 1000 Z" fill="${c2}"/>
        <rect x="120" y="120" width="260" height="260" fill="${c0}"/><circle cx="250" cy="250" r="90" fill="${lt}"/>
        <path d="M620 120 A300 300 0 0 1 920 420 L620 420 Z" fill="${c2}" opacity=".9"/>
        ${Array.from({ length: 9 }, (_, i) => `<line x1="80" y1="${560 + i * 22}" x2="460" y2="${560 + i * 22}" stroke="${c0}" stroke-width="8"/>`).join('')}
      </svg>`;
      return `<div class="art">${art}<div style="position:absolute;right:70px;bottom:80px;text-align:right;font:700 76px/0.95 ${FONT.sans};color:${c0};letter-spacing:-.02em">${esc(a.album).replace(' ', '<br>')}</div><div style="position:absolute;left:80px;top:420px;font:700 26px/1 ${FONT.sans};letter-spacing:.3em;color:${c0}">${esc(a.artist.toUpperCase())}</div>${grain(0.14)}</div>`;
    }
    case 'techno':
    default: {
      let lines = '';
      for (let i = 0; i < 46; i++) {
        let d = '';
        for (let x = 0; x <= 1000; x += 20) {
          const amp = Math.exp(-Math.pow((x - 500) / 180, 2)) * 90 * (0.5 + r());
          d += `${x ? 'L' : 'M'}${x} ${f(200 + i * 14 - amp * (r() * 0.6 + 0.4))}`;
        }
        lines += `<path d="${d}" stroke="${i % 9 === 4 ? c2 : '#e8e8e8'}" stroke-width="2" fill="none" opacity="${i % 9 === 4 ? 1 : 0.55}"/>`;
      }
      art = `<svg class="scene" viewBox="0 0 1000 1000"><rect width="1000" height="1000" fill="${c0}"/>${lines}</svg>`;
      return `<div class="art">${art}<div style="position:absolute;left:70px;top:70px;font:700 30px/1 'JetBrains Mono',monospace;letter-spacing:.3em;color:#fff">${esc(a.artist.toUpperCase())}</div><div style="position:absolute;left:70px;bottom:70px;font:700 84px/1 ${FONT.sans};color:#fff;letter-spacing:-.02em">${esc(a.album)}</div><div style="position:absolute;right:70px;top:70px;font:500 22px/1 'JetBrains Mono',monospace;color:${c2}">HXD-0${a.year % 100}</div>${grain(0.16)}</div>`;
    }
  }
}

export function artistHtml(a, wide = false) {
  const [c0, c1, c2, lt] = a.pal;
  const w = wide ? 1920 : 1000;
  const h = wide ? 1080 : 1000;
  const r = rng(a.artist + wide);
  const n = a.style === 'lofi' || a.style === 'synthwave' ? 2 : 1;
  const person = (cx, base, s, flip) => `<g transform="translate(${f(cx)} ${f(base)}) scale(${f(flip ? -s : s)} ${f(s)})">
      <path d="M-260 0 Q-250 -330 -40 -370 L40 -370 Q250 -330 260 0 Z" fill="#07070a"/>
      <rect x="-42" y="-430" width="84" height="90" rx="30" fill="#07070a"/>
      <ellipse cx="0" cy="-520" rx="92" ry="112" fill="#07070a"/>
      <path d="M-96 -540 Q-90 -650 0 -652 Q96 -650 100 -540 Q80 -600 0 -600 Q-70 -600 -96 -540 Z" fill="#07070a"/>
      <path d="M92 -540 Q100 -460 60 -420" stroke="${lt}" stroke-width="6" fill="none" opacity=".55"/>
      <path d="M40 -370 Q250 -330 258 -40" stroke="${lt}" stroke-width="6" fill="none" opacity=".4"/>
    </g>`;
  let figs = '';
  for (let i = 0; i < n; i++) {
    const cx = wide ? w * (0.6 + i * 0.16) : w * (n === 1 ? 0.5 : 0.34 + i * 0.32);
    figs += person(cx, h, (wide ? 1.15 : 1.05) * (h / 1000) * (i ? 0.92 : 1), i === 1);
  }
  let beams = '';
  for (let i = 0; i < 6; i++) {
    const x = w * (0.1 + i * 0.17);
    beams += `<path d="M${f(x)} 0 L${f(x - w * 0.1)} ${h} L${f(x + w * 0.1)} ${h} Z" fill="${i % 2 ? c1 : c2}" opacity="0.22"/>`;
  }
  return `<div class="art" style="background:${c0}"><svg class="scene" viewBox="0 0 ${w} ${h}"><defs><radialGradient id="ag" cx="${wide ? 0.66 : 0.5}" cy="0.32" r="0.7"><stop offset="0" stop-color="${mix(c1, lt, 0.35)}"/><stop offset="0.6" stop-color="${mix(c1, c0, 0.55)}"/><stop offset="1" stop-color="${c0}"/></radialGradient><filter id="ab"><feGaussianBlur stdDeviation="${wide ? 40 : 26}"/></filter></defs>
    <rect width="${w}" height="${h}" fill="url(#ag)"/><g filter="url(#ab)">${beams}</g>${stars(r, w, h, 80, 1, 0.6)}${figs}</svg>${grain(0.18)}</div>`;
}

export function audiobookHtml(b) {
  const [c0, c1, ac, lt] = b.pal;
  const r = rng(b.title);
  let art = '';
  if (b.style === 'clock') {
    const gear = (cx, cy, R, teeth, col, op) => {
      let d = '';
      for (let i = 0; i < teeth * 2; i++) {
        const a = (i / (teeth * 2)) * Math.PI * 2;
        const rr = i % 2 ? R : R * 1.12;
        const a2 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
        d += `${i ? 'L' : 'M'}${f(cx + Math.cos(a) * rr)} ${f(cy + Math.sin(a) * rr)} L${f(cx + Math.cos(a2) * rr)} ${f(cy + Math.sin(a2) * rr)}`;
      }
      return `<path d="${d}Z" fill="${col}" opacity="${op}"/><circle cx="${cx}" cy="${cy}" r="${f(R * 0.55)}" fill="${c0}" opacity="${op}"/><circle cx="${cx}" cy="${cy}" r="${f(R * 0.18)}" fill="${col}" opacity="${op}"/>`;
    };
    art = `<svg class="scene" viewBox="0 0 1000 1000"><defs><radialGradient id="bg" cx=".5" cy=".4"><stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c0}"/></radialGradient></defs><rect width="1000" height="1000" fill="url(#bg)"/>
      ${gear(260, 300, 150, 14, ac, 0.55)}${gear(470, 470, 110, 11, ac, 0.75)}${gear(720, 330, 190, 18, ac, 0.4)}${gear(640, 640, 80, 9, lt, 0.6)}
      <circle cx="500" cy="420" r="230" fill="none" stroke="${lt}" stroke-width="6" opacity=".7"/>
      ${Array.from({ length: 12 }, (_, i) => `<line x1="500" y1="205" x2="500" y2="235" stroke="${lt}" stroke-width="6" transform="rotate(${i * 30} 500 420)"/>`).join('')}
      <line x1="500" y1="420" x2="500" y2="270" stroke="${lt}" stroke-width="8" stroke-linecap="round" transform="rotate(-50 500 420)"/><line x1="500" y1="420" x2="500" y2="230" stroke="${lt}" stroke-width="5" stroke-linecap="round" transform="rotate(40 500 420)"/>
    </svg>`;
  } else {
    let waves = '';
    for (let i = 0; i < 7; i++) {
      let d = `M0 ${640 + i * 50}`;
      for (let x = 0; x <= 1000; x += 50) d += ` Q${x + 25} ${f(640 + i * 50 + (i % 2 ? 18 : -18))} ${x + 50} ${640 + i * 50}`;
      waves += `<path d="${d} L1000 1000 L0 1000 Z" fill="${mix(c1, c0, i / 7)}" opacity="0.9"/>`;
    }
    art = `<svg class="scene" viewBox="0 0 1000 1000"><defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${c0}"/><stop offset=".7" stop-color="${c1}"/></linearGradient></defs><rect width="1000" height="1000" fill="url(#bg)"/>${stars(r, 1000, 1000, 220, 0.62)}
      <circle cx="720" cy="230" r="70" fill="${lt}"/><circle cx="745" cy="215" r="62" fill="${c0}"/>
      <g transform="translate(330 610)" fill="#0a0f1c"><path d="M-90 0 L90 0 L60 30 L-60 30 Z"/><rect x="-4" y="-150" width="8" height="150"/><path d="M6 -140 L80 -20 L6 -20 Z" fill="${lt}"/><path d="M-6 -120 L-60 -20 L-6 -20 Z" fill="${ac}"/></g>${waves}</svg>`;
  }
  return `<div class="art">${art}<div style="position:absolute;left:60px;right:60px;bottom:150px;text-align:center;font:700 74px/1.02 ${FONT.drama};color:#fff;text-shadow:0 4px 20px #000a">${esc(b.title)}</div><div style="position:absolute;left:0;right:0;bottom:84px;text-align:center;font:500 28px/1 ${FONT.sans};letter-spacing:.35em;color:${lt}">${esc(b.author.toUpperCase())}</div><div style="position:absolute;left:0;right:0;top:56px;text-align:center;font:500 22px/1 ${FONT.sans};letter-spacing:.3em;color:${lt};opacity:.8">READ BY ${esc(b.narrator.toUpperCase())}</div>${grain(0.16)}</div>`;
}

export function photoHtml(name, tod, coastal) {
  const r = rng(name);
  const skies = {
    dawn: ['#2d3a6b', '#e07a5f', '#f6c28b'],
    day: ['#4ea8de', '#90e0ef', '#e0f7ff'],
    dusk: ['#1d1a4a', '#8e3b6b', '#f7a072'],
    night: ['#02030a', '#0b1440', '#26336e'],
  }[tod];
  const w = 1600;
  const h = 1067;
  let body = `<defs><linearGradient id="sk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${skies[0]}"/><stop offset=".6" stop-color="${skies[1]}"/><stop offset="1" stop-color="${skies[2]}"/></linearGradient><filter id="hz"><feGaussianBlur stdDeviation="2"/></filter></defs><rect width="${w}" height="${h}" fill="url(#sk)"/>`;
  if (tod === 'night') body += stars(r, w, h, 500, 0.7, 1);
  if (tod !== 'night') body += `<circle cx="${f(w * r.range(0.25, 0.75))}" cy="${f(h * (tod === 'day' ? 0.18 : 0.52))}" r="${tod === 'day' ? 50 : 90}" fill="#fff8e7" opacity=".9"/>`;
  const base = coastal ? 0.62 : 0.55;
  for (let i = 0; i < 4; i++) {
    const t = i / 3;
    const col = mix(skies[1], tod === 'night' ? '#05060c' : '#1f2a2e', 0.35 + t * 0.6);
    body += `<path d="${ridge(r, w, h, h * (base + t * 0.12), h * (0.28 - t * 0.12), 6 + i * 2, i > 1)}" fill="${col}"/>`;
  }
  if (coastal) {
    body += `<rect x="0" y="${f(h * 0.8)}" width="${w}" height="${f(h * 0.2)}" fill="${mix(skies[1], '#0b2a3a', 0.6)}"/>`;
    for (let i = 0; i < 60; i++) body += `<rect x="${f(r() * w)}" y="${f(h * r.range(0.81, 1))}" width="${f(r.range(20, 90))}" height="2" fill="${skies[2]}" opacity="${f(r.range(0.2, 0.6))}"/>`;
  } else {
    body += `<path d="${ridge(r, w, h, h * 0.92, h * 0.04, 10)}" fill="#0d1a12"/>`;
  }
  return `<div class="art"><svg class="scene" viewBox="0 0 ${w} ${h}">${body}</svg>${grain(0.14, 0.9)}</div>`;
}

export function channelLogoHtml(ch) {
  const [a, b] = ch.colors;
  return `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center"><div style="width:92%;height:84%;border-radius:28px;background:linear-gradient(135deg,${a},${mix(a, b, 0.35)});display:flex;align-items:center;justify-content:center;box-shadow:inset 0 0 0 6px #ffffff22">
    <div class="fit" data-max="130" data-min="40" style="font:400 130px/1 ${FONT.action};letter-spacing:.04em;color:${b === '#ffffff' ? '#fff' : mix(b, '#ffffff', 0.6)};text-align:center;width:88%;text-shadow:0 4px 0 #0003">${esc(ch.short)}</div></div></div>`;
}

/** A frame for a channel's mock live stream: a scene plus on-screen graphics. */
export function channelFrameHtml(ch, extras = {}) {
  const [a, b] = ch.colors;
  const bug = `<div style="position:absolute;right:40px;top:34px;font:400 44px/1 ${FONT.action};color:#fff;opacity:.8;letter-spacing:.06em;text-shadow:0 2px 8px #000">${esc(ch.short)}</div>`;
  let content = '';
  switch (ch.kind) {
    case 'news':
      content = `<div class="art" style="background:radial-gradient(circle at 70% 30%,#1d3b6e,#081226)">
        <svg class="scene" viewBox="0 0 1280 720">${skyline(rng('news'), 1280, 720, 560, '#0c1a33', 220, '#ffd27a')}<rect x="0" y="560" width="1280" height="160" fill="#0a1426"/></svg>
        <div style="position:absolute;left:0;right:0;bottom:70px;height:84px;background:#fff;display:flex;align-items:center"><div style="background:${a};color:#fff;height:100%;display:flex;align-items:center;padding:0 26px;font:700 30px/1 ${FONT.sans};letter-spacing:.06em">BREAKING</div><div style="padding:0 26px;font:700 34px/1 ${FONT.sans};color:#111">Harbour bridge reopens after record-breaking restoration</div></div>
        <div style="position:absolute;left:0;right:0;bottom:30px;height:40px;background:#111;color:#ddd;font:500 22px/40px ${FONT.sans};padding-left:24px;white-space:nowrap">MARKETS ▲ 1.2% · WEATHER Sunny spells, 21° · SPORT Coastal League kicks off tonight</div></div>`;
      break;
    case 'sports':
      content = `<div class="art" style="background:#1b5e20"><svg class="scene" viewBox="0 0 1280 720">${Array.from({ length: 10 }, (_, i) => `<rect x="${i * 128}" y="0" width="64" height="720" fill="#2e7d32"/>`).join('')}<g stroke="#fff" stroke-width="5" fill="none" opacity=".85"><rect x="60" y="60" width="1160" height="600"/><line x1="640" y1="60" x2="640" y2="660"/><circle cx="640" cy="360" r="90"/><rect x="60" y="220" width="150" height="280"/><rect x="1070" y="220" width="150" height="280"/></g><circle cx="700" cy="400" r="12" fill="#fff"/></svg>
        <div style="position:absolute;left:40px;top:34px;display:flex;font:700 30px/1 ${FONT.sans};color:#fff;box-shadow:0 6px 20px #0006"><span style="background:#03045e;padding:12px 18px">HAR</span><span style="background:#fff;color:#111;padding:12px 18px">2 – 1</span><span style="background:#9d0208;padding:12px 18px">NOR</span><span style="background:#111;padding:12px 18px">67:12</span></div></div>`;
      break;
    case 'nature':
      content = photoHtml('wild-' + ch.name, 'dawn', false);
      break;
    case 'kids':
      content = `<div class="art">${scene('family', ['#1b2a6b', '#4f7cff', '#ffcf3f', '#ffffff'], 1280, 720, 'kids-ch', { focusX: 0.5 })}</div>`;
      break;
    case 'music':
      content = albumCoverHtml({ artist: 'Tempo Live', album: 'Countdown', year: 2026, style: 'techno', pal: ['#140024', '#3a3a3a', '#f72585', '#fff'] });
      break;
    default:
      content = extras.html ?? `<div class="art">${scene(extras.style ?? 'drama', extras.pal ?? [b, a, '#ffffff', '#ffffff'], 1280, 720, ch.name, { focusX: 0.5 })}</div>`;
  }
  return `<div style="position:relative;width:100%;height:100%;overflow:hidden">${content}${bug}</div>`;
}

export function avatarHtml(name, hue) {
  return `<div style="width:100%;height:100%;background:linear-gradient(135deg,hsl(${hue} 80% 60%),hsl(${(hue + 50) % 360} 75% 45%));display:flex;align-items:center;justify-content:center;font:700 120px/1 ${FONT.family};color:#fff;text-shadow:0 4px 0 #0002">${esc(name[0])}</div>`;
}

/* ------------------------------------------------------------------ */
/* Renderer                                                            */
/* ------------------------------------------------------------------ */

export class Renderer {
  constructor(browser, workDir, fontCss) {
    this.browser = browser;
    this.base = path.join(workDir, 'render.html');
    fs.writeFileSync(this.base, `<!doctype html><html><head><meta charset="utf-8"><style>${fontCss}\nhtml,body{margin:0;padding:0;background:transparent}*{box-sizing:border-box}#root{position:relative;overflow:hidden}${BASE_CSS}</style></head><body><div id="root"></div></body></html>`);
  }

  async open() {
    this.page = await this.browser.newPage({ viewport: { width: 800, height: 1200 } });
    await this.page.goto('file://' + this.base);
    await this.page.evaluate(() => document.fonts.ready);
  }

  /** Render `html` at w×h and write it to `out` (.jpg or .png; PNGs keep transparency). */
  async render(html, w, h, out, quality = 88) {
    const page = this.page;
    await page.setViewportSize({ width: w, height: h });
    await page.evaluate(
      async ({ html, w, h }) => {
        const root = document.getElementById('root');
        root.style.width = w + 'px';
        root.style.height = h + 'px';
        root.innerHTML = html;
        for (const svg of root.querySelectorAll('svg.scene')) if (!svg.getAttribute('preserveAspectRatio')) svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
        await document.fonts.ready;
        // Shrink-to-fit titles: largest size that keeps every word on one line and the block inside its box.
        for (const el of root.querySelectorAll('.fit')) {
          const box = el.parentElement;
          let size = Number(el.dataset.max || 120);
          const min = Number(el.dataset.min || 30);
          const fits = () => {
            el.style.fontSize = size + 'px';
            if (el.scrollWidth > el.clientWidth + 1) return false;
            const words = el.textContent.split(/\s+/);
            const probe = document.createElement('span');
            const cs = getComputedStyle(el);
            probe.style.font = cs.font;
            probe.style.letterSpacing = cs.letterSpacing;
            probe.style.textTransform = cs.textTransform;
            probe.style.position = 'absolute';
            probe.style.visibility = 'hidden';
            probe.style.whiteSpace = 'nowrap';
            probe.style.width = 'auto';
            document.body.appendChild(probe);
            let ok = true;
            for (const word of words) {
              probe.textContent = word;
              if (probe.getBoundingClientRect().width > el.clientWidth) ok = false;
            }
            probe.remove();
            return ok && el.scrollHeight <= box.clientHeight + 2;
          };
          while (size > min && !fits()) size -= 4;
        }
      },
      { html, w, h },
    );
    fs.mkdirSync(path.dirname(out), { recursive: true });
    const png = out.endsWith('.png');
    await page.screenshot({ path: out, type: png ? 'png' : 'jpeg', quality: png ? undefined : quality, omitBackground: png, clip: { x: 0, y: 0, width: w, height: h } });
  }
}
