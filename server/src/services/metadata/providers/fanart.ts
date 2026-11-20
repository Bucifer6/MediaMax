import type { MetadataProviderConfig } from '@mediamax/shared';
import { getSettings } from '../../settings.js';
import { baseUrl, providerFetch, ProviderError, url } from '../http.js';
import type { ArtCandidate, BuiltinProvider, ProviderItem, ProviderResult } from './types.js';

/**
 * fanart.tv v3: /movies/{tmdb|imdb id}, /tv/{tvdb id}, /music/{artist mbid}, /music/albums/{release-group mbid}.
 * Every image is { id, url, lang, likes }; we take the most-liked in the metadata language, then English, then any.
 */

function best(list: any[] | undefined): any | null {
  if (!list?.length) return null;
  const lang = (getSettings().metadataLanguage || 'en').slice(0, 2).toLowerCase();
  const sorted = [...list].sort((a, b) => Number(b.likes ?? 0) - Number(a.likes ?? 0));
  return sorted.find((x) => x.lang === lang) ?? sorted.find((x) => x.lang === 'en') ?? sorted.find((x) => !x.lang || x.lang === '00') ?? sorted[0];
}

function pick(out: ArtCandidate[], kind: ArtCandidate['kind'], ...lists: (any[] | undefined)[]) {
  for (const l of lists) {
    const b = best(l);
    if (b?.url) return void out.push({ kind, url: b.url });
  }
}

async function call(cfg: MetadataProviderConfig, path: string, ttlHours?: number): Promise<any | null> {
  if (!cfg.apiKey) throw new ProviderError('fanart.tv needs an API key');
  const r = await providerFetch('fanart', url(baseUrl('fanart'), path, { api_key: cfg.apiKey }), { ttlHours });
  return r.data;
}

async function fetchArt(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null> {
  const art: ArtCandidate[] = [];
  if (item.type === 'movie') {
    const id = item.ids.tmdb ?? item.ids.imdb;
    if (!id) return null;
    const j = await call(cfg, `/movies/${encodeURIComponent(id)}`);
    if (!j) return null;
    pick(art, 'logo', j.hdmovielogo, j.movielogo);
    pick(art, 'poster', j.movieposter);
    pick(art, 'backdrop', j.moviebackground);
    pick(art, 'clearart', j.hdmovieclearart, j.movieart);
    pick(art, 'discart', j.moviedisc);
    pick(art, 'banner', j.moviebanner);
    pick(art, 'thumb', j.moviethumb);
  } else if (item.type === 'show') {
    if (!item.ids.tvdb) return null;
    const j = await call(cfg, `/tv/${encodeURIComponent(item.ids.tvdb)}`);
    if (!j) return null;
    pick(art, 'logo', j.hdtvlogo, j.clearlogo);
    pick(art, 'poster', j.tvposter);
    pick(art, 'backdrop', j.showbackground);
    pick(art, 'clearart', j.hdclearart, j.clearart);
    pick(art, 'banner', j.tvbanner);
    pick(art, 'thumb', j.tvthumb);
    const bySeason = new Map<number, any[]>();
    for (const p of j.seasonposter ?? []) {
      const n = Number(p.season);
      if (!Number.isFinite(n)) continue; // "all"
      bySeason.set(n, [...(bySeason.get(n) ?? []), p]);
    }
    for (const [season, list] of bySeason) {
      const b = best(list);
      if (b?.url) art.push({ kind: 'poster', url: b.url, season });
    }
  } else if (item.type === 'artist') {
    const mbid = item.ids.musicbrainzArtist;
    if (!mbid) return null;
    const j = await call(cfg, `/music/${encodeURIComponent(mbid)}`);
    if (!j) return null;
    pick(art, 'backdrop', j.artistbackground);
    pick(art, 'logo', j.hdmusiclogo, j.musiclogo);
    pick(art, 'poster', j.artistthumb);
    pick(art, 'banner', j.musicbanner);
  } else if (item.type === 'album') {
    const rg = item.ids.musicbrainzReleaseGroup;
    if (!rg) return null;
    const j = await call(cfg, `/music/albums/${encodeURIComponent(rg)}`);
    const a = j?.albums?.[rg] ?? Object.values(j?.albums ?? {})[0];
    if (!a) return null;
    pick(art, 'poster', (a as any).albumcover);
    pick(art, 'discart', (a as any).cdart);
  } else return null;
  return art.length ? { art } : null;
}

export const fanart: BuiltinProvider = {
  id: 'fanart',
  name: 'fanart.tv',
  types: ['movie', 'show', 'artist', 'album'],
  key: 'required',
  homepage: 'https://fanart.tv',
  keyUrl: 'https://fanart.tv/get-an-api-key/',
  cost: 'Free personal API key (images are community-contributed).',
  description: 'Logos, clear art, backgrounds, disc art, banners and season posters for movies and shows; artist backgrounds, logos and album covers by MusicBrainz id.',
  rateLimit: '~10 requests/second (client-side); responses are cached.',
  artwork: ['movie', 'show', 'artist', 'album'],
  fetch: fetchArt,
  async test(cfg) {
    const j = await call(cfg, '/movies/603', 0);
    if (!j) throw new ProviderError('fanart.tv returned no data for a known movie');
    return `fanart.tv key works (${j.name ?? 'The Matrix'})`;
  },
  missing: { label: 'movies and shows without a logo', where: "i.type IN ('movie','show') AND i.logo IS NULL" },
};
