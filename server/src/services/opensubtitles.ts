import fs from 'node:fs';
import path from 'node:path';
import type { RemoteSubtitle, SubtitleStream } from '@mediamax/shared';
import { db } from '../db.js';
import { config } from '../config.js';
import { getSettings } from './settings.js';
import { badRequest, HttpError, notFound } from '../util/errors.js';
import { parseJson } from '../util/misc.js';
import { normLang } from './probe.js';
import { logger } from '../util/log.js';

const log = logger('opensubtitles');
const API = 'https://api.opensubtitles.com/api/v1';

export const subtitlesDir = (mediaId: string) => path.join(config.dataDir, 'subtitles', mediaId);

/** Downloaded subtitles for a media file (stored outside media folders so read-only libraries work). */
export function downloadedSubs(mediaId: string, startIndex: number): (SubtitleStream & { path: string })[] {
  const dir = subtitlesDir(mediaId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.(srt|vtt|ass)$/i.test(f)).sort().map((f, i) => {
    const [lang, flag] = f.split('.');
    return {
      index: startIndex + i, codec: f.endsWith('.vtt') ? 'webvtt' : f.endsWith('.ass') ? 'ass' : 'subrip', language: normLang(lang), title: 'OpenSubtitles' + (flag === 'hi' ? ' (SDH)' : flag === 'forced' ? ' (Forced)' : ''),
      default: false, forced: flag === 'forced', external: true, path: path.join(dir, f),
    };
  });
}

let token: { value: string; base: string; at: number } | null = null;

function headers(auth = false): Record<string, string> {
  const key = getSettings().openSubtitles.apiKey;
  if (!key) throw badRequest('OpenSubtitles is not configured. Add an API key in Admin → Settings.');
  const h: Record<string, string> = { 'Api-Key': key, 'User-Agent': `MediaMax v${config.version}`, 'Content-Type': 'application/json', Accept: 'application/json' };
  if (auth && token) h.Authorization = `Bearer ${token.value}`;
  return h;
}

async function login(): Promise<void> {
  const s = getSettings().openSubtitles;
  if (!s.username || !s.password) return;
  if (token && Date.now() - token.at < 12 * 3600000) return;
  const res = await fetch(`${API}/login`, { method: 'POST', headers: headers(), body: JSON.stringify({ username: s.username, password: s.password }), signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    log.warn(`OpenSubtitles login failed: HTTP ${res.status}`);
    return;
  }
  const j: any = await res.json();
  token = { value: j.token, base: j.base_url ? `https://${j.base_url}/api/v1` : API, at: Date.now() };
}

/** OpenSubtitles movie hash: file size + 64-bit sums of the first and last 64 KiB. */
export function movieHash(file: string): string | null {
  try {
    const size = fs.statSync(file).size;
    if (size < 131072) return null;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(65536);
    let hash = BigInt(size);
    for (const pos of [0, size - 65536]) {
      fs.readSync(fd, buf, 0, 65536, pos);
      for (let i = 0; i < 65536; i += 8) hash = (hash + buf.readBigUInt64LE(i)) & 0xffffffffffffffffn;
    }
    fs.closeSync(fd);
    return hash.toString(16).padStart(16, '0');
  } catch {
    return null;
  }
}

export async function searchSubtitles(itemId: string, languages: string[]): Promise<RemoteSubtitle[]> {
  const item = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) throw notFound('Item not found');
  const media = db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
  const params = new URLSearchParams();
  params.set('languages', (languages.length ? languages : ['en']).map((l) => l.toLowerCase().slice(0, 2)).sort().join(','));
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  if (item.type === 'episode') {
    const show = db.get('SELECT external_ids, title FROM items WHERE id = ?', item.grandparent_id);
    const sids = parseJson<Record<string, string>>(show?.external_ids, {});
    if (sids.tmdb) params.set('parent_tmdb_id', sids.tmdb);
    else if (sids.imdb) params.set('parent_imdb_id', sids.imdb.replace(/^tt/, ''));
    else params.set('query', show?.title ?? item.title);
    if (item.parent_idx != null) params.set('season_number', String(item.parent_idx));
    if (item.idx != null) params.set('episode_number', String(item.idx));
  } else if (ids.tmdb) params.set('tmdb_id', ids.tmdb);
  else if (ids.imdb) params.set('imdb_id', ids.imdb.replace(/^tt/, ''));
  else {
    params.set('query', item.title);
    if (item.year) params.set('year', String(item.year));
  }
  const hash = media?.path ? movieHash(media.path) : null;
  if (hash) params.set('moviehash', hash);
  const res = await fetch(`${API}/subtitles?${params}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new HttpError(502, `OpenSubtitles search failed (HTTP ${res.status})`, 'provider_error');
  const j: any = await res.json();
  const out: RemoteSubtitle[] = [];
  for (const d of j.data ?? []) {
    const a = d.attributes ?? {};
    const f = a.files?.[0];
    if (!f) continue;
    out.push({
      fileId: String(f.file_id), provider: 'opensubtitles', language: a.language ?? 'en', release: a.release ?? f.file_name ?? null, downloads: a.download_count ?? 0,
      hearingImpaired: !!a.hearing_impaired, forced: !!a.foreign_parts_only, aiTranslated: !!a.ai_translated || !!a.machine_translated, rating: a.ratings ?? null,
    });
  }
  // Hash matches first (moviehash_match), then by downloads.
  const matched = new Set((j.data ?? []).filter((d: any) => d.attributes?.moviehash_match).map((d: any) => String(d.attributes.files?.[0]?.file_id)));
  return out.sort((a, b) => Number(matched.has(b.fileId)) - Number(matched.has(a.fileId)) || b.downloads - a.downloads);
}

export async function downloadSubtitle(itemId: string, fileId: string, language: string, flags: { hearingImpaired?: boolean; forced?: boolean } = {}): Promise<void> {
  const media = db.get('SELECT * FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
  if (!media) throw notFound('No media for this item');
  await login();
  const res = await fetch(`${token?.base ?? API}/download`, { method: 'POST', headers: headers(true), body: JSON.stringify({ file_id: Number(fileId), sub_format: 'srt' }), signal: AbortSignal.timeout(20000) });
  if (res.status === 406 || res.status === 429) throw new HttpError(429, 'OpenSubtitles download quota reached. Add an OpenSubtitles account in settings for more downloads.', 'quota');
  if (!res.ok) throw new HttpError(502, `OpenSubtitles download failed (HTTP ${res.status})`, 'provider_error');
  const j: any = await res.json();
  const file = await fetch(j.link, { signal: AbortSignal.timeout(30000) });
  if (!file.ok) throw new HttpError(502, 'Could not fetch subtitle file', 'provider_error');
  const dir = subtitlesDir(media.id);
  fs.mkdirSync(dir, { recursive: true });
  const lang = /^[a-z]{2,3}$/i.test(language ?? '') ? language.toLowerCase() : 'und';
  if (!/^\d+$/.test(fileId)) throw badRequest('Invalid subtitle id');
  const flag = flags.forced ? 'forced' : flags.hearingImpaired ? 'hi' : 'std';
  fs.writeFileSync(path.join(dir, `${lang}.${flag}.${fileId}.srt`), Buffer.from(await file.arrayBuffer()));
  refreshMediaSubs(media.id);
}

/** Re-merge downloaded subtitles into the media row (embedded + sidecar entries are kept). */
export function refreshMediaSubs(mediaId: string) {
  const m = db.get('SELECT subs FROM media WHERE id = ?', mediaId);
  if (!m) return;
  const subs = parseJson<(SubtitleStream & { path?: string })[]>(m.subs, []).filter((s) => !s.path?.startsWith(subtitlesDir(mediaId)));
  db.run('UPDATE media SET subs = ? WHERE id = ?', JSON.stringify([...subs, ...downloadedSubs(mediaId, 2000)]), mediaId);
}

export function deleteDownloadedSubtitle(mediaId: string, index: number) {
  const s = downloadedSubs(mediaId, 2000).find((x) => x.index === index);
  if (!s) throw notFound('Subtitle not found');
  fs.rmSync(s.path, { force: true });
  refreshMediaSubs(mediaId);
}

/** Auto-download preferred languages for media that lack them. */
export async function autoDownload(progress: (p: number) => void, filter?: (mediaPath: string) => boolean): Promise<number> {
  const s = getSettings().openSubtitles;
  if (!s.apiKey || !s.autoLanguages.length) return 0;
  const rows = db.all(`SELECT i.id, m.id mid, m.subs, m.path FROM items i JOIN media m ON m.item_id = i.id
    WHERE i.type IN ('movie','episode') AND m.path IS NOT NULL ORDER BY i.added_at DESC LIMIT 300`).filter((r) => !filter || filter(r.path));
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const subs = parseJson<SubtitleStream[]>(rows[i].subs, []);
    for (const lang of s.autoLanguages) {
      const l3 = normLang(lang);
      if (subs.some((x) => x.language === l3 || x.language === lang)) continue;
      try {
        const results = await searchSubtitles(rows[i].id, [lang]);
        const best = results.find((r) => !r.aiTranslated && !r.forced);
        if (best) {
          await downloadSubtitle(rows[i].id, best.fileId, lang, { hearingImpaired: best.hearingImpaired });
          n++;
        }
      } catch (e) {
        if ((e as HttpError).statusCode === 429) return n;
        log.debug(`Auto subtitle failed: ${(e as Error).message}`);
      }
    }
    progress(Math.round(((i + 1) / rows.length) * 100));
  }
  return n;
}
