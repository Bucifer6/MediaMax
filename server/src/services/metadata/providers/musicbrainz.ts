import type { ItemType, MatchCandidate } from '@mediamax/shared';
import { baseUrl, norm, providerFetch, url } from '../http.js';
import type { BuiltinProvider, ProviderItem, ProviderResult } from './types.js';

/**
 * MusicBrainz (no key; max 1 request/second, enforced by the shared gate in ../http.ts) + Cover Art Archive.
 * Artist and release-group MBIDs and genres; a front cover from the Cover Art Archive only when an album has none.
 * Same logic as the musicbrainz example plugin (which keeps working alongside).
 */

const q = (s: string) => s.replace(/["\\]/g, '');
const mb = (path: string, params: Record<string, string | number>, ttlHours?: number) =>
  providerFetch('musicbrainz', url(baseUrl('musicbrainz'), path, { ...params, fmt: 'json' }), { ttlHours }).then((r) => r.data);

export const genresOf = (x: any): string[] =>
  [...(x?.genres ?? []), ...(x?.tags ?? [])]
    .filter((g) => (g.count ?? 1) > 0)
    .sort((a, b) => (b.count ?? 0) - (a.count ?? 0))
    .map((g) => String(g.name).replace(/\b\w/g, (c) => c.toUpperCase()))
    .filter((g, i, a) => a.indexOf(g) === i)
    .slice(0, 5);

async function artist(item: ProviderItem): Promise<ProviderResult | null> {
  let mbid = item.ids.musicbrainzArtist;
  if (!mbid) {
    const r = await mb('/artist', { query: `artist:"${q(item.title)}"`, limit: 5 });
    const hit = (r?.artists ?? []).find((a: any) => a.score >= 90 && (norm(a.name) === norm(item.title) || (a.aliases ?? []).some((x: any) => norm(x.name) === norm(item.title))));
    if (!hit) return null;
    mbid = hit.id as string;
  }
  const a = await mb(`/artist/${encodeURIComponent(mbid)}`, { inc: 'genres tags' });
  if (!a) return null;
  const life = a['life-span'] ?? {};
  const bits = [a.type, a.disambiguation, a.area?.name ? `from ${a.area.name}` : null, life.begin ? `active since ${String(life.begin).slice(0, 4)}${life.ended && life.end ? ` until ${String(life.end).slice(0, 4)}` : ''}` : null].filter(Boolean);
  return {
    fields: { overview: bits.length ? `${a.name}: ${bits.join(', ')}.` : null, genres: genresOf(a) },
    ids: { musicbrainzArtist: mbid },
    meta: { artistInfo: { country: a.area?.name ?? null, formedYear: life.begin ? Number(String(life.begin).slice(0, 4)) || null : null } },
  };
}

async function album(item: ProviderItem): Promise<ProviderResult | null> {
  let rg = item.ids.musicbrainzReleaseGroup;
  if (!rg) {
    const parts = [`releasegroup:"${q(item.title)}"`];
    if (item.parentTitle) parts.push(`artist:"${q(item.parentTitle)}"`);
    const r = await mb('/release-group', { query: parts.join(' AND '), limit: 5 });
    const hit = (r?.['release-groups'] ?? []).find((g: any) => g.score >= 90 && norm(g.title) === norm(item.title)
      && (!item.parentTitle || (g['artist-credit'] ?? []).some((c: any) => norm(c.name ?? c.artist?.name) === norm(item.parentTitle))));
    if (!hit) return null;
    rg = hit.id as string;
  }
  const g = await mb(`/release-group/${encodeURIComponent(rg)}`, { inc: 'genres tags' });
  if (!g) return null;
  const out: ProviderResult = { fields: { genres: genresOf(g) }, ids: { musicbrainzReleaseGroup: rg } };
  const year = Number(String(g['first-release-date'] ?? '').slice(0, 4));
  if (year) out.fields!.year = year;
  // Cover Art Archive answers with a redirect to the image (404 when there is no front cover). Only asked when the album has no cover.
  if (!item.row.poster || item.replace) {
    const coverUrl = `${baseUrl('coverart')}/release-group/${encodeURIComponent(rg)}/front-500`;
    const r = await providerFetch('coverart', coverUrl, { manualRedirect: true, headers: { Accept: '*/*' } }).catch(() => null);
    if (r && r.status !== 404 && (r.location || r.status === 200)) out.art = [{ kind: 'poster', url: coverUrl }];
  }
  return out;
}

export const musicbrainz: BuiltinProvider = {
  id: 'musicbrainz',
  name: 'MusicBrainz + Cover Art Archive',
  types: ['artist', 'album'],
  key: 'none',
  homepage: 'https://musicbrainz.org',
  keyUrl: null,
  cost: 'Free, no key.',
  description: 'Artist and album (release-group) MBIDs and genres; album covers from the Cover Art Archive when an album has none. MBIDs let fanart.tv and TheAudioDB find exact matches.',
  rateLimit: '1 request/second (MusicBrainz policy, enforced); responses are cached.',
  artwork: ['album'],
  fetch: async (item) => (item.type === 'artist' ? artist(item) : item.type === 'album' ? album(item) : null),
  async test() {
    const r = await mb('/artist', { query: 'artist:"Radiohead"', limit: 1 }, 0);
    if (!r?.artists?.length) throw new Error('MusicBrainz returned no artists for a known search');
    return `MusicBrainz works (${r.artists[0].name})`;
  },
  async search(type: ItemType, query, _year, _cfg, parentTitle): Promise<MatchCandidate[]> {
    if (type === 'artist') {
      const r = await mb('/artist', { query: `artist:"${q(query)}"`, limit: 10 }, 1);
      return (r?.artists ?? []).map((a: any) => ({
        provider: 'musicbrainz', id: a.id, title: a.name, year: Number(String(a['life-span']?.begin ?? '').slice(0, 4)) || null,
        subtitle: [a.type, a.disambiguation, a.area?.name].filter(Boolean).join(' · ') || null, overview: null, imageUrl: null,
      }));
    }
    const parts = [`releasegroup:"${q(query)}"`];
    if (parentTitle) parts.push(`artist:"${q(parentTitle)}"`);
    const r = await mb('/release-group', { query: parts.join(' AND '), limit: 10 }, 1);
    return (r?.['release-groups'] ?? []).map((g: any) => ({
      provider: 'musicbrainz', id: g.id, title: g.title, year: Number(String(g['first-release-date'] ?? '').slice(0, 4)) || null,
      subtitle: [(g['artist-credit'] ?? []).map((c: any) => c.name ?? c.artist?.name).join(', '), g['primary-type']].filter(Boolean).join(' · ') || null,
      overview: null, imageUrl: `${baseUrl('coverart')}/release-group/${g.id}/front-250`,
    }));
  },
  matchIdKey: (type) => (type === 'artist' ? 'musicbrainzArtist' : 'musicbrainzReleaseGroup'),
  missing: {
    label: 'artists and albums without a MusicBrainz id',
    where: "((i.type = 'artist' AND json_extract(i.external_ids, '$.musicbrainzArtist') IS NULL) OR (i.type = 'album' AND json_extract(i.external_ids, '$.musicbrainzReleaseGroup') IS NULL))",
  },
};
