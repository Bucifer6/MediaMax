import { useEffect, useState } from 'react';
import type { AudioComforts } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { getDeviceId } from '../api/device';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { initAudioCaps, type AudioCaps } from '../player/audioCaps';
import { HelpLink } from './HelpLink';

/** "+0.12s" / "−0.30s" (same style as the player's sync menu). */
function formatDelay(ms: number) {
  const r = Math.round(ms / 10) * 10;
  return `${r > 0 ? '+' : r < 0 ? '\u2212' : ''}${Math.abs(r / 1000).toFixed(2)}s`;
}

const TOGGLES = [
  ['nightMode', 'Night mode', 'Compresses the dynamic range: quiet dialogue gets louder, explosions softer. Good for late evenings.'],
  ['dialogueBoost', 'Dialogue boost', 'Lifts the centre (dialogue) channel before the stereo downmix, or the speech band on stereo tracks.'],
  ['normalize', 'Normalise volume', 'Evens out loudness between titles (EBU R128). The server re-encodes the audio for this; the picture is untouched.'],
] as const;

/** Settings → Playback → Audio: listening comforts (all devices) and this device's lip-sync delay. */
export function AudioSettingsCard() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const [caps, setCaps] = useState<AudioCaps | null>(null);
  useEffect(() => {
    let alive = true;
    void initAudioCaps().then((c) => alive && setCaps(c));
    return () => { alive = false; };
  }, []);
  const deviceId = getDeviceId();
  const comforts: AudioComforts = user?.preferences.audio ?? {};
  const deviceDelay = user?.preferences.audioDevices?.[deviceId]?.delayMs ?? 0;
  const [delay, setDelay] = useState(deviceDelay);
  useEffect(() => setDelay(deviceDelay), [deviceDelay]);

  const save = async (patch: { audio?: AudioComforts; audioDevices?: Record<string, AudioComforts> }) => {
    if (!user) return;
    setUser({ ...user, preferences: { ...user.preferences, ...patch, audioDevices: { ...(user.preferences.audioDevices ?? {}), ...(patch.audioDevices ?? {}) } } });
    try {
      setUser(await api.auth.updateMe({ preferences: patch }));
    } catch (e) {
      setUser(user);
      toast.error(e);
    }
  };
  const saveDelay = () => delay !== deviceDelay && void save({ audioDevices: { [deviceId]: delay ? { delayMs: delay } : {} } });

  return (
    <div className="settings-card audio-settings" id="audio">
      <h2>Audio <HelpLink slug="audio" label="Audio" /></h2>
      {TOGGLES.map(([key, label, hint]) => (
        <button key={key} type="button" role="switch" aria-checked={!!comforts[key]} className="audio-toggle" onClick={() => void save({ audio: { ...comforts, [key]: !comforts[key] } })}>
          <span>{label}<small>{hint}</small></span>
          <i className="audio-switch" aria-hidden="true" />
        </button>
      ))}
      <div className="audio-delay-row">
        <label htmlFor="audio-lipsync">Lip-sync on this device</label>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDelay((d) => Math.max(-2000, d - 10))} aria-label="Sound earlier">−</button>
        <output aria-live="polite">{formatDelay(delay)}</output>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setDelay((d) => Math.min(2000, d + 10))} aria-label="Sound later">+</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={saveDelay} disabled={delay === deviceDelay}>Save</button>
        <input
          id="audio-lipsync"
          type="range"
          min={-2000}
          max={2000}
          step={10}
          value={delay}
          onChange={(e) => setDelay(Number(e.target.value))}
          onPointerUp={saveDelay}
          onKeyUp={saveDelay}
        />
      </div>
      <p className="audio-note">
        For a soundbar or AV receiver that lags behind (or runs ahead of) the picture. Positive values delay the sound. A delay is applied in this
        browser during direct play; sound that must come <em>earlier</em> is shifted by the server, which re-encodes the audio track.
      </p>
      {caps && (
        <dl className="kv">
          <dt>Speakers</dt><dd>{caps.maxAudioChannels >= 8 ? '7.1' : caps.maxAudioChannels >= 6 ? '5.1' : 'Stereo'} ({caps.maxAudioChannels} channels reported)</dd>
          <dt>Surround formats</dt><dd>{[caps.audioCodecs.includes('eac3') && 'Dolby Digital Plus', caps.audioCodecs.includes('ac3') && 'Dolby Digital', caps.atmos && 'Dolby Atmos'].filter(Boolean).join(', ') || 'None — surround tracks are converted to AAC by the server'}</dd>
          <dt>Effects</dt><dd>{caps.webAudioFx ? 'Applied in this browser during direct play' : 'Applied by the server (this device decodes sound in hardware)'}</dd>
        </dl>
      )}
    </div>
  );
}
