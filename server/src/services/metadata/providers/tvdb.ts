import type { EpisodeOrder, MatchCandidate, MetadataProviderConfig } from '@mediamax/shared';
import { getSettings } from '../../settings.js';
import { baseUrl, norm, providerFetch, ProviderError, url } from '../http.js';
import { dateOf, yearOf, type ArtCandidate, type BuiltinProvider, type ProviderItem, type RemoteEpisodeInfo } from './types.js';

/**
 * TheTVDB API v4: login with an API key (+ optional subscriber PIN) for a bearer token (valid ~1 month),
 * then /search, /series/{id}/extended, /series/{id}/translations/{lang} and
 * /series/{id}/episodes/{season-type}/{lang} (season types: default = aired, dvd, absolute).
 */

let token: { sig: string; token: string; at: number } | null = null;
const TOKEN_TTL_MS = 25 * 24 * 3600_000;

async function login(cfg: MetadataProviderConfig, force = false): Promise<string> {
  if (!cfg.apiKey) throw new ProviderError('TheTVDB needs an API key');
  const sig = `${cfg.apiKey}|${cfg.pin ?? ''}`;
  if (!force && token && token.sig === sig && Date.now() - token.at < TOKEN_TTL_MS) return token.token;
  const r = await providerFetch<any>('tvdb', `${baseUrl('tvdb')}/login`, {
    method: 'POST', body: { apikey: cfg.apiKey, ...(cfg.pin ? { pin: cfg.pin } : {}) }, ttlHours: 0,
  }).catch((e: ProviderError) => {
    throw new ProviderError(e.status === 401 ? 'TheTVDB rejected the API key / PIN' : e.message, e.status);
  });
  const t = r.data?.data?.token;
  if (!t) throw new ProviderError('TheTVDB login returned no token');
  token = { sig, token: t, at: Date.now() };
  return t;
}

/** Drop the cached token (tests). */
export const resetTvdbToken = () => (token = null);

async function get<T = any>(cfg: MetadataProviderConfig, path: string, params: Record<string, string | number | null | undefined> = {}, ttlHours?: number): Promise<T | null> {
  const u = url(baseUrl('tvdb'), path, params);
  for (let i = 0; i < 2; i++) {
    const t = await login(cfg, i > 0);
    try {
      const r = await providerFetch<T>('tvdb', u, { headers: { Authorization: `Bearer ${t}` }, ttlHours });
      return r.data;
    } catch (e) {
      if ((e as ProviderError).status === 401 && i === 0) continue; // token expired: log in again
      throw e;
    }
  }
  return null;
}

/** TheTVDB uses ISO 639-2 codes for translations. */
const LANG3: Record<string, string> = {
  en: 'eng', de: 'deu', fr: 'fra', es: 'spa', it: 'ita', ja: 'jpn', pt: 'por', nl: 'nld', sv: 'swe', da: 'dan', no: 'nor', nb: 'nor', fi: 'fin',
  pl: 'pol', ru: 'rus', zh: 'zho', ko: 'kor', cs: 'ces', hu: 'hun', tr: 'tur', el: 'ell', he: 'heb', ar: 'ara',
};
export const tvdbLang = () => LANG3[(getSettings().metadataLanguage || 'en').slice(0, 2).toLowerCase()] ?? 'eng';

const SEASON_TYPE: Record<EpisodeOrder, string> = { aired: 'default', dvd: 'dvd', absolute: 'absolute' };

async function findSeries(item: ProviderItem, cfg: MetadataProviderConfig): Promise<string | null> {
  if (item.ids.tvdb) return item.ids.tvdb;
  const r = await get<any>(cfg, '/search', { query: item.title, type: 'series', year: item.year ?? undefined });
  const hits: any[] = r?.data ?? [];
  const hit = hits.find((h) => norm(h.name) === norm(item.title) || norm(h.translations?.eng) === norm(item.title)) ?? (hits.length === 1 ? hits[0] : null);
  return hit ? String(hit.tvdb_id ?? String(hit.id ?? '').replace(/^series-/, '')) : null;
}

/** All episodes of a series in one ordering (paged, capped at 20 pages = 10k episodes). */
export async function seriesEpisodes(cfg: MetadataProviderConfig, seriesId: string, order: EpisodeOrder): Promise<RemoteEpisodeInfo[]> {
  const out: RemoteEpisodeInfo[] = [];
  for (let page = 0; page < 20; page++) {
    const r = await get<any>(cfg, `/series/${encodeURIComponent(seriesId)}/episodes/${SEASON_TYPE[order]}/${tvdbLang()}`, { page });
    for (const e of r?.data?.episodes ?? []) {
      if (e.seasonNumber == null || e.number == null) continue;
      out.push({
        season: Number(e.seasonNumber), episode: Number(e.number), absolute: e.absoluteNumber ? Number(e.absoluteNumber) : null,
        title: e.name || null, overview: e.overview || null, airDate: dateOf(e.aired), image: e.image || null,
      });
    }
    if (!r?.links?.next) break;
  }
  return out;
}

const ART_TYPES: Record<number, ArtCandidate['kind']> = { 1: 'banner', 2: 'poster', 3: 'backdrop', 22: 'clearart', 23: 'logo' };

async function fetchShow(item: ProviderItem, cfg: MetadataProviderConfig) {
  const id = await findSeries(item, cfg);
  if (!id) return null;
  const s = (await get<any>(cfg, `/series/${encodeURIComponent(id)}/extended`, { short: 'true' }))?.data;
  if (!s) return null;
  const lang = tvdbLang();
  // Base records are in the original language (Japanese for most anime); use the translation when there is one.
  let name: string | null = s.name ?? null;
  let overview: string | null = s.overview ?? null;
  if (s.originalLanguage !== lang && ((s.nameTranslations ?? []).includes(lang) || (s.overviewTranslations ?? []).includes(lang))) {
    const t = (await get<any>(cfg, `/series/${encodeURIComponent(id)}/translations/${lang}`))?.data;
    if (t?.name) name = t.name;
    if (t?.overview) overview = t.overview;
  }
  const art: ArtCandidate[] = [];
  const arts: any[] = [...(s.artworks ?? [])].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  const langOk = (a: any) => !a.language || a.language === lang || a.language === 'eng';
  for (const [type, kind] of Object.entries(ART_TYPES)) {
    const a = arts.find((x) => x.type === Number(type) && langOk(x));
    if (a?.image) art.push({ kind, url: a.image });
  }
  if (s.image && !art.some((a) => a.kind === 'poster')) art.push({ kind: 'poster', url: s.image });
  for (const se of s.seasons ?? []) {
    if (se.image && (se.type?.type ?? 'official') === 'official' && se.number != null) art.push({ kind: 'poster', url: se.image, season: Number(se.number) });
  }
  const imdb = (s.remoteIds ?? []).find((r: any) => /imdb/i.test(r.sourceName ?? ''))?.id;
  const tmdbId = (s.remoteIds ?? []).find((r: any) => /themoviedb/i.test(r.sourceName ?? ''))?.id;
  const episodes = await seriesEpisodes(cfg, id, item.episodeOrder);
  return {
    fields: {
      title: name, overview, year: yearOf(s.firstAired ?? s.year), releaseDate: dateOf(s.firstAired),
      genres: (s.genres ?? []).map((g: any) => g.name).filter(Boolean),
      studios: (s.companies ?? []).filter((c: any) => c.companyType?.companyTypeName === 'Network' || c.primaryCompanyType === 1).map((c: any) => c.name).slice(0, 3),
    },
    art,
    ids: { tvdb: String(id), ...(imdb ? { imdb: String(imdb) } : {}), ...(tmdbId ? { tmdb: String(tmdbId) } : {}) },
    episodes,
  };
}

export const tvdb: BuiltinProvider = {
  id: 'tvdb',
  name: 'TheTVDB',
  types: ['show'],
  key: 'required',
  pin: true,
  homepage: 'https://thetvdb.com',
  keyUrl: 'https://thetvdb.com/api-information',
  cost: 'Free for personal use with a user-supported key (optional subscriber PIN); companies need a licence.',
  description: 'Show and episode data with aired, DVD and absolute episode orderings (important for anime). Choose the ordering per show on its Edit page.',
  rateLimit: '~10 requests/second (client-side); responses are cached.',
  artwork: ['show'],
  fetch: async (item, cfg) => (item.type === 'show' ? fetchShow(item, cfg) : null),
  async test(cfg) {
    resetTvdbToken();
    await login(cfg, true);
    return 'Logged in to TheTVDB';
  },
  async search(_type, query, year, cfg): Promise<MatchCandidate[]> {
    const r = await get<any>(cfg, '/search', { query, type: 'series', year: year ?? undefined }, 1);
    return (r?.data ?? []).slice(0, 15).map((h: any) => ({
      provider: 'tvdb', id: String(h.tvdb_id ?? String(h.id ?? '').replace(/^series-/, '')), title: h.translations?.eng ?? h.name,
      year: yearOf(h.year ?? h.first_air_time), subtitle: [h.network, h.country?.toUpperCase()].filter(Boolean).join(' · ') || null,
      overview: h.overviews?.eng ?? h.overview ?? null, imageUrl: h.image_url ?? h.thumbnail ?? null,
    }));
  },
  matchIdKey: () => 'tvdb',
  missing: { label: 'shows without a TheTVDB id', where: "i.type = 'show' AND json_extract(i.external_ids, '$.tvdb') IS NULL" },
};
