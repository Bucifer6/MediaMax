/**
 * Audio-reactive visualiser canvas for the music player.
 *
 * Reads the music output's AnalyserNode (a fan-out tap after night mode / karaoke — it never changes the audio path).
 * Beats come from the DJ analysis beat grid when the track has one (GET /items/:id/analysis, read-only), else from an
 * onset detector on the analyser. When there is no analyser data at all (no Web Audio, e.g. iOS without crossfade, or
 * a source that can't be routed through Web Audio), the animation is driven by the beat grid / a gentle clock only.
 * requestAnimationFrame, paused while the page is hidden, device-pixel-ratio capped on TVs, and a calm static-ish
 * version for prefers-reduced-motion.
 */
import { useEffect, useRef } from 'react';
import type { TrackAnalysis, VisualizerStyle } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { mediaUrl } from '../api/client';
import { useMusic } from '../player/music';
import { useMediaQuery } from '../hooks';
import { barLevels, bassEnergy, beatPhase, capDpr, OnsetDetector, paletteFromPixels, pulseFromPhase, rmsLevel, smoothInto, type Rgb } from './core';
import { DRAW } from './styles';

const BARS = 48;
const analysisCache = new Map<string, TrackAnalysis | null>();

/** Beat grid for a track (cached; null when not analysed / no steady beat). */
export async function trackBeatGrid(itemId: string): Promise<TrackAnalysis | null> {
  if (analysisCache.has(itemId)) return analysisCache.get(itemId)!;
  const a = await api.dj.analysis(itemId).catch(() => null);
  analysisCache.set(itemId, a);
  return a;
}

function loadCover(url: string | null | undefined): Promise<{ img: HTMLImageElement; palette: Rgb[] } | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      let palette: Rgb[] = [];
      try {
        const c = document.createElement('canvas');
        c.width = c.height = 32;
        const g = c.getContext('2d')!;
        g.drawImage(img, 0, 0, 32, 32);
        palette = paletteFromPixels(g.getImageData(0, 0, 32, 32).data, 3);
      } catch {
        /* tainted canvas: no palette */
      }
      resolve({ img, palette });
    };
    img.onerror = () => resolve(null);
    img.src = mediaUrl(url, 512) ?? url;
  });
}

export function Visualizer({ style, itemId, coverUrl, className, tv = false }: { style: VisualizerStyle; itemId: string | null; coverUrl?: string | null; className?: string; tv?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const m = useMusic();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const live = useRef({ playing: m.playing, style, reduced });
  live.current = { playing: m.playing, style, reduced };
  const media = useRef<{ cover: HTMLImageElement | null; palette: Rgb[]; grid: TrackAnalysis | null }>({ cover: null, palette: [], grid: null });

  useEffect(() => {
    let off = false;
    media.current = { cover: null, palette: [], grid: null };
    void loadCover(coverUrl).then((c) => {
      if (!off && c) media.current = { ...media.current, cover: c.img, palette: c.palette };
    });
    if (itemId) void trackBeatGrid(itemId).then((a) => {
      if (!off) media.current = { ...media.current, grid: a };
    });
    return () => {
      off = true;
    };
  }, [itemId, coverUrl]);

  useEffect(() => {
    const cv = canvas.current;
    if (!cv) return;
    const g = cv.getContext('2d', { alpha: false });
    if (!g) return;
    const out = m.output;
    const levels = new Float32Array(BARS);
    const target = new Float32Array(BARS);
    const onset = new OnsetDetector();
    const state: Record<string, unknown> = {};
    let freq: Uint8Array<ArrayBuffer> | null = null;
    let wave: Uint8Array<ArrayBuffer> | null = null;
    let energy = 0;
    let silentFrames = 0;
    let raf = 0;
    let last = performance.now();
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--c-primary').trim() || '#3ea6ff';

    const resize = () => {
      const r = cv.getBoundingClientRect();
      const dpr = capDpr(window.devicePixelRatio, tv, r.width);
      const w = Math.max(1, Math.round(r.width * dpr));
      const h = Math.max(1, Math.round(r.height * dpr));
      if (cv.width !== w || cv.height !== h) {
        cv.width = w;
        cv.height = h;
      }
      return dpr;
    };
    let dpr = resize();
    const ro = new ResizeObserver(() => (dpr = resize()));
    ro.observe(cv);

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(100, now - last);
      last = now;
      const { playing, style: st, reduced: red } = live.current;
      const an = out.analyser();
      let haveFft = false;
      if (an) {
        if (!freq || freq.length !== an.frequencyBinCount) {
          freq = new Uint8Array(an.frequencyBinCount);
          wave = new Uint8Array(an.fftSize);
        }
        an.getByteFrequencyData(freq);
        an.getByteTimeDomainData(wave!);
        let sum = 0;
        for (let i = 0; i < 64 && i < freq.length; i++) sum += freq[i];
        silentFrames = sum > 0 ? 0 : silentFrames + 1;
        haveFft = silentFrames < 90; // ~1.5 s of digital silence while "playing" = analyser not fed (passthrough)
      }
      const t = out.timeMs();
      const grid = media.current.grid;
      const bp = grid?.bpm && grid.bpmConfidence > 0.3 ? beatPhase(t, grid.bpm, grid.beatOffsetMs) : null;
      let pulse = 0;
      if (haveFft && freq && playing) {
        barLevels(freq, BARS, an!.context.sampleRate, 40, 16000, target);
        smoothInto(levels, target, red ? 0.08 : 0.55, red ? 0.04 : 0.12);
        const e = 0.6 * bassEnergy(freq, an!.context.sampleRate) + 0.4 * Math.min(1, rmsLevel(wave!) * 2.5);
        energy += (e - energy) * (red ? 0.03 : 0.25);
        onset.update(freq, now, dt);
        pulse = bp ? pulseFromPhase(bp.phase) * (0.4 + 0.6 * energy) : onset.pulse;
      } else {
        // No FFT: beat-grid (or clock) driven animation.
        const ph = bp?.phase ?? ((now / 500) % 1);
        pulse = playing ? pulseFromPhase(ph) * (bp ? 0.9 : 0.35) : 0;
        energy += ((playing ? 0.35 + 0.25 * pulse : 0.05) - energy) * 0.05;
        for (let i = 0; i < BARS; i++) target[i] = playing ? Math.max(0, (0.55 - i / BARS * 0.45) * (0.6 + 0.4 * pulse) + 0.08 * Math.sin(now / 340 + i * 0.7)) : 0;
        smoothInto(levels, target, 0.2, 0.08);
      }
      if (red) pulse *= 0.25;
      DRAW[st]({ g, w: cv.width, h: cv.height, s: dpr, now, levels, wave: haveFft ? wave : null, energy, pulse, cover: media.current.cover, palette: media.current.palette, accent, reduced: red, state });
    };
    const start = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(frame);
    };
    const onVis = () => (document.hidden ? cancelAnimationFrame(raf) : start());
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [m.output, tv]);

  return <canvas ref={canvas} className={className ?? 'visualizer-canvas'} aria-hidden="true" />;
}
