import type { MetadataProviderConfig } from '@mediamax/shared';
import { getSettings } from '../../settings.js';
import { baseUrl, norm, providerFetch, ProviderError, url } from '../http.js';
import { yearOf, type ArtCandidate, type BuiltinProvider, type ProviderItem, type ProviderResult } from './types.js';

/**
 * TheAudioDB v1 JSON API: /{key}/search.php?s=, /artist-mb.php?i=, /searchalbum.php?s=&a=, /album-mb.php?i=.
 * The free test key is "2" (limited); a free personal key comes with a free account.
 */

async function call(cfg: MetadataProviderConfig, path: string, params: Record<string, string>, ttlHours?: number): Promise<any | null> {
  if (!cfg.apiKey) throw new ProviderError('TheAudioDB needs an API key (use "2" for testing)');
  const r = await providerFetch('audiodb', url(`${baseUrl('audiodb')}/${encodeURIComponent(cfg.apiKey)}`, path, params), { ttlHours });
  return r.data;
}

const bio = (x: any): string | null => {
  const l = (getSettings().metadataLanguage || 'en').slice(0, 2).toUpperCase();
  return x[`strBiography${l}`] || x[`strDescription${l}`] || x.strBiographyEN || x.strDescriptionEN || null;
};
const s = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function addArt(out: ArtCandidate[], kind: ArtCandidate['kind'], ...urls: unknown[]) {
  const u = urls.map(s).find(Boolean);
  if (u) out.push({ kind, url: u });
}

async function artist(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null> {
  const mbid = item.ids.musicbrainzArtist;
  let j = mbid ? await call(cfg, '/artist-mb.php', { i: mbid }) : null;
  if (!j?.artists?.length) j = await call(cfg, '/search.php', { s: item.title });
  const a = (j?.artists ?? []).find((x: any) => norm(x.strArtist) === norm(item.title) || (mbid && x.strMusicBrainzID === mbid));
  if (!a) return null;
  const art: ArtCandidate[] = [];
  addArt(art, 'poster', a.strArtistThumb);
  addArt(art, 'backdrop', a.strArtistFanart, a.strArtistFanart2, a.strArtistWideThumb);
  addArt(art, 'logo', a.strArtistLogo);
  addArt(art, 'banner', a.strArtistBanner);
  addArt(art, 'clearart', a.strArtistClearart, a.strArtistCutout);
  const formed = Number(a.intFormedYear) || Number(a.intBornYear) || null;
  return {
    fields: { overview: s(bio(a)), genres: [s(a.strGenre)].filter(Boolean) as string[] },
    art,
    ids: { ...(s(a.strMusicBrainzID) ? { musicbrainzArtist: a.strMusicBrainzID } : {}), audiodbArtist: String(a.idArtist) },
    meta: { artistInfo: { formedYear: formed, country: s(a.strCountry), mood: s(a.strMood), style: s(a.strStyle) } },
  };
}

async function album(item: ProviderItem, cfg: MetadataProviderConfig): Promise<ProviderResult | null> {
  const rg = item.ids.musicbrainzReleaseGroup;
  let j = rg ? await call(cfg, '/album-mb.php', { i: rg }) : null;
  if (!j?.album?.length && item.parentTitle) j = await call(cfg, '/searchalbum.php', { s: item.parentTitle, a: item.title });
  const a = (j?.album ?? []).find((x: any) => norm(x.strAlbum) === norm(item.title) || (rg && x.strMusicBrainzID === rg));
  if (!a) return null;
  const art: ArtCandidate[] = [];
  addArt(art, 'poster', a.strAlbumThumb, a.strAlbumThumbHQ);
  addArt(art, 'discart', a.strAlbumCDart);
  addArt(art, 'backdrop', a.strAlbumThumbBack);
  return {
    fields: { overview: s(bio(a)), genres: [s(a.strGenre)].filter(Boolean) as string[], year: yearOf(a.intYearReleased) },
    art,
    ids: { ...(s(a.strMusicBrainzID) ? { musicbrainzReleaseGroup: a.strMusicBrainzID } : {}), audiodbAlbum: String(a.idAlbum) },
  };
}

export const audiodb: BuiltinProvider = {
  id: 'audiodb',
  name: 'TheAudioDB',
  types: ['artist', 'album'],
  key: 'required',
  homepage: 'https://www.theaudiodb.com',
  keyUrl: 'https://www.theaudiodb.com/free_key',
  cost: 'Free key with a free account ("2" works for testing); Patreon supporters get a premium key.',
  description: 'Artist biography, genre, mood, style, formed year and country; artist and album artwork.',
  rateLimit: '30 requests/minute (free tier, enforced client-side); responses are cached.',
  artwork: ['artist', 'album'],
  fetch: async (item, cfg) => (item.type === 'artist' ? artist(item, cfg) : item.type === 'album' ? album(item, cfg) : null),
  async test(cfg) {
    const j = await call(cfg, '/search.php', { s: 'coldplay' }, 0);
    if (!j?.artists?.length) throw new ProviderError('TheAudioDB returned no artists for a known search');
    return `TheAudioDB key works (${j.artists[0].strArtist})`;
  },
  missing: { label: 'artists without a biography', where: "i.type = 'artist' AND (i.overview IS NULL OR i.overview = '')" },
};
