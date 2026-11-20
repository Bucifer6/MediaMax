/**
 * Listening comforts on the phone / TV apps (night mode, dialogue boost, loudness normalisation, lip-sync delay).
 * expo-video (AVPlayer / Media3) has no audio-effect hooks, so the server applies them: the playback request asks for
 * an audio-only re-encode (`forceAudioProcessing`; the video is still copied). See docs/AUDIO.md.
 */
import type { AudioComforts, PlaybackRequest, UserPreferences } from './types';
import { deviceInfoSync } from './device';

/** User defaults with this device's own overrides (lip-sync delay) on top. */
export function deviceComforts(prefs: Pick<UserPreferences, 'audio' | 'audioDevices'> | undefined | null): AudioComforts {
  const id = deviceInfoSync()?.deviceId;
  return { ...(prefs?.audio ?? {}), ...(id ? prefs?.audioDevices?.[id] ?? {} : {}) };
}

export function comfortRequest(c: AudioComforts): Pick<PlaybackRequest, 'audioProcessing' | 'forceAudioProcessing'> {
  const on = !!(c.nightMode || c.dialogueBoost || c.normalize || c.delayMs);
  return on ? { audioProcessing: c, forceAudioProcessing: true } : {};
}

/** Lip-sync choices (ms): positive = sound later. */
export const LIP_SYNC_OPTIONS = [-500, -300, -200, -150, -100, -50, 0, 50, 100, 150, 200, 300, 500, 800];

export function formatDelay(ms: number): string {
  if (!ms) return 'Off';
  return `${ms > 0 ? '+' : '−'}${Math.abs(ms)} ms ${ms > 0 ? '(sound later)' : '(sound earlier)'}`;
}
