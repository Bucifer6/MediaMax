/**
 * Visualiser styles, drawn with canvas 2D. Each style is a function of one frame of audio features.
 * "ring" (cover art + spectrum ring + beat pulse) is adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) —
 * public/js/video/visualizer.js.
 */
import type { VisualizerStyle } from '@mediamax/shared';
import { mirrored, withAlpha, type Rgb } from './core';

export interface VisFrame {
  g: CanvasRenderingContext2D;
  /** Canvas size in device pixels. */
  w: number;
  h: number;
  /** Scale: device pixels per CSS pixel. */
  s: number;
  now: number;
  /** Smoothed log-spaced bars 0..1. */
  levels: Float32Array;
  /** Time-domain samples (bytes, 128 = silence) or null without an analyser. */
  wave: Uint8Array | null;
  /** 0..1 smoothed overall energy. */
  energy: number;
  /** 0..1 beat pulse (beat grid or onset detector). */
  pulse: number;
  cover: HTMLImageElement | null;
  palette: Rgb[];
  accent: string;
  /** prefers-reduced-motion: gentle, mostly static version. */
  reduced: boolean;
  /** Per-style scratch state that persists across frames. */
  state: Record<string, unknown>;
}

export const VISUALIZER_STYLES: { id: VisualizerStyle; label: string }[] = [
  { id: 'ring', label: 'Cover ring' },
  { id: 'bars', label: 'Bars' },
  { id: 'wave', label: 'Waveform' },
  { id: 'particles', label: 'Starfield' },
  { id: 'ambient', label: 'Ambient' },
];

const rgb = (c: Rgb | undefined, a = 1, fallback = '#3ea6ff') => (c ? `rgba(${c.r},${c.g},${c.b},${a})` : withAlpha(fallback, a));

function drawCover(g: CanvasRenderingContext2D, img: HTMLImageElement, x: number, y: number, size: number, round: number) {
  g.save();
  g.beginPath();
  if (round >= size / 2) g.arc(x + size / 2, y + size / 2, size / 2, 0, Math.PI * 2);
  else g.roundRect(x, y, size, size, round);
  g.clip();
  const sc = Math.max(size / img.naturalWidth, size / img.naturalHeight);
  g.drawImage(img, x + size / 2 - (img.naturalWidth * sc) / 2, y + size / 2 - (img.naturalHeight * sc) / 2, img.naturalWidth * sc, img.naturalHeight * sc);
  g.restore();
}

function backdrop(f: VisFrame, alpha = 0.22) {
  const { g, w, h, cover, energy, pulse, accent } = f;
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#05070a';
  g.fillRect(0, 0, w, h);
  const rg = g.createRadialGradient(w / 2, h / 2, 10, w / 2, h / 2, Math.max(w, h) * 0.7);
  rg.addColorStop(0, rgb(f.palette[0], 0.18 + 0.3 * energy, accent));
  rg.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = rg;
  g.fillRect(0, 0, w, h);
  if (cover) {
    g.globalAlpha = alpha + 0.12 * pulse;
    const sc = Math.max(w / cover.naturalWidth, h / cover.naturalHeight) * (1.1 + 0.04 * pulse);
    const cw = cover.naturalWidth * sc, ch = cover.naturalHeight * sc;
    g.filter = 'blur(24px)';
    g.drawImage(cover, (w - cw) / 2, (h - ch) / 2, cw, ch);
    g.filter = 'none';
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(0,0,0,.45)';
    g.fillRect(0, 0, w, h);
  }
}

/** Cover art disc in the middle, spectrum ring around it, a beat ring expanding on every beat. */
function ring(f: VisFrame) {
  const { g, w, h, s, levels, pulse, cover, now, accent, reduced } = f;
  backdrop(f);
  const color = rgb(f.palette[0], 1, accent);
  const n = levels.length;
  const cx = w / 2, cy = h / 2;
  const r0 = Math.min(w, h) * 0.2 + 10 * s * pulse;
  const reach = Math.min(w, h) * 0.17;
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineWidth = Math.max(2, (Math.PI * 2 * r0) / (n * 2) * 0.55);
  g.beginPath();
  for (let k = 0; k < n * 2; k++) {
    const v = levels[k < n ? k : 2 * n - 1 - k];
    const ang = (k / (n * 2)) * Math.PI * 2 - Math.PI / 2 + (reduced ? 0 : now / 8000);
    const r1 = r0 + 4 * s + v * reach;
    g.moveTo(cx + Math.cos(ang) * r0, cy + Math.sin(ang) * r0);
    g.lineTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
  }
  g.globalAlpha = 0.9;
  g.stroke();
  if (!reduced) {
    g.globalAlpha = 0.6 * pulse;
    g.lineWidth = 3 * s;
    g.beginPath();
    g.arc(cx, cy, r0 + reach * (1 - pulse) + 20 * s, 0, Math.PI * 2);
    g.stroke();
  }
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  const d = (r0 - 6 * s) * 2;
  if (cover) drawCover(g, cover, cx - d / 2, cy - d / 2, d, d);
  else {
    g.fillStyle = '#10141a';
    g.beginPath();
    g.arc(cx, cy, d / 2, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = color;
    g.font = `800 ${Math.round(d * 0.3)}px system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('♪', cx, cy);
  }
}

/** Classic spectrum bars with falling peak caps. */
function bars(f: VisFrame) {
  const { g, w, h, s, levels, accent, pulse } = f;
  backdrop(f, 0.16);
  const peaks = (f.state.peaks as Float32Array | undefined) ?? new Float32Array(levels.length);
  f.state.peaks = peaks;
  const n = levels.length;
  const margin = w * 0.06;
  const gap = Math.max(1, (w - margin * 2) / n * 0.22);
  const bw = (w - margin * 2) / n - gap;
  const base = h * 0.82;
  const maxH = h * 0.62;
  const grad = g.createLinearGradient(0, base - maxH, 0, base);
  grad.addColorStop(0, rgb(f.palette[1] ?? f.palette[0], 1, accent));
  grad.addColorStop(1, rgb(f.palette[0], 1, accent));
  for (let i = 0; i < n; i++) {
    const v = levels[i];
    const bh = Math.max(2 * s, v * maxH * (0.92 + 0.08 * pulse));
    const x = margin + i * (bw + gap);
    g.fillStyle = grad;
    g.beginPath();
    g.roundRect(x, base - bh, bw, bh, Math.min(bw / 2, 4 * s));
    g.fill();
    // reflection
    g.globalAlpha = 0.18;
    g.fillRect(x, base + 4 * s, bw, bh * 0.25);
    g.globalAlpha = 1;
    peaks[i] = Math.max(v, peaks[i] - 0.008);
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.fillRect(x, base - peaks[i] * maxH - 6 * s, bw, 2.5 * s);
  }
}

/** Mirrored oscilloscope: the live waveform drawn twice, above and below the centre line, with a glow. */
function wave(f: VisFrame) {
  const { g, w, h, s, wave: data, levels, pulse, accent, now, reduced } = f;
  backdrop(f, 0.14);
  const cy = h / 2;
  const amp = h * 0.32 * (0.9 + 0.2 * pulse);
  const pts = 256;
  const sample = (i: number) => {
    if (data && data.length) return (data[Math.floor((i / pts) * (data.length - 1))] - 128) / 128;
    // No time-domain data (beat-grid fallback): synthesise a smooth wave from the bar levels.
    const lv = mirrored(levels);
    const x = i / pts;
    return (lv[Math.floor(x * (lv.length - 1))] ?? 0) * Math.sin(x * Math.PI * 8 + (reduced ? 0 : now / 300)) * 0.8;
  };
  const color = rgb(f.palette[0], 1, accent);
  g.lineJoin = 'round';
  for (const [mul, alpha, width] of [[1, 0.25, 9], [1, 1, 2.5], [-1, 0.55, 2]] as const) {
    g.beginPath();
    for (let i = 0; i <= pts; i++) {
      const x = (i / pts) * w;
      const y = cy + sample(i) * amp * mul;
      if (i) g.lineTo(x, y);
      else g.moveTo(x, y);
    }
    g.strokeStyle = mul < 0 ? rgb(f.palette[1] ?? f.palette[0], alpha, accent) : withAlpha(color, alpha);
    g.lineWidth = width * s;
    g.stroke();
  }
  g.fillStyle = withAlpha(color, 0.12 + 0.2 * pulse);
  g.fillRect(0, cy - 1 * s, w, 2 * s);
}

interface Star {
  x: number;
  y: number;
  z: number;
}

/** Starfield flying towards the viewer; speed follows the energy, stars flash on the beat. */
function particles(f: VisFrame) {
  const { g, w, h, s, energy, pulse, accent, reduced, cover } = f;
  let stars = f.state.stars as Star[] | undefined;
  const count = Math.round(Math.min(420, (w * h) / (2600 * s * s)));
  if (!stars || stars.length !== count) {
    stars = Array.from({ length: count }, () => ({ x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random() }));
    f.state.stars = stars;
  }
  const last = (f.state.t as number | undefined) ?? f.now;
  const dt = Math.min(64, f.now - last);
  f.state.t = f.now;
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = 'rgba(3,4,8,0.35)';
  g.fillRect(0, 0, w, h);
  const speed = reduced ? 0.00002 : 0.00008 + energy * 0.0009 + pulse * 0.0006;
  const cx = w / 2, cy = h / 2;
  const color = rgb(f.palette[0], 1, accent);
  const c2 = rgb(f.palette[1] ?? f.palette[0], 1, accent);
  for (let i = 0; i < stars.length; i++) {
    const st = stars[i];
    const pz = st.z;
    st.z -= speed * dt;
    if (st.z <= 0.02) {
      st.x = (Math.random() - 0.5) * 2;
      st.y = (Math.random() - 0.5) * 2;
      st.z = 1;
      continue;
    }
    const k = Math.min(w, h) * 0.6;
    const x = cx + (st.x / st.z) * k, y = cy + (st.y / st.z) * k;
    const px = cx + (st.x / pz) * k, py = cy + (st.y / pz) * k;
    if (x < -50 || x > w + 50 || y < -50 || y > h + 50) continue;
    const size = (1 - st.z) * 3.2 * s * (1 + pulse * 0.8);
    g.strokeStyle = i % 3 ? color : c2;
    g.globalAlpha = Math.min(1, (1 - st.z) * 1.4);
    g.lineWidth = size;
    g.beginPath();
    g.moveTo(px, py);
    g.lineTo(x, y);
    g.stroke();
  }
  g.globalAlpha = 1;
  if (cover) {
    const d = Math.min(w, h) * 0.16 * (1 + 0.06 * pulse);
    g.shadowColor = color;
    g.shadowBlur = 30 * s * (0.4 + pulse);
    drawCover(g, cover, cx - d / 2, cy - d / 2, d, 12 * s);
    g.shadowBlur = 0;
  }
}

/** Ambient: soft blobs in the cover's colours drifting and breathing with the music (10-foot friendly). */
function ambient(f: VisFrame) {
  const { g, w, h, s, energy, pulse, now, reduced, cover, accent } = f;
  g.globalCompositeOperation = 'source-over';
  g.globalAlpha = 1;
  g.fillStyle = '#04050a';
  g.fillRect(0, 0, w, h);
  const cols = f.palette.length ? f.palette : [{ r: 62, g: 166, b: 255 }, { r: 160, g: 60, b: 255 }, { r: 255, g: 90, b: 120 }];
  const t = reduced ? 0 : now / 9000;
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 5; i++) {
    const c = cols[i % cols.length];
    const ang = t * (0.6 + i * 0.17) + i * 1.9;
    const x = w / 2 + Math.cos(ang) * w * 0.28;
    const y = h / 2 + Math.sin(ang * 1.3) * h * 0.26;
    const r = Math.max(w, h) * (0.32 + 0.05 * i / 5) * (1 + 0.12 * energy + 0.08 * pulse);
    const grd = g.createRadialGradient(x, y, 0, x, y, r);
    grd.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${0.32 + 0.25 * energy})`);
    grd.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    g.fillStyle = grd;
    g.fillRect(0, 0, w, h);
  }
  g.globalCompositeOperation = 'source-over';
  if (cover) {
    const d = Math.min(w, h) * 0.34;
    g.shadowColor = rgb(cols[0], 0.8, accent);
    g.shadowBlur = 60 * s * (0.6 + 0.4 * pulse);
    drawCover(g, cover, w / 2 - d / 2, h / 2 - d / 2, d, 18 * s);
    g.shadowBlur = 0;
  }
}

export const DRAW: Record<VisualizerStyle, (f: VisFrame) => void> = { ring, bars, wave, particles, ambient };
