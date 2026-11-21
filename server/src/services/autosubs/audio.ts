/**
 * Audio for speech-to-text: choose the dialogue track, extract it with ffmpeg to 16 kHz mono PCM WAV (what whisper
 * wants), find silences (ffmpeg silencedetect) and cut chunks. ffmpeg runs at low priority.
 */
import fs from 'node:fs';
import type { AudioStream } from '@mediamax/shared';
import { config } from '../../config.js';
import { normLang } from '../probe.js';
import { lang2 } from '../subtitleProviders/lang.js';
import { runLowPriority } from './engine.js';
import { parseSilences, type Silence } from './srt.js';

const COMMENTARY = /commentary|comment|director|descri|narrat|\bAD\b|karaoke|instrumental|isolated|music only|m&e/i;

/**
 * The track people watch with: not commentary / audio description; the default track, else the first. When `prefer`
 * (the film's original language, if known) matches a track, that one wins over a dub that happens to be default.
 * Returns the audio-relative position (for `-map 0:a:N`) and the track's language (ISO 639-1) if tagged.
 */
export function pickAudioStream(streams: AudioStream[], prefer?: string | null): { ordinal: number; language: string | null } | null {
  if (!streams.length) return null;
  const list = streams.map((s, ordinal) => ({ s, ordinal }));
  const usable = list.filter(({ s }) => !COMMENTARY.test(s.title ?? '')) .length ? list.filter(({ s }) => !COMMENTARY.test(s.title ?? '')) : list;
  const tagged = (l: string | null) => (l && l !== 'und' ? lang2(l) : null);
  const pick = (prefer && usable.find(({ s }) => tagged(s.language) === lang2(prefer))) || usable.find(({ s }) => s.default) || usable[0];
  return { ordinal: pick.ordinal, language: tagged(pick.s.language) };
}

export const audioLanguageCode = (l: string | null | undefined) => (l ? normLang(l) : null);

/** 16 kHz mono 16-bit WAV of one audio track. */
export async function extractAudio(input: string, ordinal: number, out: string, signal?: AbortSignal): Promise<void> {
  const tmp = `${out}.tmp.wav`;
  const r = await runLowPriority(config.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', `0:a:${ordinal}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp], { timeoutMs: 2 * 3600_000, signal });
  if (!r.ok) {
    fs.rmSync(tmp, { force: true });
    throw new Error(r.aborted ? 'stopped' : `ffmpeg could not extract the audio: ${r.stderr.trim().slice(-300)}`);
  }
  fs.renameSync(tmp, out);
}

/** Duration of a 16 kHz mono s16 WAV from its size (header 44 bytes). */
export const wavDurationMs = (file: string) => Math.max(0, Math.round(((fs.statSync(file).size - 44) / 32000) * 1000));

/** Silences of at least `minSec` below `noiseDb`. */
export async function detectSilences(wav: string, durationMs: number, signal?: AbortSignal, noiseDb = -35, minSec = 0.6): Promise<Silence[]> {
  let stderr = '';
  const r = await runLowPriority(config.ffmpeg, ['-nostdin', '-hide_banner', '-i', wav, '-af', `silencedetect=noise=${noiseDb}dB:d=${minSec}`, '-f', 'null', '-'], {
    timeoutMs: 3600_000, signal, onStderr: (s) => {
      stderr += s.split('\n').filter((l) => l.includes('silence_')).join('\n') + '\n';
    },
  });
  if (!r.ok && r.aborted) throw new Error('stopped');
  return parseSilences(stderr, durationMs);
}

/** Cut [startMs, endMs) out of the full WAV. */
export async function cutChunk(wav: string, startMs: number, endMs: number, out: string, signal?: AbortSignal): Promise<void> {
  const r = await runLowPriority(config.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-ss', (startMs / 1000).toFixed(3), '-t', ((endMs - startMs) / 1000).toFixed(3), '-i', wav, '-c:a', 'pcm_s16le', '-ar', '16000', '-ac', '1', out], { timeoutMs: 600_000, signal });
  if (!r.ok) throw new Error(r.aborted ? 'stopped' : `ffmpeg could not cut a chunk: ${r.stderr.trim().slice(-200)}`);
}
