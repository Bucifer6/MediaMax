/**
 * TV remote keys beyond the D-pad (digits, colour keys, Info, Guide, channel and track keys), delivered by the
 * MediaMaxMedia native module on Android TV / Google TV / Fire TV (HDMI-CEC and Bluetooth remotes alike). Key names
 * follow W3C KeyboardEvent.key, the same as the web TV mode (web/src/tv/spatial.ts). Apple TV remotes have none of
 * these keys, so this is a no-op there.
 */
import { useEffect, useRef } from 'react';
import { MediaMaxMedia } from '../../modules/mediamax-media';
import type { PlaybackInfo } from '@/api/types';

export function useNativeRemoteKeys(handler: (key: string) => void, enabled = true) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!enabled || !MediaMaxMedia) return;
    const sub = MediaMaxMedia.addListener('onRemoteKey', (e) => ref.current(e.key));
    return () => sub.remove();
  }, [enabled]);
}

/** Collects digits into a channel number and commits it after a short pause (1.5 s), like a TV. */
export function createNumberEntry(onCommit: (num: string) => void, onTyping: (typed: string) => void, delayMs = 1500) {
  let typed = '';
  let timer: ReturnType<typeof setTimeout> | null = null;
  return {
    push(d: string) {
      typed = (typed + d).slice(-4);
      onTyping(typed);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const n = typed;
        typed = '';
        timer = null;
        onCommit(n);
      }, delayMs);
    },
    cancel() {
      if (timer) clearTimeout(timer);
      typed = '';
      timer = null;
    },
  };
}

/**
 * Apple TV (tvOS 17+, Settings → Video and Audio → Match Content): switch the TV to the stream's dynamic range and
 * frame rate while it plays. Android TV needs nothing here: Media3 matches the frame rate itself when the switch is
 * seamless. Returns a cleanup that restores the user's default display mode.
 */
export function matchDisplayFor(info: PlaybackInfo | null): () => void {
  const vr = info?.videoRange;
  if (!MediaMaxMedia || !vr) return () => undefined;
  const range = vr.output ?? 'sdr';
  const fps = vr.frameRate ?? 0;
  if (range === 'sdr' && !fps) return () => undefined;
  void MediaMaxMedia.matchDisplay(fps, range).catch(() => false);
  return () => {
    void MediaMaxMedia?.resetDisplay().catch(() => undefined);
  };
}
