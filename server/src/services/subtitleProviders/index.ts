/**
 * Subtitle providers: registry, search fan-out/merge, the download pipeline and the automatic download task.
 *
 * Search asks every enabled, configured provider (admin priority order) in parallel, scores each hit against the
 * media file's release name and merges them: best score first, provider priority breaks ties, then downloads.
 * Download: provider → unpack archive (season packs: pick SxxEyy) → clean-up (encoding, diacritics, adverts) →
 * optional alass sync → save (data folder or sidecar) → refresh the media row's subtitle list.
 */
import path from 'node:path';
import type { RemoteSubtitle, SubtitleProviderInfo, SubtitleStream } from '@mediamax/shared';
import { db } from '../../db.js';
import { getSettings } from '../settings.js';
import { badRequest, HttpError, notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { normLang } from '../probe.js';
import { logger } from '../../util/log.js';
import { pluginSubtitleProviders } from '../plugins.js';
import type { ProviderSubtitle, SubtitleProvider, SubtitleQuery } from './types.js';
import { movieHash, openSubtitlesProvider } from './opensubtitles.js';
import { subsRoProvider } from './subsro.js';
import { parseRelease, scoreRelease } from './release.js';
import { archiveKind, archiveUnsupportedReason, extractArchive, KEEP_EXT, pickSubtitleFile } from './archive.js';
import { cleanSubtitle } from './cleanup.js';
import { syncWithAlass } from './tools.js';
import { lang2 } from './lang.js';
import { providerLabel, refreshMediaSubs, saveSubtitle, setProviderLabel } from './storage.js';

export type { SubtitleProvider, SubtitleQuery, ProviderSubtitle } from './types.js';
export { movieHash } from './opensubtitles.js';
export { downloadedSubs, subtitlesDir, refreshMediaSubs, deleteDownloadedSubtitle } from './storage.js';

const log = logger('subtitles');

/* ------------------------------ registry ------------------------------ */

const BUILTIN: SubtitleProvider[] = [openSubtitlesProvider, subsRoProvider];

export function allProviders(): SubtitleProvider[] {
  const plugins = pluginSubtitleProviders();
  for (const p of plugins) setProviderLabel(p.id, p.name);
  return [...BUILTIN, ...plugins];
}

const isConfigured = (p: SubtitleProvider) => {
  try {
    return p.configured ? p.configured() : true;
  } catch {
    return false;
  }
};

/** Every known provider in the admin's priority order (unlisted ones appended, enabled). */
export function providerInfos(): SubtitleProviderInfo[] {
  const all = allProviders();
  const order = getSettings().subtitles?.providers ?? [];
  const listed = order.flatMap((o) => {
    const p = all.find((x) => x.id === o.id);
    return p ? [{ p, enabled: o.enabled }] : [];
  });
  const rest = all.filter((p) => !order.some((o) => o.id === p.id)).map((p) => ({ p, enabled: true }));
  return [...listed, ...rest].map(({ p, enabled }) => ({ id: p.id, name: p.name, builtin: BUILTIN.includes(p), configured: isConfigured(p), enabled }));
}

/** Enabled and configured providers, highest priority first. */
export function activeProviders(): SubtitleProvider[] {
  const all = allProviders();
  return providerInfos().filter((i) => i.enabled && i.configured).map((i) => all.find((p) => p.id === i.id)!);
}

/* ------------------------------- search ------------------------------- */

interface MediaRow { id: string; path: string | null; size: number | null }

function bestMedia(itemId: string): MediaRow | undefined {
  return db.get<MediaRow>('SELECT id, path, size FROM media WHERE item_id = ? ORDER BY COALESCE(width,0) DESC LIMIT 1', itemId);
}

/** Everything providers may search by, for one item. */
export function buildQuery(itemId: string, languages: string[]): SubtitleQuery {
  const item = db.get('SELECT * FROM items WHERE id = ?', itemId);
  if (!item) throw notFound('Item not found');
  const media = bestMedia(itemId) ?? null;
  const ids = parseJson<Record<string, string>>(item.external_ids, {});
  const show = item.type === 'episode' && item.grandparent_id ? db.get('SELECT external_ids, title FROM items WHERE id = ?', item.grandparent_id) : null;
  const sids = parseJson<Record<string, string>>(show?.external_ids, {});
  const langs = [...new Set((languages.length ? languages : ['en']).map((l) => l.trim().toLowerCase()).filter(Boolean))];
  return {
    item: { id: item.id, type: item.type, title: item.title, year: item.year ?? null },
    media,
    languages: langs.length ? langs : ['en'],
    imdbId: ids.imdb ?? null,
    tmdbId: ids.tmdb ?? null,
    showImdbId: sids.imdb ?? null,
    showTmdbId: sids.tmdb ?? null,
    showTitle: show?.title ?? null,
    season: item.type === 'episode' ? item.parent_idx ?? null : null,
    episode: item.type === 'episode' ? item.idx ?? null : null,
    title: item.type === 'episode' ? show?.title ?? item.title : item.title,
    year: item.year ?? null,
    releaseName: media?.path ? path.basename(media.path) : null,
    movieHash: media?.path ? movieHash(media.path) : null,
  };
}

export interface ScoredResult { remote: RemoteSubtitle; raw: ProviderSubtitle; mismatch: boolean; priority: number }

/** Recent search hits, so a download can hand the provider its full result (not just the id). */
const recent = new Map<string, { raw: ProviderSubtitle; at: number }>();
const recentKey = (provider: string, id: string) => `${provider}\u0000${id}`;
function remember(provider: string, raw: ProviderSubtitle) {
  recent.set(recentKey(provider, raw.id), { raw, at: Date.now() });
  if (recent.size > 5000) {
    const cutoff = Date.now() - 3600000;
    for (const [k, v] of recent) if (v.at < cutoff || recent.size > 4000) recent.delete(k);
  }
}

const SEARCH_TIMEOUT_MS = 25000;

/**
 * Ask `providers` (in priority order) in parallel, score and merge. Throws the first provider error when every
 * provider failed (so a single-provider setup reports exactly what that provider said).
 */
export async function searchProviders(providers: SubtitleProvider[], query: SubtitleQuery): Promise<ScoredResult[]> {
  const media = parseRelease(query.releaseName);
  const settled = await Promise.allSettled(providers.map((p) => Promise.race([
    p.search(query),
    new Promise<never>((_, rej) => setTimeout(() => rej(new HttpError(504, `${p.name} did not answer in time`, 'provider_error')), SEARCH_TIMEOUT_MS).unref?.()),
  ])));
  const out: ScoredResult[] = [];
  const errors: unknown[] = [];
  settled.forEach((s, priority) => {
    const p = providers[priority];
    if (s.status === 'rejected') {
      errors.push(s.reason);
      log.warn(`${p.name} search failed: ${(s.reason as Error)?.message ?? s.reason}`);
      return;
    }
    const seen = new Set<string>();
    for (const raw of Array.isArray(s.value) ? s.value : []) {
      if (!raw || raw.id == null || seen.has(String(raw.id))) continue;
      const r: ProviderSubtitle = { ...raw, id: String(raw.id), language: lang2(raw.language) };
      seen.add(r.id);
      remember(p.id, r);
      const m = scoreRelease(media, [r.release, r.fileName].filter(Boolean).join(' / '), { hashMatch: r.hashMatch, season: query.season, episode: query.episode, aiTranslated: r.aiTranslated });
      out.push({
        raw: r, mismatch: m.mismatch, priority,
        remote: {
          fileId: r.id, provider: p.id, providerName: p.name, language: r.language, release: r.release ?? r.fileName ?? null, downloads: r.downloads ?? 0,
          hearingImpaired: !!r.hearingImpaired, forced: !!r.forced, aiTranslated: !!r.aiTranslated, rating: r.rating ?? null,
          score: m.score, scoreReasons: m.reasons, hashMatch: !!r.hashMatch, unavailableReason: archiveUnsupportedReason(r.archive),
        },
      });
    }
  });
  if (providers.length && errors.length === providers.length) throw errors[0];
  return out.sort((a, b) => Number(a.mismatch) - Number(b.mismatch) || (b.remote.score ?? 0) - (a.remote.score ?? 0) || a.priority - b.priority || b.remote.downloads - a.remote.downloads);
}

function requireProviders(exclude?: Set<string>): SubtitleProvider[] {
  const providers = activeProviders().filter((p) => !exclude?.has(p.id));
  if (!providers.length) throw badRequest('Online subtitles are not configured. Add an OpenSubtitles or Subs.ro API key in Admin → Settings → Subtitles.');
  return providers;
}

async function searchScored(itemId: string, languages: string[], exclude?: Set<string>): Promise<ScoredResult[]> {
  return searchProviders(requireProviders(exclude), buildQuery(itemId, languages));
}

export async function searchSubtitles(itemId: string, languages: string[]): Promise<RemoteSubtitle[]> {
  return (await searchScored(itemId, languages)).map((r) => r.remote);
}

/* ------------------------------ download ------------------------------ */

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/** Subtitle format from content when the name doesn't say. */
function sniffFormat(data: Buffer): 'srt' | 'ass' | 'vtt' | null {
  const head = data.subarray(0, 2048).toString('latin1').replace(/^﻿|^\xEF\xBB\xBF/, '').trimStart();
  if (/^\[Script Info\]/i.test(head)) return 'ass';
  if (/^WEBVTT/.test(head)) return 'vtt';
  if (/^\d+\s*\r?\n\s*\d{1,2}:\d{2}:\d{2}[,.]\d{1,3}\s*-->/.test(head)) return 'srt';
  return null;
}

export interface ProcessedSubtitle { data: Buffer; ext: 'srt' | 'ass' | 'vtt'; fixes: string[]; synced: boolean; sourceName: string }

/**
 * Download one result and turn it into a clean UTF-8 subtitle file: archive unpacking (season packs by SxxEyy),
 * format detection, clean-up and optional alass sync. Exported for tests (no DB writes).
 */
export async function fetchProcessed(provider: SubtitleProvider, raw: ProviderSubtitle, query: Pick<SubtitleQuery, 'season' | 'episode' | 'releaseName'> & { videoPath?: string | null; sync?: boolean }): Promise<ProcessedSubtitle> {
  const file = await provider.download(raw);
  let data = file.data;
  let name = file.fileName || `${raw.id}.srt`;
  const kind = archiveKind(data);
  if (kind) {
    const entries = await extractArchive(data, kind);
    const pick = pickSubtitleFile(entries, { season: query.season, episode: query.episode, media: parseRelease(query.releaseName), language: raw.language });
    if (!pick) {
      const ep = query.episode != null ? ` for S${String(query.season ?? 0).padStart(2, '0')}E${String(query.episode).padStart(2, '0')}` : '';
      throw new HttpError(404, `The ${kind.toUpperCase()} archive has no subtitle file${ep}`, 'no_subtitle_in_archive');
    }
    data = pick.data;
    name = pick.name;
  }
  let ext = extOf(name);
  if (ext === 'ssa') ext = 'ass';
  if (!KEEP_EXT.has(ext)) {
    const sniffed = sniffFormat(data);
    if (!sniffed) throw new HttpError(422, `Unsupported subtitle file (${path.basename(name)})`, 'unsupported_subtitle');
    ext = sniffed;
  }
  const fmt = ext as 'srt' | 'ass' | 'vtt';
  const cleaned = cleanSubtitle(data, raw.language, fmt);
  let out: Buffer = Buffer.from(cleaned.text, 'utf8');
  let synced = false;
  if (query.sync && query.videoPath) {
    const s = await syncWithAlass(query.videoPath, out, fmt);
    if (s) {
      out = s;
      synced = true;
    }
  }
  return { data: out, ext: fmt, fixes: cleaned.fixes, synced, sourceName: name };
}

export interface DownloadRequest {
  provider?: string;
  fileId: string;
  language: string;
  hearingImpaired?: boolean;
  forced?: boolean;
  release?: string | null;
  score?: number | null;
}

export async function downloadSubtitle(itemId: string, req: DownloadRequest): Promise<void> {
  const media = bestMedia(itemId);
  if (!media) throw notFound('No media for this item');
  const providerId = req.provider || 'opensubtitles';
  const provider = allProviders().find((p) => p.id === providerId);
  if (!provider) throw badRequest(`Unknown subtitle provider "${providerId}"`);
  const fileId = String(req.fileId);
  if (!/^[\w.:=-]{1,1000}$/.test(fileId)) throw badRequest('Invalid subtitle id');
  const cached = recent.get(recentKey(providerId, fileId))?.raw;
  const raw: ProviderSubtitle = cached ?? { id: fileId, language: lang2(req.language), release: req.release ?? null, hearingImpaired: req.hearingImpaired, forced: req.forced };
  const lang = /^[a-z]{2,3}(-[a-z]{2})?$/i.test(req.language ?? '') ? lang2(req.language) : raw.language;
  const q = buildQuery(itemId, [lang]);
  const s = getSettings().subtitles!;
  const processed = await fetchProcessed(provider, { ...raw, language: lang }, { season: q.season, episode: q.episode, releaseName: q.releaseName, videoPath: media.path, sync: s.sync });
  const flag = req.forced ? 'forced' : req.hearingImpaired ? 'hi' : 'std';
  const score = req.score ?? scoreRelease(parseRelease(q.releaseName), raw.release, { hashMatch: raw.hashMatch, season: q.season, episode: q.episode }).score;
  const file = saveSubtitle({
    mediaId: media.id, videoPath: media.path, data: processed.data, ext: processed.ext, language: lang, flag, provider: providerId, fileId,
    release: raw.release ?? null, score, synced: processed.synced, mode: s.saveMode,
  });
  log.info(`Saved ${providerLabel(providerId)} subtitle ${path.basename(file)}${processed.fixes.length ? ` (${processed.fixes.join(', ')})` : ''}${processed.synced ? ', synced with alass' : ''}`);
  refreshMediaSubs(media.id);
}

/* --------------------------- automatic task --------------------------- */

/** True when the "Download missing subtitles" task has something to do. */
export function autoDownloadEnabled(): boolean {
  return !!getSettings().subtitles?.languages.length && activeProviders().length > 0;
}

/** Auto-download preferred languages for media that lack them, picking the best-scoring release. */
export async function autoDownload(progress: (p: number) => void, filter?: (mediaPath: string) => boolean): Promise<number> {
  const s = getSettings().subtitles!;
  if (!autoDownloadEnabled()) return 0;
  const rows = db.all(`SELECT i.id, m.id mid, m.subs, m.path FROM items i JOIN media m ON m.item_id = i.id
    WHERE i.type IN ('movie','episode') AND m.path IS NOT NULL ORDER BY i.added_at DESC LIMIT 300`).filter((r) => !filter || filter(r.path));
  const exhausted = new Set<string>();
  const total = activeProviders().length;
  let n = 0;
  for (let i = 0; i < rows.length; i++) {
    const subs = parseJson<SubtitleStream[]>(rows[i].subs, []);
    for (const lang of s.languages) {
      const l3 = normLang(lang);
      if (subs.some((x) => x.language === l3 || x.language === lang)) continue;
      let results: ScoredResult[];
      try {
        results = await searchScored(rows[i].id, [lang], exhausted);
      } catch (e) {
        if ((e as HttpError).statusCode === 429) return n;
        log.debug(`Auto subtitle search failed: ${(e as Error).message}`);
        continue;
      }
      const candidates = results.filter((r) => !r.mismatch && !r.remote.aiTranslated && !r.remote.forced && !r.remote.unavailableReason && (r.remote.score ?? 0) >= s.minScore);
      for (const c of candidates.slice(0, 3)) {
        if (exhausted.has(c.remote.provider)) continue;
        try {
          await downloadSubtitle(rows[i].id, { provider: c.remote.provider, fileId: c.remote.fileId, language: lang, hearingImpaired: c.remote.hearingImpaired, release: c.remote.release, score: c.remote.score });
          n++;
          break;
        } catch (e) {
          const code = (e as HttpError).statusCode;
          if (code === 429) {
            exhausted.add(c.remote.provider);
            if (exhausted.size >= total) return n;
            continue;
          }
          log.debug(`Auto subtitle download failed (${c.remote.providerName}): ${(e as Error).message}`);
          // Archive without our episode / RAR without tools: the next candidate may work.
          if (code === 404 || code === 422) continue;
          break;
        }
      }
    }
    progress(Math.round(((i + 1) / rows.length) * 100));
  }
  return n;
}
