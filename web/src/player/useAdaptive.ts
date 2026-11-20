/**
 * Automatic quality ("Auto") for the web player: feeds the bandwidth estimator, runs the ABR controller once a second
 * and acts on its decisions.
 *
 *  - Multi-rendition transcode (hls.js): switch variants (`setLevel`) — seamless, the server encodes the new rendition
 *    from the requested segment on demand.
 *  - Direct play, remux, single-variant streams: ask the player to restart the stream (`onRestart`) with the new
 *    estimate; the server then picks direct play or a fitting transcode. The player swaps streams seamlessly.
 *  - A transcode chosen only because of bandwidth (`info.bandwidthLimited`) goes back to the original when the link
 *    recovers (top virtual level), with long hold/dwell times.
 *
 * Throughput comes from hls.js fragment loads (first → last byte), from the growth of the progressive download's
 * buffer during direct play, and from the bandwidth probe at start.
 */
import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react';
import type { PlaybackInfo } from '@mediamax/shared';
import type { Attached } from './engine';
import { AbrController, BandwidthEstimator, RESTART_ABR, SEGMENT_ABR, formatBps, restartLevels, type AbrLevel } from './abr';
import { measureBandwidth, rememberBandwidth } from './bandwidth';
import { bufferAhead } from './videoPair';

export interface AdaptiveState {
  mode: 'off' | 'renditions' | 'restart' | 'native';
  /** Estimated throughput (bits/s). */
  estimate: number | null;
  /** Label of the level being played ("720p", "Original"). */
  level: string | null;
  /** Last switch, for the stats overlay. */
  lastSwitch: string | null;
}

interface Opts {
  /** Auto quality on (and not casting). */
  enabled: boolean;
  info: PlaybackInfo | null;
  attached: MutableRefObject<Attached | null>;
  video: () => HTMLVideoElement | null;
  /** Restart the stream for this bandwidth (kbps). */
  onRestart: (measuredKbps: number, direction: 'up' | 'down') => void;
  notify: (text: string, kind: 'down' | 'up') => void;
}

type Level = AbrLevel & { kind: 'variant' | 'original' | 'step'; index?: number };

export function useAdaptive(o: Opts) {
  const estimator = useRef(new BandwidthEstimator());
  const ctl = useRef<{ c: AbrController; levels: Level[]; mode: AdaptiveState['mode']; key: string } | null>(null);
  const [state, setState] = useState<AdaptiveState>({ mode: 'off', estimate: null, level: null, lastSwitch: null });
  const live = useRef(o);
  live.current = o;
  const lastRestart = useRef(0);
  const stalls = useRef<number[]>([]);
  const lastBuffered = useRef<{ t: number; end: number } | null>(null);
  const lastQuality = useRef<{ dropped: number; total: number }[]>([]);

  /** Seed with the start-up probe / remembered value (bits/s). */
  const seed = useCallback((bps: number | null) => {
    if (bps) estimator.current.seed(bps);
    setState((s) => ({ ...s, estimate: estimator.current.estimate }));
  }, []);

  /** hls.js fragment loaded. */
  const onFragment = useCallback((bytes: number, ms: number) => estimator.current.add(bytes, ms), []);

  const onLevelSwitched = useCallback((level: number) => {
    const c = ctl.current;
    if (!c || c.mode !== 'renditions') return;
    const idx = c.levels.findIndex((l) => l.kind === 'variant' && l.index === level);
    if (idx >= 0) c.c.setCurrent(idx, performance.now());
    setState((s) => ({ ...s, level: c.levels[idx]?.label ?? s.level }));
  }, []);

  // Rebuild the controller for each new stream.
  useEffect(() => {
    ctl.current = null;
    stalls.current = [];
    lastBuffered.current = null;
    lastQuality.current = [];
    setState((s) => ({ ...s, mode: o.enabled && o.info ? s.mode : 'off', level: null }));
  }, [o.info?.sessionId, o.enabled]);

  /** Build the controller once the engine knows its levels. */
  const ensureController = useCallback(() => {
    const { info, attached, enabled } = live.current;
    if (!enabled || !info) return null;
    const att = attached.current;
    if (!att) return null;
    const key = `${info.sessionId}:${att.engine}`;
    if (ctl.current?.key === key) return ctl.current;
    const now = performance.now();
    const hlsLevels = att.levels?.() ?? [];
    if (info.adaptiveMode === 'renditions' && att.engine === 'native-hls') {
      ctl.current = { c: new AbrController([{ bitrate: 1, label: '' }], 0), levels: [], mode: 'native', key };
      return ctl.current;
    }
    if (info.adaptiveMode === 'renditions' && hlsLevels.length > 1) {
      const levels: Level[] = hlsLevels.map((l, i) => ({ bitrate: l.bitrate, height: l.height, label: l.height ? `${l.height}p` : `${Math.round(l.bitrate / 1000)} kbps`, kind: 'variant', index: i }));
      // Back to the original file when bandwidth was the only reason to transcode.
      if (info.bandwidthLimited && info.sourceBitrate) levels.push({ bitrate: info.sourceBitrate * 1000 * 1.15, label: 'Original', kind: 'original' });
      const cur = Math.max(0, att.currentLevel?.() ?? 0);
      const c = new AbrController(levels, cur, SEGMENT_ABR, now);
      ctl.current = { c, levels: c.levels as Level[], mode: 'renditions', key };
      setState((s) => ({ ...s, mode: 'renditions', level: (c.levels[c.current] as Level).label }));
      return ctl.current;
    }
    if (info.adaptiveMode === 'restart' && info.method !== 'live' && (info.method === 'direct' || info.method === 'remux' || hlsLevels.length <= 1)) {
      const lv = restartLevels(info.sourceBitrate ?? null, info.maxBitrate ?? null).map((l): Level => ({ ...l, kind: l.kbps == null ? 'original' : 'step' }));
      if (lv.length < 2) return null;
      const est = estimator.current.estimate;
      const cur = info.method === 'transcode' ? (est ? new AbrController(lv, 0).fit(est) : 0) : lv.length - 1;
      const c = new AbrController(lv, cur, RESTART_ABR, now);
      ctl.current = { c, levels: c.levels as Level[], mode: 'restart', key };
      setState((s) => ({ ...s, mode: 'restart', level: info.method === 'transcode' ? 'Transcode' : 'Original' }));
      return ctl.current;
    }
    return null;
  }, []);

  // Stall tracking (direct play has no fragment stats: repeated stalls mean the link can't keep up).
  useEffect(() => {
    const v = o.video();
    if (!v || !o.enabled) return;
    const onWaiting = () => {
      if (!v.seeking && !v.paused && v.currentTime > 1) stalls.current = [...stalls.current.filter((t) => performance.now() - t < 30000), performance.now()];
    };
    v.addEventListener('waiting', onWaiting);
    return () => v.removeEventListener('waiting', onWaiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [o.info?.sessionId, o.enabled]);

  // The 1-second control loop.
  useEffect(() => {
    if (!o.enabled) return;
    let probing = false;
    let rememberAt = 0;
    const iv = window.setInterval(() => {
      const { info, video, attached } = live.current;
      const v = video();
      if (!info || !v) return;
      const now = performance.now();
      const buf = bufferAhead(v);
      const playing = !v.paused && !v.ended && !v.seeking;

      // Progressive download (direct play): buffer growth while the browser is still filling = throughput sample.
      if (attached.current?.engine === 'native' && info.sourceBitrate && playing) {
        const end = v.buffered.length ? v.buffered.end(v.buffered.length - 1) : 0;
        const prev = lastBuffered.current;
        lastBuffered.current = { t: now, end };
        if (prev && buf < 20 && end > prev.end && end - prev.end < ((now - prev.t) / 1000) * 20 && end < (v.duration || Infinity) - 1) {
          const bytes = ((end - prev.end) * info.sourceBitrate * 1000) / 8;
          estimator.current.add(bytes, now - prev.t);
        }
      }

      // Dropped frames over the last ~5 s.
      let droppedRatio: number | null = null;
      if (typeof v.getVideoPlaybackQuality === 'function') {
        const q = v.getVideoPlaybackQuality();
        lastQuality.current.push({ dropped: q.droppedVideoFrames, total: q.totalVideoFrames });
        if (lastQuality.current.length > 6) lastQuality.current.shift();
        const a = lastQuality.current[0];
        const b = lastQuality.current[lastQuality.current.length - 1];
        if (b.total - a.total > 60) droppedRatio = (b.dropped - a.dropped) / (b.total - a.total);
      }

      let est = estimator.current.estimate;
      const c = ensureController();
      setState((s) => (s.estimate === est ? s : { ...s, estimate: est }));
      if (est && now - rememberAt > 30000) {
        rememberAt = now;
        rememberBandwidth(est);
      }
      if (!c || c.mode === 'native') return;

      // Direct play stalling with no estimate yet: measure now (the probe shares the link with the video, so it reads low — fine for a down-switch).
      if (c.mode === 'restart' && stalls.current.length >= 2 && !probing) {
        stalls.current = [];
        if (!est) {
          probing = true;
          void measureBandwidth({ targetMs: 400 }).then((bps) => estimator.current.seed(bps, 3)).catch(() => {}).finally(() => (probing = false));
          return;
        }
        // Treat as an emergency: what fits the estimate now.
        est = Math.min(est, (info.sourceBitrate ?? Infinity) * 1000 * 0.9);
      }

      const d = c.c.update({ now, bandwidth: est, bufferS: c.mode === 'restart' && stalls.current.length ? Math.min(buf, 1) : buf, droppedRatio, playing });
      if (!d) return;
      const target = c.levels[d.level];
      const label = target.label;
      if (c.mode === 'renditions' && target.kind === 'variant') {
        attached.current?.setLevel?.(target.index!);
        setState((s) => ({ ...s, level: label, lastSwitch: `${d.direction} → ${label} (${d.reason})` }));
        live.current.notify(d.direction === 'down' ? `Lowered quality to ${label} due to connection speed` : `Quality raised to ${label}`, d.direction);
        return;
      }
      // Restart-based switch (direct play ↔ transcode). Rate-limit restarts.
      const since = now - lastRestart.current;
      if (since < (d.direction === 'up' ? 60000 : 15000)) return;
      lastRestart.current = now;
      const kbps = Math.round((est ?? target.bitrate) / 1000);
      setState((s) => ({ ...s, lastSwitch: `${d.direction} → ${label} (${d.reason})` }));
      live.current.notify(
        d.direction === 'down'
          ? `Lowered quality${target.kind === 'step' ? ` to ${label}` : ''} due to connection speed`
          : target.kind === 'original' ? 'Connection improved: back to original quality' : `Quality raised to ${label}`,
        d.direction,
      );
      live.current.onRestart(d.direction === 'down' ? Math.min(kbps, Math.round(target.bitrate / 1000 / 0.8)) : kbps, d.direction);
    }, 1000);
    return () => window.clearInterval(iv);
  }, [o.enabled, ensureController]);

  return { state, seed, onFragment, onLevelSwitched, estimator, describe: () => describe(state) };
}

function describe(s: AdaptiveState): string {
  if (s.mode === 'off') return 'Off (fixed quality)';
  const mode = s.mode === 'renditions' ? 'renditions' : s.mode === 'restart' ? 'restart' : 'player ABR';
  return `Auto · ${mode}${s.level ? ` · ${s.level}` : ''} · est. ${formatBps(s.estimate)}${s.lastSwitch ? ` · last ${s.lastSwitch}` : ''}`;
}
