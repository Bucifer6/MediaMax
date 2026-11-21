/**
 * OpenSubtitles.com REST API behind the provider interface. Request parameters, the login/quota handling and the
 * error messages are the same as before providers existed.
 */
import fs from 'node:fs';
import { config } from '../../config.js';
import { getSettings } from '../settings.js';
import { badRequest, HttpError } from '../../util/errors.js';
import { logger } from '../../util/log.js';
import type { ProviderSubtitle, SubtitleProvider, SubtitleQuery } from './types.js';
import { lang2 } from './lang.js';

const log = logger('opensubtitles');
const API = 'https://api.opensubtitles.com/api/v1';

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

/** Search parameters, exactly as the pre-provider implementation built them. */
export function openSubtitlesParams(q: SubtitleQuery): URLSearchParams {
  const params = new URLSearchParams();
  params.set('languages', [...new Set(q.languages.map(lang2))].sort().join(','));
  if (q.item.type === 'episode') {
    if (q.showTmdbId) params.set('parent_tmdb_id', q.showTmdbId);
    else if (q.showImdbId) params.set('parent_imdb_id', q.showImdbId.replace(/^tt/, ''));
    else params.set('query', q.showTitle ?? q.item.title);
    if (q.season != null) params.set('season_number', String(q.season));
    if (q.episode != null) params.set('episode_number', String(q.episode));
  } else if (q.tmdbId) params.set('tmdb_id', q.tmdbId);
  else if (q.imdbId) params.set('imdb_id', q.imdbId.replace(/^tt/, ''));
  else {
    params.set('query', q.item.title);
    if (q.item.year) params.set('year', String(q.item.year));
  }
  if (q.movieHash) params.set('moviehash', q.movieHash);
  return params;
}

export const openSubtitlesProvider: SubtitleProvider = {
  id: 'opensubtitles',
  name: 'OpenSubtitles',
  configured: () => !!getSettings().openSubtitles.apiKey,
  async search(q) {
    const res = await fetch(`${API}/subtitles?${openSubtitlesParams(q)}`, { headers: headers(), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new HttpError(502, `OpenSubtitles search failed (HTTP ${res.status})`, 'provider_error');
    const j: any = await res.json();
    const out: ProviderSubtitle[] = [];
    for (const d of j.data ?? []) {
      const a = d.attributes ?? {};
      const f = a.files?.[0];
      if (!f) continue;
      out.push({
        id: String(f.file_id), language: a.language ?? 'en', release: a.release ?? f.file_name ?? null, fileName: f.file_name ?? null, downloads: a.download_count ?? 0,
        hearingImpaired: !!a.hearing_impaired, forced: !!a.foreign_parts_only, aiTranslated: !!a.ai_translated || !!a.machine_translated, rating: a.ratings ?? null,
        hashMatch: !!a.moviehash_match,
      });
    }
    return out;
  },
  async download(result) {
    if (!/^\d+$/.test(result.id)) throw badRequest('Invalid subtitle id');
    await login();
    const res = await fetch(`${token?.base ?? API}/download`, { method: 'POST', headers: headers(true), body: JSON.stringify({ file_id: Number(result.id), sub_format: 'srt' }), signal: AbortSignal.timeout(20000) });
    if (res.status === 406 || res.status === 429) throw new HttpError(429, 'OpenSubtitles download quota reached. Add an OpenSubtitles account in settings for more downloads.', 'quota');
    if (!res.ok) throw new HttpError(502, `OpenSubtitles download failed (HTTP ${res.status})`, 'provider_error');
    const j: any = await res.json();
    const file = await fetch(j.link, { signal: AbortSignal.timeout(30000) });
    if (!file.ok) throw new HttpError(502, 'Could not fetch subtitle file', 'provider_error');
    // sub_format=srt: always SubRip, whatever name the file had.
    return { data: Buffer.from(await file.arrayBuffer()), fileName: `${result.id}.srt` };
  },
};
