/**
 * Where downloaded subtitles live and how they join the media row's subtitle list.
 *
 *  - "data" (default, the original behaviour): <data>/subtitles/<mediaId>/<lang>.<std|hi|forced>.<id>.<ext>, so
 *    read-only libraries work. Listed with index 2000+.
 *  - "sidecar": next to the video as "<Video name>.<lang>[.forced|.sdh].<ext>" (falls back to the data folder when
 *    the library is read-only). Sidecars MediaMax wrote are recorded in `subtitle_downloads` and listed with index
 *    3000+ so the UI can delete them; other sidecars keep 1000+.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SubtitleStream } from '@mediamax/shared';
import { db } from '../../db.js';
import { config } from '../../config.js';
import { notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { normLang } from '../probe.js';
import { ext, parseSubtitleName, stripExt, SUB_EXT } from '../parser.js';
import { logger } from '../../util/log.js';

const log = logger('subtitles');

export const subtitlesDir = (mediaId: string) => path.join(config.dataDir, 'subtitles', mediaId);

type StoredSub = SubtitleStream & { path: string };

const labels = new Map<string, string>([['opensubtitles', 'OpenSubtitles'], ['subsro', 'Subs.ro']]);
/** Display names for provider ids (plugins register theirs). */
export const setProviderLabel = (id: string, name: string) => labels.set(id, name);
export const providerLabel = (id: string) => labels.get(id) ?? id;

function recorded(mediaId: string): Map<string, { provider: string }> {
  try {
    return new Map(db.all<{ path: string; provider: string }>('SELECT path, provider FROM subtitle_downloads WHERE media_id = ?', mediaId).map((r) => [r.path, r]));
  } catch {
    return new Map();
  }
}

const flagTitle = (flag: string | undefined) => (flag === 'hi' ? ' (SDH)' : flag === 'forced' ? ' (Forced)' : '');
const codecFor = (f: string) => (f.endsWith('.vtt') ? 'webvtt' : f.endsWith('.ass') ? 'ass' : 'subrip');

/** Downloaded subtitles in the data folder (stored outside media folders so read-only libraries work). */
export function downloadedSubs(mediaId: string, startIndex: number): StoredSub[] {
  const dir = subtitlesDir(mediaId);
  if (!fs.existsSync(dir)) return [];
  const rec = recorded(mediaId);
  // Auto-generated (AI) subtitles sort after every downloaded one, so players that pick "the first subtitle in my
  // language" prefer a real download.
  const isAi = (f: string) => rec.get(path.join(dir, f))?.provider === 'ai-whisper';
  return fs.readdirSync(dir).filter((f) => /\.(srt|vtt|ass)$/i.test(f)).sort((a, b) => Number(isAi(a)) - Number(isAi(b)) || (a < b ? -1 : a > b ? 1 : 0)).map((f, i) => {
    const [lang, flag] = f.split('.');
    const p = path.join(dir, f);
    // Files from before providers existed have no record: they all came from OpenSubtitles.
    const provider = rec.get(p)?.provider ?? 'opensubtitles';
    return {
      index: startIndex + i, codec: codecFor(f), language: normLang(lang), title: providerLabel(provider) + flagTitle(flag),
      default: false, forced: flag === 'forced', external: true, path: p,
    };
  });
}

function safeIsDir(p: string) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Sidecar subtitles next to a video (and in Subs/Subtitles folders). Ones MediaMax downloaded get 3000+. */
export function sidecarSubs(videoPath: string, mediaId?: string): SubtitleStream[] {
  const dir = path.dirname(videoPath);
  const base = stripExt(path.basename(videoPath));
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const subsDirs = ['subs', 'subtitles', 'Subs', 'Subtitles'].map((d) => path.join(dir, d)).filter(safeIsDir);
  const candidates = [...files.map((f) => path.join(dir, f)), ...subsDirs.flatMap((d) => fs.readdirSync(d).map((f) => path.join(d, f)))];
  const rec = mediaId ? recorded(mediaId) : new Map<string, { provider: string }>();
  const out: StoredSub[] = [];
  let n = 0;
  let own = 0;
  for (const p of candidates) {
    const e = ext(p);
    if (!SUB_EXT.has(e)) continue;
    const fname = path.basename(p);
    const inSubDir = path.dirname(p) !== dir;
    const info = parseSubtitleName(fname, inSubDir ? stripExt(fname).split('.')[0] : base) ?? (inSubDir ? parseSubtitleName(fname, '') : null);
    if (!info) continue;
    const r = rec.get(p);
    if (r) {
      out.push({ index: 3000 + own++, codec: e === 'srt' ? 'subrip' : e, language: normLang(info.language), title: providerLabel(r.provider) + (info.forced ? ' (Forced)' : /SDH/.test(info.title ?? '') ? ' (SDH)' : ''), default: info.default, forced: info.forced, external: true, path: p });
      continue;
    }
    out.push({ index: 1000 + n++, codec: e === 'srt' ? 'subrip' : e, language: normLang(info.language), title: info.title, default: info.default, forced: info.forced, external: true, path: p });
  }
  return out;
}

/** Sidecar + downloaded subtitle entries for a media file (what the scanner and a download both store). */
export function externalSubs(mediaId: string, videoPath: string | null): SubtitleStream[] {
  return [...(videoPath ? sidecarSubs(videoPath, mediaId) : []), ...downloadedSubs(mediaId, 2000)];
}

/** Re-merge sidecar and downloaded subtitles into the media row (embedded entries are kept). */
export function refreshMediaSubs(mediaId: string) {
  const m = db.get<{ subs: string; path: string | null }>('SELECT subs, path FROM media WHERE id = ?', mediaId);
  if (!m) return;
  const stored = parseJson<(SubtitleStream & { path?: string })[]>(m.subs, []);
  const embedded = m.path ? stored.filter((s) => !s.external) : stored.filter((s) => !s.path?.startsWith(subtitlesDir(mediaId)));
  db.run('UPDATE media SET subs = ? WHERE id = ?', JSON.stringify([...embedded, ...externalSubs(mediaId, m.path)]), mediaId);
}

export function deleteDownloadedSubtitle(mediaId: string, index: number) {
  const m = db.get<{ path: string | null }>('SELECT path FROM media WHERE id = ?', mediaId);
  const s = externalSubs(mediaId, m?.path ?? null).find((x) => x.index === index && x.index >= 2000) as StoredSub | undefined;
  if (!s) throw notFound('Subtitle not found');
  fs.rmSync(s.path, { force: true });
  db.run('DELETE FROM subtitle_downloads WHERE path = ?', s.path);
  refreshMediaSubs(mediaId);
}

const safePart = (s: string) => s.replace(/[^\w-]+/g, '_').slice(0, 80) || 'x';

export interface SaveRequest {
  mediaId: string;
  videoPath: string | null;
  data: Buffer;
  ext: 'srt' | 'ass' | 'vtt';
  /** ISO 639-1 or 639-2. */
  language: string;
  flag: 'std' | 'hi' | 'forced';
  provider: string;
  fileId: string;
  release: string | null;
  score: number | null;
  synced: boolean;
  mode: 'data' | 'sidecar';
}

/** Write a processed subtitle and record it. Returns the file path. */
export function saveSubtitle(r: SaveRequest): string {
  const lang = /^[a-z]{2,3}$/i.test(r.language ?? '') ? r.language.toLowerCase() : 'und';
  let file: string | null = null;
  if (r.mode === 'sidecar' && r.videoPath) {
    const dir = path.dirname(r.videoPath);
    const base = stripExt(path.basename(r.videoPath));
    const tag = r.flag === 'forced' ? '.forced' : r.flag === 'hi' ? '.sdh' : '';
    let target = path.join(dir, `${base}.${lang}${tag}.${r.ext}`);
    const mine = (p: string) => !!db.get('SELECT 1 FROM subtitle_downloads WHERE path = ?', p);
    // Never overwrite a sidecar the admin put there: add the provider as an extra tag instead.
    if (fs.existsSync(target) && !mine(target)) target = path.join(dir, `${base}.${lang}${tag}.${safePart(r.provider)}.${r.ext}`);
    try {
      fs.writeFileSync(target, r.data);
      file = target;
    } catch (e) {
      log.warn(`Could not write a sidecar next to the video (${(e as NodeJS.ErrnoException).code ?? (e as Error).message}); using the data folder`);
    }
  }
  if (!file) {
    const dir = subtitlesDir(r.mediaId);
    fs.mkdirSync(dir, { recursive: true });
    // OpenSubtitles keeps its original naming (numeric file id); other providers are prefixed.
    const idPart = r.provider === 'opensubtitles' && /^\d+$/.test(r.fileId) ? r.fileId : `${safePart(r.provider)}_${safePart(r.fileId)}`;
    file = path.join(dir, `${lang}.${r.flag}.${idPart}.${r.ext}`);
    fs.writeFileSync(file, r.data);
  }
  db.upsert('subtitle_downloads', {
    path: file, media_id: r.mediaId, provider: r.provider, provider_file_id: r.fileId, language: lang, release: r.release,
    score: r.score, synced: r.synced ? 1 : 0, created_at: new Date().toISOString(),
  }, 'path');
  return file;
}
