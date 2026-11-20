/**
 * Subtitle delivery for the clients' own renderers.
 *
 * Players never use the platform's text-track renderer or subtitle parser: they fetch each track in its original
 * format and draw it themselves (web: text overlay / libass (jassub) / PGS canvas decoder; native apps: overlay).
 * This module extracts single tracks from media files (`-map 0:N` only — never the whole file's subtitle set),
 * caches them, serves partial results while a long file is still being read, and lists/extracts embedded fonts
 * (Matroska attachments) for libass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SubtitleFont, SubtitleFormat, SubtitleStream, SubtitleTrack } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { badRequest, notFound } from '../util/errors.js';
import { parseJson, REMOTE_PROTOCOLS } from '../util/misc.js';
import { logger } from '../util/log.js';

const log = logger('subtitles');

/* ------------------------------ formats ------------------------------ */

/** Text codecs ffmpeg converts to SRT/WebVTT (the original is kept where it already is one of srt/vtt/ass). */
const TEXT_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'vtt', 'mov_text', 'text', 'microdvd', 'subviewer', 'sami', 'smi', 'ttml', 'sub']);

/** How the client renders a probed codec. */
export function formatForCodec(codec: string): SubtitleFormat | null {
  const c = codec.toLowerCase();
  if (c === 'ass' || c === 'ssa') return 'ass';
  if (c === 'webvtt' || c === 'vtt') return 'vtt';
  if (c === 'hdmv_pgs_subtitle' || c === 'pgssub' || c === 'sup') return 'pgs';
  if (c === 'dvd_subtitle' || c === 'dvdsub' || c === 'vobsub') return 'vobsub';
  if (c === 'dvb_subtitle' || c === 'dvbsub') return 'dvb';
  if (c === 'dvb_teletext') return 'teletext';
  if (TEXT_CODECS.has(c)) return 'srt';
  return null;
}

export const isImageFormat = (f: SubtitleFormat | null) => f === 'pgs' || f === 'vobsub' || f === 'dvb';

/** Raw file extension the client fetches for a format (null: can't be served raw, needs burn-in). */
export function rawExtFor(f: SubtitleFormat | null): RawExt | null {
  if (f === 'srt' || f === 'vtt' || f === 'ass') return f;
  // DVB teletext (recordings) is decoded to text by ffmpeg's libzvbi decoder.
  if (f === 'teletext') return 'srt';
  if (f === 'pgs') return 'sup';
  return null;
}

export type RawExt = 'srt' | 'vtt' | 'ass' | 'sup';
const MIME: Record<RawExt, string> = {
  srt: 'application/x-subrip; charset=utf-8', vtt: 'text/vtt; charset=utf-8', ass: 'text/x-ssa; charset=utf-8', sup: 'application/octet-stream',
};
export const rawMime = (ext: RawExt) => MIME[ext];

type StoredSub = SubtitleStream & { path?: string };

/**
 * Subtitle list for PlaybackInfo. Text tracks keep their WebVTT `url` (older clients, Cast, DLNA) and gain `rawUrl`.
 * Bitmap tracks are listed only for clients that render that format (`clientFormats`), otherwise they appear in
 * `burnIn` — the explicit last-resort path where the server draws them into the video.
 */
export function subtitleTrackList(tokenQuery: string, mediaId: string, subs: StoredSub[], clientFormats?: SubtitleFormat[] | null): { tracks: SubtitleTrack[]; burnIn: SubtitleTrack[] } {
  const tracks: SubtitleTrack[] = [];
  const burnIn: SubtitleTrack[] = [];
  const base = `/api/v1/stream/subtitles/${mediaId}`;
  for (const s of subs) {
    const format = formatForCodec(s.codec);
    if (!format) continue;
    const ext = rawExtFor(format);
    const image = isImageFormat(format);
    const t: SubtitleTrack = {
      index: s.index, language: s.language, title: s.title, default: s.default, forced: s.forced,
      url: image ? (ext ? `${base}/${s.index}.${ext}${tokenQuery}` : '') : `${base}/${s.index}.vtt${tokenQuery}`,
      codec: s.codec, format, isImage: image, external: !!s.external,
      ...(ext ? { rawUrl: `${base}/${s.index}.${ext}${tokenQuery}` } : {}),
      ...(format === 'ass' ? { fontsUrl: `${base}/fonts${tokenQuery}` } : {}),
    };
    if (!image) tracks.push(t);
    else if (clientFormats?.includes(format) && ext) tracks.push(t);
    else burnIn.push(t);
  }
  return { tracks, burnIn };
}

/* ----------------------------- extraction ----------------------------- */

export interface Extraction {
  /** Final file (exists once complete). */
  file: string;
  part: string;
  ext: RawExt;
  complete: boolean;
  failed: string | null;
  /** 0..1 (by media time read), null when unknown. */
  progress: number | null;
  done: Promise<string>;
}

const extractions = new Map<string, Extraction>();
const cacheDir = () => path.join(config.cacheDir, 'subs');

interface MediaRowLite { id: string; path: string | null; remote_url: string | null; subs: string | null; mtime: number | null; duration_ms: number | null }

function mediaRow(mediaId: string): MediaRowLite {
  const m = db.get<MediaRowLite>('SELECT id, path, remote_url, subs, mtime, duration_ms FROM media WHERE id = ?', mediaId);
  if (!m) throw notFound('Media not found');
  return m;
}

function findSub(m: MediaRowLite, index: number): StoredSub {
  const s = parseJson<StoredSub[]>(m.subs, []).find((x) => x.index === index);
  if (!s) throw notFound('Subtitle not found');
  return s;
}

/** Output codec / muxer for a raw extension. */
function codecArgs(ext: RawExt, srcFormat: SubtitleFormat | null, srcCodec: string): string[] {
  switch (ext) {
    case 'sup': return ['-c:s', 'copy', '-f', 'sup'];
    case 'ass': return srcCodec === 'ass' ? ['-c:s', 'copy', '-f', 'ass'] : ['-c:s', 'ass', '-f', 'ass'];
    case 'srt': return srcCodec === 'subrip' || srcCodec === 'srt' ? ['-c:s', 'copy', '-f', 'srt'] : ['-c:s', 'srt', '-f', 'srt'];
    case 'vtt': return srcFormat === 'vtt' ? ['-c:s', 'copy', '-f', 'webvtt'] : ['-c:s', 'webvtt', '-f', 'webvtt'];
  }
}

/** Which raw extensions a source can be served as. Text sources: their own format plus vtt/srt; ASS also as ASS. */
export function allowedExts(format: SubtitleFormat | null): RawExt[] {
  if (format === 'pgs') return ['sup'];
  if (format === 'ass') return ['ass', 'vtt', 'srt'];
  if (format === 'vtt') return ['vtt', 'srt'];
  if (format === 'srt') return ['srt', 'vtt'];
  return [];
}

/** ffmpeg arguments that extract one subtitle stream (exported for tests). */
export function extractArgs(input: string, streamIndex: number | null, ext: RawExt, srcCodec: string, out: string): string[] {
  const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats'];
  if (!path.isAbsolute(input)) args.push(...REMOTE_PROTOCOLS);
  // Only the subtitle stream is wanted: let the demuxer drop audio/video packets early.
  if (streamIndex != null) args.push('-discard:v', 'all', '-discard:a', 'all');
  if (srcCodec === 'dvb_teletext') args.push('-txt_format', 'text');
  args.push('-i', input);
  if (streamIndex != null) args.push('-map', `0:${streamIndex}`);
  else args.push('-map', '0:s:0');
  args.push(...codecArgs(ext, formatForCodec(srcCodec), srcCodec.toLowerCase()), out);
  return args;
}

/**
 * Extract (or reuse) one subtitle track as `ext`. Returns immediately; `done` resolves with the final file.
 * Concurrent requests for the same track share one ffmpeg run, and finished files are cached by media mtime.
 */
export function extractSubtitle(mediaId: string, index: number, ext: RawExt): Extraction {
  const m = mediaRow(mediaId);
  const s = findSub(m, index);
  const format = formatForCodec(s.codec);
  if (!allowedExts(format).includes(ext)) {
    throw badRequest(isImageFormat(format) ? `${s.codec} subtitles can't be served as .${ext}${format === 'pgs' ? ' (use .sup)' : ' — they must be burned in'}` : `Unsupported subtitle conversion to .${ext}`);
  }
  const dir = cacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${mediaId}_${index}_${m.mtime ?? 0}.${ext}`);
  const existing = extractions.get(file);
  if (existing && !existing.failed) return existing;
  // A sidecar already in the wanted format is served as is.
  if (s.external && s.path && path.extname(s.path).slice(1).toLowerCase() === (ext === 'sup' ? 'sup' : ext) && fs.existsSync(s.path)) {
    return { file: s.path, part: s.path, ext, complete: true, failed: null, progress: 1, done: Promise.resolve(s.path) };
  }
  if (fs.existsSync(file)) {
    const ready: Extraction = { file, part: file, ext, complete: true, failed: null, progress: 1, done: Promise.resolve(file) };
    return ready;
  }
  const input = s.external ? s.path! : m.path ?? m.remote_url;
  if (!input) throw notFound('Media file not available');
  const part = `${file}.part`;
  const durUs = (m.duration_ms ?? 0) * 1000;
  const ex: Extraction = { file, part, ext, complete: false, failed: null, progress: s.external ? null : 0, done: null as unknown as Promise<string> };
  ex.done = new Promise<string>((resolve, reject) => {
    const args = extractArgs(input, s.external ? null : s.index, ext, s.codec, part);
    const started = Date.now();
    const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    let buf = '';
    proc.stdout.on('data', (d) => {
      buf += d.toString();
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const mm = line.match(/^out_time_us=(\d+)/);
        if (mm && durUs > 0) ex.progress = Math.min(0.999, Number(mm[1]) / durUs);
      }
    });
    proc.stderr.on('data', (d) => (err = (err + d).slice(-2000)));
    proc.on('error', (e) => {
      ex.failed = e.message;
      reject(e);
    });
    proc.on('exit', (code) => {
      if (code === 0 && fs.existsSync(part)) {
        fs.renameSync(part, file);
        ex.part = file;
        ex.complete = true;
        ex.progress = 1;
        log.debug(`Extracted subtitle ${mediaId}#${index} as .${ext} in ${Date.now() - started} ms`);
        resolve(file);
      } else {
        ex.failed = err.trim() || `ffmpeg exited with ${code}`;
        fs.rmSync(part, { force: true });
        reject(new Error(ex.failed));
      }
    });
  }).finally(() => {
    // Keep finished entries out of the map (the cached file is found on disk); failed ones can be retried.
    setTimeout(() => extractions.get(file) === ex && extractions.delete(file), 1000).unref?.();
  });
  ex.done.catch(() => {});
  extractions.set(file, ex);
  return ex;
}

/**
 * What can be served right now from a running extraction: text cut at the last complete cue (SRT/WebVTT blank
 * line, ASS line), or the raw .sup bytes (the client's PGS parser stops at the last complete segment).
 */
export function partialContent(ex: Extraction): Buffer {
  let data: Buffer;
  try {
    data = fs.readFileSync(ex.complete ? ex.file : ex.part);
  } catch {
    return Buffer.alloc(0);
  }
  if (ex.complete || ex.ext === 'sup') return data;
  const text = data.toString('utf8');
  const cut = ex.ext === 'ass' ? text.lastIndexOf('\n') : Math.max(text.lastIndexOf('\n\n'), text.lastIndexOf('\r\n\r\n'));
  return Buffer.from(cut > 0 ? text.slice(0, cut + 1) : ex.ext === 'vtt' ? 'WEBVTT\n\n' : '', 'utf8');
}

/** Wait up to `ms` for an extraction to finish (resolves either way). */
export async function settle(ex: Extraction, ms: number): Promise<void> {
  if (ex.complete || ex.failed) return;
  await Promise.race([ex.done.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);
}

/* -------------------------------- fonts -------------------------------- */

const FONT_EXT = /\.(ttf|otf|ttc|otc|woff2?|pfb)$/i;
const FONT_MIME = /font|truetype|opentype|sfnt/i;
const fontLists = new Map<string, Promise<AttachmentInfo[]>>();

interface AttachmentInfo { index: number; name: string; mimeType: string | null }

/** Matroska attachments that are fonts (ffprobe), cached per file version. */
export function fontAttachments(mediaId: string): Promise<AttachmentInfo[]> {
  const m = mediaRow(mediaId);
  const key = `${mediaId}_${m.mtime ?? 0}`;
  let p = fontLists.get(key);
  if (!p) {
    const input = m.path;
    p = !input || !/\.(mkv|mka|mks|webm)$/i.test(input) || !fs.existsSync(input)
      ? Promise.resolve([])
      : new Promise<AttachmentInfo[]>((resolve) => {
        const proc = spawn(config.ffprobe, ['-v', 'error', '-select_streams', 't', '-show_entries', 'stream=index:stream_tags=filename,mimetype', '-of', 'json', input]);
        let out = '';
        proc.stdout.on('data', (d) => (out += d));
        proc.on('error', () => resolve([]));
        proc.on('exit', () => {
          try {
            const streams = (JSON.parse(out).streams ?? []) as { index: number; tags?: { filename?: string; mimetype?: string } }[];
            resolve(streams
              .map((s) => ({ index: s.index, name: path.basename(String(s.tags?.filename ?? '')), mimeType: s.tags?.mimetype ?? null }))
              .filter((a) => a.name && a.name !== '.' && a.name !== '..' && (FONT_EXT.test(a.name) || FONT_MIME.test(a.mimeType ?? ''))));
          } catch {
            resolve([]);
          }
        });
      });
    fontLists.set(key, p);
  }
  return p;
}

export async function listFonts(mediaId: string, tokenQuery: string): Promise<SubtitleFont[]> {
  const list = await fontAttachments(mediaId);
  return list.map((a) => ({ name: a.name, url: `/api/v1/stream/subtitles/${mediaId}/fonts/${encodeURIComponent(a.name)}${tokenQuery}`, mimeType: a.mimeType }));
}

const fontDumps = new Map<string, Promise<string>>();

/** Path of one extracted font (all font attachments are dumped in one ffmpeg run, then cached). */
export async function fontFile(mediaId: string, name: string): Promise<{ file: string; mime: string }> {
  const list = await fontAttachments(mediaId);
  const a = list.find((x) => x.name === name);
  if (!a) throw notFound('Font not found');
  const m = mediaRow(mediaId);
  const dir = path.join(config.cacheDir, 'subfonts', `${mediaId}_${m.mtime ?? 0}`);
  let p = fontDumps.get(dir);
  if (!p) {
    p = new Promise<string>((resolve, reject) => {
      if (fs.existsSync(path.join(dir, '.done'))) return resolve(dir);
      fs.mkdirSync(dir, { recursive: true });
      const args = ['-hide_banner', '-v', 'error', '-nostdin', '-y'];
      for (const f of list) args.push(`-dump_attachment:${f.index}`, path.join(dir, f.name));
      // ffmpeg dumps attachments while opening the input, then complains there is no output: that exit code is expected.
      args.push('-i', m.path!, '-t', '0', '-f', 'null', '-');
      const proc = spawn(config.ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      proc.on('error', reject);
      proc.on('exit', () => {
        if (list.every((f) => fs.existsSync(path.join(dir, f.name)))) {
          fs.writeFileSync(path.join(dir, '.done'), '');
          resolve(dir);
        } else reject(new Error('Could not extract fonts'));
      });
    });
    fontDumps.set(dir, p);
    p.catch(() => fontDumps.delete(dir));
  }
  const d = await p;
  const ext = path.extname(name).slice(1).toLowerCase();
  const mime = ext === 'otf' ? 'font/otf' : ext === 'woff' ? 'font/woff' : ext === 'woff2' ? 'font/woff2' : ext === 'ttc' || ext === 'otc' ? 'font/collection' : 'font/ttf';
  return { file: path.join(d, name), mime };
}
