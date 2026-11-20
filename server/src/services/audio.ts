/**
 * Audio: format detection (from ffprobe JSON), the delivery decision for a client's audio capabilities, and the
 * FFmpeg arguments for it (codec, downmix, listening comforts). Pure functions except `refreshAudioStreams`, so the
 * decision matrix is easy to unit-test with fixture JSON. See docs/AUDIO.md.
 *
 * Decision order for the selected track (smart clients: the device profile has `maxAudioChannels`):
 *   1. copy        the client decodes it, or passes the format through to an AV receiver / soundbar (bitstream).
 *                  Atmos / DTS:X objects survive only when the client lists eac3-joc / truehd / dts-hd(-x).
 *   2. dts-core    DTS-HD MA / HRA / DTS:X → its DTS core, copied (`-bsf:a dca_core`): no re-encode, for DTS-only devices.
 *   3. E-AC-3 5.1  multichannel sources (TrueHD Atmos, DTS for Apple, FLAC 7.1 …) for clients that pass through or
 *                  decode E-AC-3 (TVs + soundbars over ARC, Apple TV, Android TV). FFmpeg's E-AC-3 encoder stops at
 *                  5.1 and can't write Atmos (JOC) metadata, so objects are lost. AC-3 5.1 when only AC-3 passes.
 *   4. AAC         7.1 when the client outputs 8 channels and decodes multichannel AAC, else 5.1, else stereo with
 *                  a Dolby Lo/Ro style downmix (centre −3 dB, surrounds −6 dB, LFE dropped, limiter against clipping).
 * Legacy clients (no `maxAudioChannels`): copy when the codec is listed, otherwise AAC 5.1 / stereo as before.
 */
import fs from 'node:fs';
import type { AudioComforts, AudioDecisionInfo, AudioStream, DeviceProfile } from '@mediamax/shared';

/* ------------------------------ detection ------------------------------ */

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const LOSSLESS = new Set(['truehd', 'mlp', 'flac', 'alac', 'wavpack', 'ape', 'tta']);

/** Short format name, e.g. "TrueHD Atmos", "DTS:X", "DTS-HD MA", "E-AC-3 Atmos", "AAC". */
export function audioFormatLabel(a: Pick<AudioStream, 'codec' | 'profile' | 'atmos' | 'dtsX' | 'dtsHdMa'>): string {
  const c = (a.codec ?? '').toLowerCase();
  const prof = a.profile ?? '';
  switch (c) {
    case 'truehd': return a.atmos ? 'TrueHD Atmos' : 'TrueHD';
    case 'eac3': return a.atmos ? 'E-AC-3 Atmos' : 'E-AC-3';
    case 'ac3': return 'AC-3';
    case 'dts':
      if (a.dtsX) return 'DTS:X';
      if (a.dtsHdMa) return 'DTS-HD MA';
      if (/HRA/i.test(prof)) return 'DTS-HD HRA';
      if (/Express/i.test(prof)) return 'DTS Express';
      if (/ES/.test(prof)) return 'DTS-ES';
      return 'DTS';
    case 'aac': return /HE/i.test(prof) ? 'HE-AAC' : 'AAC';
    case 'mp3': return 'MP3';
    case 'flac': return 'FLAC';
    case 'alac': return 'ALAC';
    case 'opus': return 'Opus';
    case 'vorbis': return 'Vorbis';
    case 'mlp': return 'MLP';
    default: return c.startsWith('pcm_') ? 'PCM' : c ? c.toUpperCase() : 'Audio';
  }
}

/** "7.1", "5.1", "Stereo", "Mono" (from the layout when known, else the channel count). */
export function channelLabel(channels: number | null | undefined, layout?: string | null): string {
  const l = (layout ?? '').toLowerCase();
  const m = /^(\d\.\d)/.exec(l);
  if (m) return m[1];
  if (l === 'stereo' || l === 'downmix') return 'Stereo';
  if (l === 'mono') return 'Mono';
  const ch = channels ?? 2;
  if (ch === 1) return 'Mono';
  if (ch === 2) return 'Stereo';
  if (ch >= 6) return `${ch - 1}.1`;
  return `${ch}.0`;
}

/** Full stream description, e.g. "TrueHD Atmos 7.1". */
export const audioStreamLabel = (a: AudioStream) => `${a.formatLabel ?? audioFormatLabel(a)} ${channelLabel(a.channels, a.channelLayout)}`;

/** AudioStream (index, codec, flags, layout …) from an ffprobe audio stream. Pass `normLang` for the language tag. */
export function parseAudioStream(s: any, normLang: (l: string | undefined | null) => string | null = (l) => l ?? null): AudioStream {
  const codec: string = s.codec_name ?? 'unknown';
  const profile: string | null = s.profile && s.profile !== 'unknown' ? String(s.profile) : null;
  const title: string | null = s.tags?.title ?? null;
  const both = `${profile ?? ''} ${title ?? ''}`;
  const isDts = codec === 'dts';
  // ffmpeg ≥ 6.1 names Atmos / DTS:X in the profile; older builds only leave the track title as a hint.
  const atmos = (codec === 'truehd' || codec === 'eac3') && /atmos|\bJOC\b/i.test(both);
  const dtsX = isDts && /DTS[:\s-]?X\b/i.test(both);
  const dtsHdMa = isDts && (dtsX || /DTS-HD\s*MA|Master Audio/i.test(both));
  const bps = num(s.bit_rate) ?? num(s.tags?.BPS) ?? num(s.tags?.['BPS-eng']);
  const a: AudioStream = {
    index: s.index,
    codec,
    language: normLang(s.tags?.language),
    title,
    channels: s.channels ?? 2,
    default: !!s.disposition?.default,
    profile,
    channelLayout: s.channel_layout ?? null,
    sampleRate: num(s.sample_rate),
    bitDepth: num(s.bits_per_raw_sample) ?? (codec.startsWith('pcm_') ? num(s.bits_per_sample) : null),
    bitrate: bps ? Math.round(bps / 1000) : null,
    atmos,
    dtsX,
    dtsHdMa,
    lossless: LOSSLESS.has(codec) || codec.startsWith('pcm_') || dtsHdMa,
  };
  a.formatLabel = audioFormatLabel(a);
  return a;
}

/** DTS-HD (MA / HRA / DTS:X): carries a DTS core that DTS-only devices can play. */
export const isDtsHd = (a: Pick<AudioStream, 'codec' | 'profile' | 'dtsHdMa' | 'dtsX'>) =>
  a.codec === 'dts' && (!!a.dtsHdMa || !!a.dtsX || /DTS-HD/i.test(a.profile ?? ''));

/* --------------------------- client capabilities --------------------------- */

/** Canonical capability tokens: aac ac3 eac3 eac3-joc truehd dts dts-hd dts-x flac opus mp3 alac pcm … */
export function normAudioToken(t: string): string {
  const s = t.toLowerCase().trim().replace(/_/g, '-');
  if (['ec-3', 'e-ac-3', 'eac-3', 'ddp', 'dd+'].includes(s)) return 'eac3';
  if (['ac-3', 'dd', 'a52'].includes(s)) return 'ac3';
  if (['eac3joc', 'eac3-joc', 'ec-3-joc', 'ec3-joc', 'atmos', 'eac3-atmos', 'ddp-atmos'].includes(s)) return 'eac3-joc';
  if (['dtshd', 'dts-hd', 'dtshd-ma', 'dts-hd-ma', 'dtshdma', 'dts-hdma', 'dts-hd-hra', 'dtshd-hra'].includes(s)) return 'dts-hd';
  if (['dtsx', 'dts:x', 'dts-x', 'dts-uhd'].includes(s)) return 'dts-x';
  if (['dca', 'dts-core'].includes(s)) return 'dts';
  if (['mlp', 'truehd-atmos', 'true-hd', 'dolby-truehd'].includes(s)) return 'truehd';
  if (s.startsWith('pcm')) return 'pcm';
  if (s === 'mp4a' || s === 'mp4a.40.2') return 'aac';
  return s;
}

export interface ClientAudio {
  /** Smart client (sent `maxAudioChannels`). */
  aware: boolean;
  decode: Set<string>;
  pass: Set<string>;
  maxChannels: number;
  /** Codecs decoded with > 2 channels (null = all). */
  multi: Set<string> | null;
  /** Lower-cased codec names exactly as listed (the legacy rule compares ffprobe codec names with these). */
  legacyList: Set<string>;
}

export function clientAudio(p: DeviceProfile | undefined): ClientAudio {
  const decode = new Set((p?.audioCodecs ?? []).map(normAudioToken));
  const pass = new Set((p?.audioPassthrough ?? []).map(normAudioToken));
  const aware = typeof p?.maxAudioChannels === 'number' && p.maxAudioChannels > 0;
  return {
    legacyList: new Set([...(p?.audioCodecs ?? []), ...(p?.audioPassthrough ?? [])].map((s) => s.toLowerCase())),
    aware,
    decode,
    pass,
    maxChannels: aware ? Math.max(1, Math.min(16, Math.round(p!.maxAudioChannels!))) : 6,
    multi: p?.multichannelAudioCodecs ? new Set(p.multichannelAudioCodecs.map(normAudioToken)) : null,
  };
}

const has = (c: ClientAudio, t: string) => c.decode.has(t) || c.pass.has(t);

/** Whether the client takes this stream as is, and whether its object audio (Atmos / DTS:X) survives. */
export function canCopy(a: AudioStream, c: ClientAudio): { ok: boolean; objects: 'kept' | 'lost' | null } {
  const codec = a.codec.toLowerCase();
  const obj = (kept: boolean) => (a.atmos || a.dtsX ? (kept ? 'kept' : 'lost') : null);
  if (!c.aware) {
    // Legacy rule: the codec name is listed (passthrough formats count as supported).
    const ok = c.legacyList.has(codec);
    return { ok, objects: ok ? obj(c.legacyList.has(codec) && c.pass.has(normAudioToken(codec))) : null };
  }
  switch (codec) {
    case 'truehd': {
      const ok = has(c, 'truehd');
      // Atmos inside TrueHD is only rendered by a receiver (bitstream); decoding gives the channel bed.
      return { ok, objects: ok ? obj(c.pass.has('truehd')) : null };
    }
    case 'eac3': {
      const ok = has(c, 'eac3') || has(c, 'eac3-joc');
      return { ok, objects: ok ? obj(has(c, 'eac3-joc')) : null };
    }
    case 'ac3': return { ok: has(c, 'ac3') || has(c, 'eac3'), objects: null };
    case 'dts': {
      if (isDtsHd(a)) {
        const ok = has(c, 'dts-hd') || has(c, 'dts-x');
        return { ok, objects: ok ? obj(c.pass.has('dts-x') || c.pass.has('dts-hd')) : null };
      }
      return { ok: has(c, 'dts') || has(c, 'dts-hd'), objects: null };
    }
    default:
      if (codec.startsWith('pcm_')) return { ok: has(c, 'pcm') || has(c, codec), objects: null };
      return { ok: has(c, normAudioToken(codec)), objects: null };
  }
}

/* -------------------------------- comforts -------------------------------- */

export const AUDIO_DELAY_LIMIT_MS = 5000;

/** Validate comforts from a request / preferences (unknown keys dropped, delay clamped to ±5 s in 10 ms steps). */
export function normalizeComforts(input: unknown): AudioComforts {
  const src = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const out: AudioComforts = {};
  for (const k of ['nightMode', 'dialogueBoost', 'normalize'] as const) if (typeof src[k] === 'boolean') out[k] = src[k] as boolean;
  const d = Number(src.delayMs);
  if (src.delayMs != null && Number.isFinite(d)) out.delayMs = Math.max(-AUDIO_DELAY_LIMIT_MS, Math.min(AUDIO_DELAY_LIMIT_MS, Math.round(d / 10) * 10));
  return out;
}

export const anyComfort = (c: AudioComforts | null | undefined) => !!c && (!!c.nightMode || !!c.dialogueBoost || !!c.normalize || !!c.delayMs);

/** User defaults with this device's overrides on top. */
export function comfortsFor(prefs: { audio?: AudioComforts; audioDevices?: Record<string, AudioComforts> } | undefined, deviceId: string | null | undefined): AudioComforts {
  return { ...normalizeComforts(prefs?.audio), ...(deviceId ? normalizeComforts(prefs?.audioDevices?.[deviceId]) : {}) };
}

/* -------------------------------- decision -------------------------------- */

export type AudioOutCodec = 'copy' | 'aac' | 'eac3' | 'ac3';

export interface AudioPlan {
  delivery: 'copy' | 'dts-core' | 'transcode';
  codec: AudioOutCodec;
  /** Output channels (null when copying: the source's). */
  channels: number | null;
  bitrateKbps: number | null;
  /** -af chain (downmix, comforts); empty for copies. */
  filters: string[];
  /** Bitstream filter for a copy (DTS core extraction). */
  bsf: string | null;
  /** Human reason when the audio isn't passed through as is. */
  reason: string | null;
  objects: 'kept' | 'lost' | null;
  applied: (keyof AudioComforts)[];
  /** Source and output labels for the UI. */
  source: string;
  output: string;
  /** RFC 6381 codec string of the output (HLS CODECS), null when unknown. */
  codecString: string | null;
  /** Source codec (for copy muxing decisions). */
  sourceCodec: string;
  /** The track could be copied as is (direct play / remux need no audio work). */
  copyOk: boolean;
}

export interface PlanOptions {
  comforts?: AudioComforts | null;
  /** Re-encode so the comforts apply even when the audio could be copied. */
  forceProcessing?: boolean;
  /** The stream is being transcoded with audio re-encoding forced (forceTranscode). */
  noCopy?: boolean;
  /** Encoder availability (tests can stub it). */
  hasEncoder?: (name: string) => boolean;
}

/** Typical bitrates (kbps) of copied formats, for the ABR ladder when the container doesn't say. */
const COPY_KBPS: Record<string, number> = { aac: 256, mp3: 320, ac3: 640, eac3: 768, truehd: 4500, dts: 1536, 'dts-hd': 4000, flac: 1200, alac: 1200, opus: 256, vorbis: 256, pcm: 4600 };

function copyKbps(a: AudioStream, core = false): number {
  if (core) return 1536;
  if (a.bitrate) return a.bitrate;
  const c = a.codec.startsWith('pcm_') ? 'pcm' : a.codec === 'dts' && isDtsHd(a) ? 'dts-hd' : a.codec;
  return COPY_KBPS[c] ?? 320;
}

/** RFC 6381 codec string for an audio format. */
export function audioCodecString(codec: string, a?: AudioStream | null, core = false): string | null {
  switch (codec) {
    case 'aac': return a && /HE/i.test(a.profile ?? '') ? 'mp4a.40.5' : 'mp4a.40.2';
    case 'mp3': return 'mp4a.40.34';
    case 'ac3': return 'ac-3';
    case 'eac3': return 'ec-3';
    case 'flac': return 'fLaC';
    case 'opus': return 'Opus';
    case 'alac': return 'alac';
    case 'truehd': return 'mlpa';
    case 'dts': return core || !a || !isDtsHd(a) ? 'dtsc' : a.dtsHdMa ? 'dtsl' : 'dtsh';
    default: return null;
  }
}

const reasonOf = (src: string, out: string, why: string) => `${src} → ${out}: ${why}`;

function whyNot(a: AudioStream, c: ClientAudio): string {
  const f = a.formatLabel ?? audioFormatLabel(a);
  if (a.codec === 'dts' && isDtsHd(a) && has(c, 'dts')) return 'device plays DTS but not DTS-HD';
  const base = f.replace(/ Atmos$/, '');
  return `device can't play ${base}`;
}

/**
 * Audio delivery plan for one track. `profile` is the client's device profile merged over the server defaults.
 * Legacy profiles (no `maxAudioChannels`) keep the old behaviour: copy when listed, else AAC 5.1 / stereo.
 */
export function planAudio(a: AudioStream, profile: DeviceProfile | undefined, o: PlanOptions = {}): AudioPlan {
  const c = clientAudio(profile);
  const comforts = normalizeComforts(o.comforts);
  const wantFx = anyComfort(comforts);
  const encoderOk = o.hasEncoder ?? (() => true);
  const source = audioStreamLabel(a);
  const copy = canCopy(a, c);
  const copyOk = copy.ok && !(o.forceProcessing && wantFx);
  const base = { source, sourceCodec: a.codec, copyOk };

  if (copy.ok && !o.noCopy && !(o.forceProcessing && wantFx)) {
    return {
      ...base, delivery: 'copy', codec: 'copy', channels: null, bitrateKbps: copyKbps(a), filters: [], bsf: null, reason: null,
      objects: copy.objects, applied: [], output: source, codecString: audioCodecString(a.codec, a),
    };
  }
  const why = o.noCopy ? 'transcoding requested' : o.forceProcessing && wantFx && copy.ok ? 'audio processing requested' : whyNot(a, c);

  // DTS-HD → DTS core, no re-encode (comforts need decoded audio, so not when they are wanted).
  if (c.aware && !o.noCopy && !wantFx && isDtsHd(a) && has(c, 'dts')) {
    const ch = Math.min(a.channels || 6, 6);
    const output = `DTS ${channelLabel(ch)} (core)`;
    return {
      ...base, delivery: 'dts-core', codec: 'copy', channels: ch, bitrateKbps: copyKbps(a, true), filters: [], bsf: 'dca_core',
      reason: reasonOf(a.formatLabel ?? audioFormatLabel(a), 'DTS core', why), objects: a.dtsX ? 'lost' : null, applied: [], output,
      codecString: 'dtsc',
    };
  }

  const srcCh = Math.max(1, a.channels || 2);
  const multiOk = (t: string) => c.maxChannels >= 6 && (c.multi ? c.multi.has(t) : true);
  let codec: AudioOutCodec = 'aac';
  let ch: number;
  let kbps: number;
  if (!c.aware) {
    // Legacy: AAC, at most 5.1.
    ch = Math.min(srcCh, 6) > 2 ? 6 : 2;
    kbps = ch > 2 ? 384 : 192;
  } else if (srcCh > 2 && (c.pass.has('eac3') || c.pass.has('eac3-joc') || ((c.decode.has('eac3') || c.decode.has('eac3-joc')) && multiOk('eac3'))) && encoderOk('eac3')) {
    // FFmpeg's E-AC-3 encoder supports up to 5.1.
    codec = 'eac3';
    ch = Math.min(srcCh, 6);
    kbps = ch >= 6 ? 640 : 448;
  } else if (srcCh > 2 && (c.pass.has('ac3') || (c.decode.has('ac3') && multiOk('ac3') && !multiOk('aac'))) && encoderOk('ac3')) {
    codec = 'ac3';
    ch = Math.min(srcCh, 6);
    kbps = ch >= 6 ? 640 : 448;
  } else {
    const aacMulti = c.multi ? c.multi.has('aac') : true;
    ch = srcCh >= 8 && c.maxChannels >= 8 && aacMulti ? 8 : srcCh >= 6 && c.maxChannels >= 6 && aacMulti ? 6 : srcCh > 2 && c.maxChannels > 2 && aacMulti ? Math.min(srcCh, c.maxChannels) : 2;
    if (ch > 2 && ch < 6) ch = 2; // odd layouts (2.1, 4.0, 5.0) downmix to stereo: the most compatible AAC output
    kbps = ch >= 8 ? 512 : ch >= 6 ? 384 : 192;
  }
  const { filters, applied } = audioFilters({ srcChannels: srcCh, srcLayout: a.channelLayout ?? null, outChannels: ch, comforts, legacy: !c.aware });
  const outName = codec === 'eac3' ? 'E-AC-3' : codec === 'ac3' ? 'AC-3' : 'AAC';
  const output = `${outName} ${channelLabel(ch)}`;
  return {
    ...base, delivery: 'transcode', codec, channels: ch, bitrateKbps: kbps, filters, bsf: null,
    reason: reasonOf(source.replace(/ (\d\.\d|Stereo|Mono)$/, ''), output, why),
    objects: a.atmos || a.dtsX ? 'lost' : null, applied, output, codecString: audioCodecString(codec),
  };
}

/* -------------------------------- filters -------------------------------- */

/** Standard layout FFmpeg converts a source to before our own matrix (by channel count). */
function stdLayout(ch: number): '7.1' | '6.1' | '5.1' {
  return ch >= 8 ? '7.1' : ch === 7 ? '6.1' : '5.1';
}

const f3 = (n: number) => String(Math.round(n * 1000) / 1000);
const term = (g: number, ch: string) => `${f3(g)}*${ch}`;

/**
 * Stereo downmix matrix (pan filter) for a multichannel source, Dolby Lo/Ro style (ATSC A/52 §7.8): front at unity,
 * centre −3 dB (0.707) into both sides, surrounds −6 dB (0.5) on their side, LFE dropped. A centre-only signal comes out
 * of both speakers at −3 dB each (same acoustic power as the single centre speaker), so dialogue keeps its level
 * against music and effects. Dialogue boost: centre at unity, fronts −3 dB, surrounds −8 dB.
 */
export function downmixFilter(srcChannels: number, dialogueBoost = false): string {
  const layout = stdLayout(srcChannels);
  const front = dialogueBoost ? 0.707 : 1;
  const centre = dialogueBoost ? 1 : 0.707;
  const surround = dialogueBoost ? 0.4 : 0.5;
  const side = (s: 'L' | 'R') => {
    const t = [term(front, `F${s}`), term(centre, 'FC')];
    if (layout === '5.1') t.push(term(surround, `B${s}`));
    if (layout === '7.1') t.push(term(surround * 0.85, `S${s}`), term(surround * 0.85, `B${s}`));
    if (layout === '6.1') t.push(term(surround, `S${s}`), term(surround * 0.707, 'BC'));
    return t.join('+');
  };
  return `aformat=channel_layouts=${layout},pan=stereo|FL=${side('L')}|FR=${side('R')}`;
}

/** +3 dB on the centre channel of a 5.1 / 7.1 output (dialogue boost without a downmix). */
export function centreBoostFilter(outChannels: number): string {
  const layout = outChannels >= 8 ? '7.1' : '5.1';
  const chans = layout === '7.1' ? ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR', 'SL', 'SR'] : ['FL', 'FR', 'FC', 'LFE', 'BL', 'BR'];
  return `aformat=channel_layouts=${layout},pan=${layout}|${chans.map((c) => `${c}=${c === 'FC' ? '1.413*FC' : c}`).join('|')}`;
}

/** Speech-band lift for sources without a centre channel (stereo / mono). */
export const SPEECH_EQ = 'equalizer=f=2000:t=o:w=2:g=4';
/** Night mode: gentle compression with make-up gain (quiet dialogue up, explosions down). */
export const NIGHT_MODE = 'acompressor=threshold=-24dB:ratio=4:attack=20:release=250:knee=4:makeup=2';
/** EBU R128 single-pass loudness normalisation (loudnorm works at 192 kHz internally: resample back). */
export const NORMALIZE = 'loudnorm=I=-16:LRA=11:TP=-1.5,aresample=48000';
/** Peak limiter (no auto-levelling) after anything that adds gain. */
export const LIMITER = 'alimiter=limit=0.891:attack=5:release=50:level=disabled';

export function delayFilter(ms: number): string | null {
  if (!ms) return null;
  if (ms > 0) return `adelay=delays=${ms}:all=1`;
  // Audio early: drop the first |ms| of sound and restart its clock at zero.
  return `atrim=start=${(-ms / 1000).toFixed(3)},asetpts=PTS-STARTPTS`;
}

export function audioFilters(i: { srcChannels: number; srcLayout: string | null; outChannels: number; comforts: AudioComforts; legacy?: boolean }): { filters: string[]; applied: (keyof AudioComforts)[] } {
  const filters: string[] = [];
  const applied: (keyof AudioComforts)[] = [];
  const c = i.comforts;
  let gain = false;
  if (i.outChannels === 2 && i.srcChannels > 2) {
    filters.push(downmixFilter(i.srcChannels, !!c.dialogueBoost));
    if (c.dialogueBoost) applied.push('dialogueBoost');
    gain = true;
  } else if (c.dialogueBoost && i.outChannels >= 6 && i.srcChannels >= 6) {
    filters.push(centreBoostFilter(i.outChannels));
    applied.push('dialogueBoost');
    gain = true;
  } else if (c.dialogueBoost) {
    filters.push(SPEECH_EQ);
    applied.push('dialogueBoost');
    gain = true;
  }
  if (c.nightMode) {
    filters.push(NIGHT_MODE);
    applied.push('nightMode');
    gain = true;
  }
  if (c.normalize) {
    filters.push(NORMALIZE);
    applied.push('normalize');
    gain = true;
  }
  if (gain) filters.push(LIMITER);
  const d = delayFilter(c.delayMs ?? 0);
  if (d) {
    filters.push(d);
    applied.push('delayMs');
  }
  return { filters, applied };
}

/* ------------------------------ ffmpeg args ------------------------------ */

/** Formats the MP4 muxer only writes with `-strict -2` (experimental sample entries). */
const MP4_EXPERIMENTAL = new Set(['truehd', 'mlp']);

/** Copied / encoded audio that HLS players only take in fMP4 segments (hls.js can't demux E-AC-3, FLAC, Opus … from MPEG-TS). */
export function audioNeedsFmp4(plan: AudioPlan | null | undefined, audioCopy: boolean, sourceCodec?: string | null): boolean {
  const codec = plan ? (plan.codec === 'copy' ? plan.sourceCodec : plan.codec) : audioCopy ? sourceCodec ?? null : 'aac';
  if (!codec) return false;
  return !['aac', 'mp3', 'mp2'].includes(codec);
}

/** FFmpeg output args for the planned audio. */
export function audioArgs(plan: AudioPlan): string[] {
  if (plan.codec === 'copy') {
    const args = ['-c:a', 'copy'];
    if (plan.bsf) args.push('-bsf:a', plan.bsf);
    if (MP4_EXPERIMENTAL.has(plan.sourceCodec)) args.push('-strict', '-2');
    return args;
  }
  const args: string[] = [];
  if (plan.filters.length) args.push('-af', plan.filters.join(','));
  args.push('-c:a', plan.codec, '-ac', String(plan.channels ?? 2), '-b:a', `${plan.bitrateKbps ?? 192}k`);
  if (plan.codec !== 'aac') args.push('-ar', '48000');
  return args;
}

/** One line for the admin dashboard / logs, e.g. "E-AC-3 5.1 (TrueHD Atmos → E-AC-3 5.1: device can't play TrueHD)". */
export const planDetail = (p: AudioPlan) => (p.reason ? `${p.output} (${p.reason})` : p.output);

export function decisionInfo(plan: AudioPlan | null, method: 'direct' | 'remux' | 'transcode' | 'live'): AudioDecisionInfo | null {
  if (!plan) return null;
  const direct = method === 'direct';
  return {
    source: plan.source,
    output: direct ? plan.source : plan.output,
    delivery: direct ? 'direct' : plan.delivery,
    codec: direct ? 'copy' : plan.codec,
    channels: direct ? null : plan.channels,
    bitrateKbps: plan.bitrateKbps,
    reason: direct ? null : plan.reason,
    objects: plan.objects,
    applied: direct ? [] : plan.applied,
  };
}

/**
 * EXT-X-MEDIA attributes for E-AC-3 output (adaptive master playlists): the channel count, or "16/JOC" when Dolby Atmos
 * (E-AC-3 JOC) is copied, which is how Apple's HLS spec marks Atmos. Null for other codecs.
 */
export function masterAudioFor(plan: AudioPlan | null | undefined, a: AudioStream | null | undefined): { channels: string; name: string; language: string | null } | null {
  if (!plan || !a) return null;
  const codec = plan.codec === 'copy' ? plan.sourceCodec : plan.codec;
  if (codec !== 'eac3') return null;
  const ch = plan.channels ?? a.channels ?? 6;
  const joc = plan.codec === 'copy' && !!a.atmos;
  return { channels: joc ? '16/JOC' : String(ch), name: a.title || plan.output, language: a.language ?? null };
}

/* ------------------------- refresh for old scans ------------------------- */

/** Re-probe the audio streams of a media row scanned before audio detection (keeps languages / defaults as stored). */
export async function refreshAudioStreams(mediaId: string): Promise<AudioStream[] | null> {
  const { db } = await import('../db.js');
  const { ffprobeJson, normLang } = await import('./probe.js');
  const m = db.get<{ path: string | null; audio: string | null }>('SELECT path, audio FROM media WHERE id = ?', mediaId);
  if (!m?.path || !fs.existsSync(m.path)) return null;
  const j = await ffprobeJson(m.path, ['-select_streams', 'a'], 30000);
  const old: AudioStream[] = (() => {
    try {
      return JSON.parse(m.audio ?? '[]');
    } catch {
      return [];
    }
  })();
  const streams: AudioStream[] = (j.streams ?? []).filter((s: any) => s.codec_type === 'audio').map((s: any) => {
    const a = parseAudioStream(s, normLang);
    const prev = old.find((o) => o.index === a.index);
    return prev ? { ...a, default: prev.default, language: prev.language ?? a.language } : a;
  });
  if (!streams.length) return null;
  if (!streams.some((a) => a.default)) streams[0].default = true;
  db.run('UPDATE media SET audio = ? WHERE id = ?', JSON.stringify(streams), mediaId);
  return streams;
}
