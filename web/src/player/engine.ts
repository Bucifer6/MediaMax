import type { PlaybackInfo } from '@mediamax/shared';
import { getToken } from '../api/client';
import { supportsMse, supportsNativeHls } from './deviceProfile';

export interface AttachOptions {
  /** Called on unrecoverable errors. `kind` lets callers decide on fallbacks. */
  onFatal: (kind: 'hls' | 'mpegts' | 'native' | 'unsupported', message: string) => void;
  live?: boolean;
}

export interface Attached {
  destroy: () => void;
  engine: 'hls.js' | 'native-hls' | 'mpegts' | 'native';
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
      hls.loadSource(url);
      hls.attachMedia(el);
      return { engine: 'hls.js', destroy: () => hls.destroy() };
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
