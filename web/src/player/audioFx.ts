/**
 * Listening comforts in the web player.
 *
 * During direct play (and when the server copies the audio) night mode, dialogue boost and a positive audio delay run
 * locally in Web Audio — no transcode needed: <video> → MediaElementSource → peaking EQ (speech band) → compressor +
 * make-up gain → DelayNode → speakers. Loudness normalisation and negative delays (sound earlier than the picture)
 * need the server: the player then asks for an audio-only re-encode (`forceAudioProcessing`, video is still copied).
 * Comforts the server already applied (`PlaybackInfo.audio.applied`) are never applied twice. TV engines decode audio
 * outside Web Audio, so there everything goes through the server. See docs/AUDIO.md.
 */
import type { AudioComforts, PlaybackInfo, PlaybackRequest, UserPreferences } from '@mediamax/shared';

export const AUDIO_DELAY_MAX_MS = 3000;

/** Comforts for this device: user defaults with the device's own overrides (lip-sync delay) on top. */
export function deviceComforts(prefs: Pick<UserPreferences, 'audio' | 'audioDevices'> | undefined, deviceId: string): AudioComforts {
  return { ...(prefs?.audio ?? {}), ...(prefs?.audioDevices?.[deviceId] ?? {}) };
}

const any = (c: AudioComforts) => !!(c.nightMode || c.dialogueBoost || c.normalize || c.delayMs);

/** Request fields: comforts ride along when the server encodes anyway; forced when only the server can do them. */
export function comfortRequest(c: AudioComforts, webAudioFx: boolean): Pick<PlaybackRequest, 'audioProcessing' | 'forceAudioProcessing'> {
  if (!any(c)) return {};
  const serverOnly = !!c.normalize || (c.delayMs ?? 0) < 0 || (c.delayMs ?? 0) > AUDIO_DELAY_MAX_MS || !webAudioFx;
  return { audioProcessing: c, ...(serverOnly ? { forceAudioProcessing: true } : {}) };
}

export interface ClientFx {
  nightMode: boolean;
  dialogueBoost: boolean;
  /** ms, ≥ 0 (Web Audio can only hold sound back). */
  delayMs: number;
}

/** What the web player applies itself for this stream (the rest was done by the server or can't be done here). */
export function clientFx(c: AudioComforts, info: Pick<PlaybackInfo, 'audio'> | null, webAudioFx: boolean): ClientFx {
  const applied = new Set(info?.audio?.applied ?? []);
  if (!webAudioFx) return { nightMode: false, dialogueBoost: false, delayMs: 0 };
  return {
    nightMode: !!c.nightMode && !applied.has('nightMode'),
    dialogueBoost: !!c.dialogueBoost && !applied.has('dialogueBoost'),
    delayMs: applied.has('delayMs') ? 0 : Math.max(0, Math.min(AUDIO_DELAY_MAX_MS, c.delayMs ?? 0)),
  };
}

/** Web Audio processing chain on a media element. Once created, the element's sound always flows through it. */
export class AudioFx {
  readonly ctx: AudioContext;
  private readonly eq: BiquadFilterNode;
  private readonly comp: DynamicsCompressorNode;
  private readonly makeup: GainNode;
  readonly delay: DelayNode;

  constructor(el: HTMLMediaElement) {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctx();
    const src = this.ctx.createMediaElementSource(el);
    this.eq = this.ctx.createBiquadFilter();
    this.eq.type = 'peaking';
    this.eq.frequency.value = 2000;
    this.eq.Q.value = 0.7;
    this.eq.gain.value = 0;
    this.comp = this.ctx.createDynamicsCompressor();
    this.makeup = this.ctx.createGain();
    this.delay = this.ctx.createDelay(AUDIO_DELAY_MAX_MS / 1000 + 1);
    src.connect(this.eq).connect(this.comp).connect(this.makeup).connect(this.delay).connect(this.ctx.destination);
    this.set({ nightMode: false, dialogueBoost: false, delayMs: 0 });
  }

  set(fx: ClientFx) {
    const t = this.ctx.currentTime;
    void this.ctx.resume().catch(() => {});
    // Dialogue: +5 dB around 2 kHz (consonants / speech intelligibility).
    this.eq.gain.setTargetAtTime(fx.dialogueBoost ? 5 : 0, t, 0.05);
    // Night mode: 4:1 above −24 dB, soft knee, +6 dB make-up. Off = transparent (ratio 1).
    this.comp.threshold.setValueAtTime(fx.nightMode ? -24 : 0, t);
    this.comp.knee.setValueAtTime(fx.nightMode ? 6 : 0, t);
    this.comp.ratio.setValueAtTime(fx.nightMode ? 4 : 1, t);
    this.comp.attack.setValueAtTime(0.02, t);
    this.comp.release.setValueAtTime(0.25, t);
    this.makeup.gain.setTargetAtTime(fx.nightMode ? 2 : 1, t, 0.05);
    this.delay.delayTime.setTargetAtTime(fx.delayMs / 1000, t, 0.03);
  }

  close() {
    void this.ctx.close().catch(() => {});
  }
}

export const fxActive = (fx: ClientFx) => fx.nightMode || fx.dialogueBoost || fx.delayMs > 0;
