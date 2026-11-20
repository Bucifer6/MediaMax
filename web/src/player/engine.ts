import type { PlaybackInfo } from '@mediamax/shared';
import { getToken } from '../api/client';
import { supportsMse, supportsNativeHls } from './deviceProfile';

export interface AttachOptions {
  /** Called on unrecoverable errors. `kind` lets callers decide on fallbacks. */
  onFatal: (kind: 'hls' | 'mpegts' | 'native' | 'unsupported', message: string) => void;
  live?: boolean;
  /**
   * Our ABR (abr.ts) drives quality: hls.js's own level switching is disabled after the manifest loads, and the stream
   * starts on the first variant of the master playlist (the server lists the best fit for the measured bandwidth first).
   */
  manualLevels?: boolean;
  /** Called for each media fragment: bytes and transfer time (first → last byte, ms), for bandwidth estimation. */
  onFragment?: (bytes: number, ms: number) => void;
  /** The variant being played changed (index into `levels()`). */
  onLevelSwitched?: (level: number) => void;
}

export interface EngineLevel {
  bitrate: number;
  width: number;
  height: number;
}

export interface StreamStats {
  videoCodec?: string | null;
  audioCodec?: string | null;
  /** Bitrate of the variant being played (bits/s). */
  bitrate?: number | null;
  /** Estimated network throughput (bits/s). */
  bandwidth?: number | null;
}

export interface Attached {
  destroy: () => void;
  engine: 'hls.js' | 'native-hls' | 'mpegts' | 'native';
  /** Engine-level details for the stats overlay (hls.js / mpegts.js only). */
  stats?: () => StreamStats;
  /** Variants of a multi-variant HLS stream (hls.js only), lowest bitrate first. */
  levels?: () => EngineLevel[];
  /** Switch variant at the next fragment boundary (hls.js `nextLevel`), or at once, dropping the buffer (`immediate`). */
  setLevel?: (level: number, immediate?: boolean) => void;
  currentLevel?: () => number;
  /** The media fragment being downloaded right now: bytes so far and ms since its first byte (null when idle). */
  inflight?: () => { bytes: number; ms: number } | null;
}

function absolute(url: string) {
  return new URL(url, window.location.origin).href;
}

function isTs(info: PlaybackInfo) {
  return /mp2t|mpegts/i.test(info.mimeType) || /\.ts(\?|$)/i.test(info.url);
}

/** Attach a PlaybackInfo stream to a media element using the best engine available. */
export async function attachStream(el: HTMLMediaElement, info: PlaybackInfo, opts: AttachOptions): Promise<Attached> {
  const url = info.url;
  if (info.isHls) {
    const Hls = (await import('hls.js')).default;
    if (Hls.isSupported()) {
      const token = getToken();
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: opts.live ? 30 : 90,
        maxBufferLength: 30,
        startPosition: -1,
        xhrSetup: (xhr) => {
          if (token) xhr.setRequestHeader('Authorization', `Bearer ${token}`);
        },
      });
      let recovered = 0;
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recovered < 2) {
          recovered++;
          hls.recoverMediaError();
        } else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && recovered < 3) {
          recovered++;
          window.setTimeout(() => hls.startLoad(), 1000 * recovered);
        } else {
          opts.onFatal('hls', data.details || 'Playback error');
        }
      });
      if (opts.manualLevels) {
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (hls.levels.length > 1) hls.loadLevel = hls.firstLevel;
        });
      }
      if (opts.onFragment) {
        hls.on(Hls.Events.FRAG_LOADED, (_e, data) => {
          const st = data.frag.stats;
          if (data.frag.sn === 'initSegment' || !st.loaded) return;
          const first = st.loading.first || st.loading.start;
          opts.onFragment!(st.loaded, Math.max(1, st.loading.end - first));
        });
      }
      if (opts.onLevelSwitched) hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => opts.onLevelSwitched!(data.level));
      // Fragment in flight, for ABR decisions before a slow download completes.
      let loading: { stats: { loaded: number; loading: { first: number } } } | null = null;
      hls.on(Hls.Events.FRAG_LOADING, (_e, data) => {
        if (data.frag.sn !== 'initSegment') loading = data.frag;
      });
      hls.on(Hls.Events.FRAG_LOADED, () => {
        loading = null;
      });
      hls.loadSource(url);
      hls.attachMedia(el);
      return {
        engine: 'hls.js',
        destroy: () => hls.destroy(),
        levels: () => hls.levels.map((l) => ({ bitrate: l.bitrate, width: l.width, height: l.height })),
        setLevel: (level: number, immediate?: boolean) => {
          if (level < 0 || level >= hls.levels.length) return;
          if (immediate) hls.currentLevel = level;
          else hls.nextLevel = level;
        },
        currentLevel: () => hls.currentLevel,
        inflight: () => {
          const st = loading?.stats;
          if (!st || !st.loading.first) return null;
          return { bytes: st.loaded, ms: performance.now() - st.loading.first };
        },
        stats: () => {
          const lvl = hls.levels[hls.currentLevel] ?? hls.levels[0];
          return {
            videoCodec: lvl?.videoCodec ?? null,
            audioCodec: lvl?.audioCodec ?? null,
            bitrate: lvl?.bitrate ?? null,
            bandwidth: Number.isFinite(hls.bandwidthEstimate) ? hls.bandwidthEstimate : null,
          };
        },
      };
    }
    if (supportsNativeHls()) {
      el.src = url;
      return { engine: 'native-hls', destroy: () => detach(el) };
    }
    opts.onFatal('unsupported', 'This browser cannot play HLS streams');
    return { engine: 'native', destroy: () => {} };
  }

  if (isTs(info) && el instanceof HTMLVideoElement) {
    const mpegts = (await import('mpegts.js')).default;
    if (supportsMse() && mpegts.isSupported()) {
      const player = mpegts.createPlayer(
        { type: 'mpegts', isLive: opts.live ?? true, url: absolute(url) },
        { enableWorker: true, liveBufferLatencyChasing: true, lazyLoad: false, autoCleanupSourceBuffer: true },
      );
      player.on(mpegts.Events.ERROR, (type: string, detail: string) => opts.onFatal('mpegts', `${type}: ${detail}`));
      player.attachMediaElement(el);
      player.load();
      return {
        engine: 'mpegts',
        stats: () => {
          const mi = (player.mediaInfo ?? {}) as { videoCodec?: string; audioCodec?: string };
          const si = (player.statisticsInfo ?? {}) as { speed?: number };
          return { videoCodec: mi.videoCodec ?? null, audioCodec: mi.audioCodec ?? null, bandwidth: si.speed ? si.speed * 8 * 1024 : null };
        },
        destroy: () => {
          try {
            player.pause();
            player.unload();
            player.detachMediaElement();
            player.destroy();
          } catch {
            /* ignore */
          }
        },
      };
    }
    opts.onFatal('mpegts', 'MPEG-TS playback not supported in this browser');
    return { engine: 'native', destroy: () => {} };
  }

  el.src = url;
  const onErr = () => opts.onFatal('native', el.error?.message || 'The media could not be played');
  el.addEventListener('error', onErr);
  return {
    engine: 'native',
    destroy: () => {
      el.removeEventListener('error', onErr);
      detach(el);
    },
  };
}

function detach(el: HTMLMediaElement) {
  try {
    el.pause();
    el.removeAttribute('src');
    el.load();
  } catch {
    /* ignore */
  }
}
