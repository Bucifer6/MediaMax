import { useEffect, useRef } from 'react';
import type { RemotePlayerState, RemoteTrack } from '@mediamax/shared';
import { realtime } from '../api/ws';

/** What the player shows right now (reported to your other devices and paired phones). */
export interface RemoteSnapshot {
  itemId: string;
  title: string;
  subtitle: string | null;
  posterUrl: string | null;
  positionMs: number;
  durationMs: number | null;
  paused: boolean;
  /** 0..1 */
  volume: number;
  audioTracks: RemoteTrack[];
  audioIndex: number | null;
  subtitleTracks: RemoteTrack[];
  subtitleIndex: number | null;
  skip: { type: string; label: string } | null;
  nextItemId: string | null;
}

/** Transport handlers the player exposes to remote commands. */
export interface RemoteHandlers {
  togglePlay: () => void;
  seekTo: (ms: number) => void;
  setVolume: (v: number) => void;
  next: () => void;
  stop: () => void;
  setAudio: (index: number) => void;
  setSubtitle: (index: number | null) => void;
  skip: () => void;
}

const STATE_INTERVAL_MS = 10_000;
const SEEK_DRIFT_MS = 3000;

function toState(s: RemoteSnapshot): RemotePlayerState {
  return {
    itemId: s.itemId, channelId: null, title: s.title, subtitle: s.subtitle, posterUrl: s.posterUrl, positionMs: Math.round(s.positionMs),
    durationMs: s.durationMs ? Math.round(s.durationMs) : null, paused: s.paused, volume: Math.round(s.volume * 100),
    audioTracks: s.audioTracks, audioIndex: s.audioIndex, subtitleTracks: s.subtitleTracks, subtitleIndex: s.subtitleIndex, skip: s.skip, nextItemId: s.nextItemId,
  };
}

/** Fields whose change is reported at once (position is reported on seeks and every 10 s while playing). */
const key = (s: RemotePlayerState) => JSON.stringify([s.itemId, s.paused, s.title, s.volume, s.durationMs, s.audioIndex, s.subtitleIndex, s.skip?.type ?? null, s.audioTracks?.length, s.subtitleTracks?.length, s.nextItemId]);

/**
 * Makes the web player a remote-control target: reports `remote.state` (with tracks, Skip button and next episode
 * for the second screen) and applies `remote.command`s from your devices or a paired phone. `playItem` /
 * `playChannel` are handled app-wide (RemoteHost).
 */
export function useRemoteTarget(snapshot: RemoteSnapshot | null, handlers: RemoteHandlers) {
  const snap = useRef(snapshot);
  snap.current = snapshot;
  const h = useRef(handlers);
  h.current = handlers;
  const last = useRef<{ key: string; state: RemotePlayerState; at: number } | null>(null);

  useEffect(() => {
    const push = () => {
      if (!realtime.open) return;
      const s = snap.current;
      if (!s?.itemId) return;
      const st = toState(s);
      const now = Date.now();
      const prev = last.current;
      const k = key(st);
      let send = !prev || prev.key !== k;
      if (!send && prev) {
        const expected = prev.state.positionMs + (prev.state.paused ? 0 : now - prev.at);
        send = Math.abs(st.positionMs - expected) > SEEK_DRIFT_MS || (!st.paused && now - prev.at >= STATE_INTERVAL_MS);
      }
      if (!send) return;
      realtime.send({ type: 'remote.state', state: st });
      last.current = { key: k, state: st, at: now };
    };
    const t = window.setInterval(push, 1000);
    const off = realtime.onStatus((open) => {
      if (open) last.current = null;
    });
    return () => {
      window.clearInterval(t);
      off();
      if (last.current && realtime.open) realtime.send({ type: 'remote.state', state: null });
      last.current = null;
    };
  }, []);

  useEffect(() => realtime.subscribe((ev) => {
    if (ev.type !== 'remote.command') return;
    const s = snap.current;
    const a = h.current;
    switch (ev.action) {
      case 'play': if (s?.paused) a.togglePlay(); break;
      case 'pause': if (s && !s.paused) a.togglePlay(); break;
      case 'togglePause': a.togglePlay(); break;
      case 'seek': if (ev.positionMs != null) a.seekTo(ev.positionMs); break;
      case 'setVolume': if (ev.volume != null) a.setVolume(Math.max(0, Math.min(100, ev.volume)) / 100); break;
      case 'next': a.next(); break;
      case 'previous': if (s) a.seekTo(Math.max(0, s.positionMs - 30_000)); break;
      case 'stop': a.stop(); break;
      case 'setAudioTrack': if (ev.trackIndex != null) a.setAudio(ev.trackIndex); break;
      case 'setSubtitleTrack': a.setSubtitle(ev.trackIndex ?? null); break;
      case 'skipSegment': a.skip(); break;
      default: return;
    }
    // Report the result straight away.
    last.current = null;
  }), []);
}
