/**
 * Speech through the TTS provider chain (Admin → AI): Piper (local program or its HTTP server), Kokoro-FastAPI and
 * any OpenAI-compatible /audio/speech API, ElevenLabs. Clips are cached as hashed MP3 files (served by
 * /dj/voice/:file). Failures fall through silently to the next voice; after the last one callers get null and the
 * apps speak the text with the device's own voice.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { AiTtsProvider } from '@mediamax/shared';
import { config } from '../../config.js';
import { getSettings } from '../settings.js';
import { checkResponse, ProviderError, runChain } from './chain.js';
import { openaiUrl } from './llm.js';

export const voiceDir = () => {
  const d = path.join(config.cacheDir, 'dj-voice');
  fs.mkdirSync(d, { recursive: true });
  return d;
};

/** Usable voices in chain order. */
export function ttsProviders(): AiTtsProvider[] {
  return (getSettings().ai?.ttsProviders ?? []).filter((p) => p.enabled && (p.kind === 'piper' ? !!(p.url || p.voiceModel) : p.kind === 'elevenlabs' ? !!p.voice : !!p.url));
}

/** True when the server renders speech itself (at least one voice in the chain). */
export const serverVoiceConfigured = (): boolean => ttsProviders().length > 0;

const keyOf = (text: string, p: AiTtsProvider) =>
  crypto.createHash('sha256').update(JSON.stringify([text, p.kind, p.url, p.model, p.voice, p.voiceModel, p.speaker])).digest('hex').slice(0, 32);

export function run(bin: string, args: string[], stdin: string | Buffer | null, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args, { stdio: [stdin == null ? 'ignore' : 'pipe', 'pipe', 'pipe'] });
    let err = '';
    let out = '';
    p.stdout?.on('data', (d) => (out = (out + d).slice(-2000)));
    p.stderr?.on('data', (d) => (err = (err + d).slice(-400)));
    const t = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
    p.on('close', (code) => {
      clearTimeout(t);
      code === 0 ? resolve(out) : reject(new Error(err.trim() || `${path.basename(bin)} exited with ${code}`));
    });
    if (stdin != null) p.stdin?.end(stdin);
  });
}

/** Length of a clip in ms (ffprobe), null when unknown. */
async function clipMs(file: string): Promise<number | null> {
  try {
    const out = await run(config.ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file], null, 5000);
    const s = Number(out.trim());
    return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : null;
  } catch {
    return null;
  }
}

const toMp3 = (input: string, out: string) =>
  run(config.ffmpeg, ['-v', 'error', '-y', '-i', input, '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '96k', out], null, 30000);

function audioOk(buf: Buffer) {
  if (buf.length < 200 || buf.length > 20 * 1024 * 1024) throw new ProviderError('no usable audio returned');
  return buf;
}

/** Render one clip with one provider into `out` (MP3). Throws on failure. */
async function renderOnce(p: AiTtsProvider, text: string, out: string): Promise<void> {
  const input = text.slice(0, 1000);
  const signal = AbortSignal.timeout(60000);
  if (p.kind === 'piper') {
    const wav = `${out}.wav`;
    try {
      if (p.url) {
        // Piper's HTTP server: POST the text, get WAV back.
        const res = await checkResponse(await fetch(p.url, { method: 'POST', headers: { 'content-type': 'text/plain; charset=utf-8' }, body: input, signal }));
        fs.writeFileSync(wav, audioOk(Buffer.from(await res.arrayBuffer())));
      } else {
        const args = ['--model', p.voiceModel!, '--output_file', wav];
        if (p.speaker != null) args.push('--speaker', String(p.speaker));
        await run(p.piperPath || 'piper', args, input, 60000);
      }
      await toMp3(wav, out);
    } finally {
      fs.rmSync(wav, { force: true });
    }
    return;
  }
  let res: Response;
  if (p.kind === 'elevenlabs') {
    const b = (p.url || 'https://api.elevenlabs.io').replace(/\/+$/, '').replace(/\/v1$/, '');
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'audio/mpeg' };
    if (p.apiKey) headers['xi-api-key'] = p.apiKey;
    res = await fetch(`${b}/v1/text-to-speech/${encodeURIComponent(p.voice!)}?output_format=mp3_44100_128`, {
      method: 'POST', headers, signal, body: JSON.stringify({ text: input, model_id: p.model || 'eleven_flash_v2_5' }),
    });
  } else {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (p.apiKey) headers.authorization = `Bearer ${p.apiKey}`;
    res = await fetch(openaiUrl(p.url, 'audio/speech'), {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: p.model || (p.kind === 'kokoro' ? 'kokoro' : 'tts-1'), voice: p.voice || (p.kind === 'kokoro' ? 'af_heart' : 'alloy'), input, response_format: 'mp3' }),
    });
  }
  await checkResponse(res);
  const ct = res.headers.get('content-type') ?? '';
  if (/json|text\/html/.test(ct)) throw new ProviderError(`unexpected ${ct.split(';')[0]} instead of audio`);
  fs.writeFileSync(out, audioOk(Buffer.from(await res.arrayBuffer())));
}

export interface Voice {
  file: string;
  durationMs: number | null;
  providerId: string;
}

/**
 * Render `text` with the first voice in the chain that works (cached clips are reused without a call). Null when
 * no server voice is set up or every voice failed: the apps then speak it themselves. Never throws.
 */
export async function speakChain(text: string, opts: { feature?: string; providers?: AiTtsProvider[]; force?: boolean } = {}): Promise<Voice | null> {
  const chain = opts.providers ?? ttsProviders();
  if (!chain.length || !text.trim()) return null;
  const dir = voiceDir();
  // A clip already rendered by any voice in the chain (in order) costs nothing.
  if (!opts.force) {
    for (const p of chain) {
      const file = `${keyOf(text, p)}.mp3`;
      if (fs.existsSync(path.join(dir, file))) return { file, durationMs: await clipMs(path.join(dir, file)), providerId: p.id };
    }
  }
  const r = await runChain('tts', chain, async (p) => {
    const file = `${keyOf(text, p)}.mp3`;
    const out = path.join(dir, file);
    const tmp = `${out}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.part.mp3`;
    try {
      await renderOnce(p, text, tmp);
      fs.renameSync(tmp, out);
    } finally {
      fs.rmSync(tmp, { force: true }); // never cache a half-written clip
    }
    return { file, durationMs: await clipMs(out), providerId: p.id };
  }, { feature: opts.feature ?? 'tts', force: opts.force });
  return r?.value ?? null;
}

/** Path of a cached voice clip, or null (only our own hashed file names are served). */
export function voiceFile(name: string): string | null {
  if (!/^[a-f0-9]{32}\.mp3$/.test(name)) return null;
  const f = path.join(voiceDir(), name);
  return fs.existsSync(f) ? f : null;
}

/** Drop voice clips older than a week. */
export function pruneVoices() {
  const cutoff = Date.now() - 7 * 86400000;
  for (const f of fs.readdirSync(voiceDir())) {
    try {
      if (fs.statSync(path.join(voiceDir(), f)).mtimeMs < cutoff) fs.rmSync(path.join(voiceDir(), f), { force: true });
    } catch {
      /* ignore */
    }
  }
}
