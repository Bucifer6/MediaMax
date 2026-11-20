import type { Chapter, MatchCandidate, Person } from '@mediamax/shared';
import { db } from '../../../db.js';
import { getSettings } from '../../settings.js';
import { ffprobeJson } from '../../probe.js';
import { baseUrl, providerFetch, url } from '../http.js';
import { dateOf, stripHtml, yearOf, type BuiltinProvider, type ProviderItem, type ProviderResult } from './types.js';

/**
 * Audnexus (https://api.audnex.us, no key): /books/{ASIN}?region= and /books/{ASIN}/chapters.
 * Audnexus has no title search for books, so the ASIN comes from (in order) the item's external ids
 * (set by "Fix match"), the folder/file name ("Title [B0XXXXXXXX]"), or the first file's tags (ASIN / AUDIBLE_ASIN).
 */

const ASIN_BRACKETED = /[[({]\s*(B0[0-9A-Z]{8}|\d{9}[\dX])\s*[\])}]/i;
const ASIN_BARE = /(?:^|[\s_.-])(B0[0-9A-Z]{8})(?=$|[\s_.-])/;
export const isAsin = (s: string) => /^(B0[0-9A-Z]{8}|\d{9}[\dX])$/i.test(s.trim());

/** ASIN from a folder or file name: "Project Hail Mary [B08G9PRS1K]" or "B08G9PRS1K - Project Hail Mary". */
export function asinFromPath(p: string | null | undefined): string | null {
  if (!p) return null;
  for (const part of p.split(/[\\/]/).reverse().slice(0, 2)) {
    const m = part.match(ASIN_BRACKETED) ?? part.match(ASIN_BARE);
    if (m) return m[1].toUpperCase();
  }
  return null;
}

async function asinFromTags(itemId: string): Promise<string | null> {
  const m = db.get<{ path: string }>(
    "SELECT m.path FROM media m JOIN items p ON p.id = m.item_id WHERE p.parent_id = ? AND m.path IS NOT NULL ORDER BY p.idx LIMIT 1", itemId);
  if (!m?.path) return null;
  try {
    const j = await ffprobeJson(m.path, [], 15000);
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...(j.format?.tags ?? {}), ...(j.streams?.[0]?.tags ?? {}) })) tags[k.toLowerCase()] = String(v);
    const v = tags.asin ?? tags.audible_asin ?? tags['----:com.apple.itunes:asin'] ?? tags.cdek ?? null;
    return v && isAsin(v) ? v.trim().toUpperCase() : null;
  } catch {
    return null;
  }
}

/** Audnexus/Audible regions; picked from the metadata language's country (en-GB → uk). */
const REGIONS = ['us', 'uk', 'ca', 'au', 'in', 'de', 'fr', 'it', 'es', 'jp'];
export function audibleRegion(): string {
  const c = ((getSettings().metadataLanguage || 'en-US').split('-')[1] ?? 'US').toLowerCase();
  const r = c === 'gb' ? 'uk' : c;
  return REGIONS.includes(r) ? r : 'us';
}

export async function audnexusBook(asin: string, ttlHours?: number): Promise<any | null> {
  const r = await providerFetch('audnexus', url(baseUrl('audnexus'), `/books/${encodeURIComponent(asin)}`, { region: audibleRegion() }), { ttlHours });
  return r.data && r.data.asin ? r.data : null;
}

async function chapters(asin: string): Promise<Chapter[]> {
  const r = await providerFetch('audnexus', url(baseUrl('audnexus'), `/books/${encodeURIComponent(asin)}/chapters`, { region: audibleRegion() })).catch(() => null);
  return (r?.data?.chapters ?? [])
    .filter((c: any) => Number.isFinite(c.startOffsetMs) && Number.isFinite(c.lengthMs))
    .map((c: any) => ({ title: String(c.title ?? ''), startMs: Number(c.startOffsetMs), endMs: Number(c.startOffsetMs) + Number(c.lengthMs) }));
}

export function bookResult(b: any, ch: Chapter[]): ProviderResult {
  const people: Person[] = [
    ...(b.authors ?? []).map((a: any) => ({ name: a.name, role: 'Author', kind: 'writer' as const, imageUrl: null })),
    ...(b.narrators ?? []).map((n: any) => ({ name: n.name, role: 'Narrator', kind: 'actor' as const, imageUrl: null })),
  ];
  const sp = b.seriesPrimary;
  const pos = sp?.position != null ? parseFloat(String(sp.position)) : NaN;
  return {
    fields: {
      title: b.subtitle ? `${b.title}: ${b.subtitle}` : b.title ?? null,
      overview: stripHtml(b.summary) ?? stripHtml(b.description),
      genres: (b.genres ?? []).filter((g: any) => g.type === 'genre').map((g: any) => g.name),
      year: yearOf(b.releaseDate),
      releaseDate: dateOf(b.releaseDate),
      studios: b.publisherName ? [b.publisherName] : [],
      people,
      communityRating: Number(b.rating) > 0 ? Math.round(Number(b.rating) * 2 * 10) / 10 : null,
    },
    art: b.image ? [{ kind: 'poster', url: b.image }] : [],
    ids: { asin: b.asin, ...(b.isbn ? { isbn: String(b.isbn) } : {}) },
    meta: { ...(ch.length ? { chapters: ch } : {}), ...(sp?.name ? { series: { name: sp.name, index: Number.isFinite(pos) ? pos : null } } : {}), ...(b.isbn ? { isbn: String(b.isbn) } : {}) },
  };
}

async function fetchBook(item: ProviderItem): Promise<ProviderResult | null> {
  if (item.type !== 'audiobook') return null;
  const asin = item.ids.asin ?? asinFromPath(item.row.path) ?? (await asinFromTags(item.id));
  if (!asin) return null;
  const b = await audnexusBook(asin);
  if (!b) return null;
  return bookResult(b, await chapters(b.asin ?? asin));
}

export const audnexus: BuiltinProvider = {
  id: 'audnexus',
  name: 'Audnexus (Audible)',
  types: ['audiobook'],
  key: 'none',
  homepage: 'https://audnex.us',
  keyUrl: null,
  cost: 'Free, no key.',
  description: 'Audiobook title, authors, narrators, series and position, description, genres, cover and chapters by ASIN. The ASIN comes from the folder/file name ("Title [B0XXXXXXXX]"), the ASIN tag, or Fix match.',
  rateLimit: '~6 requests/second (client-side); responses are cached.',
  artwork: ['audiobook'],
  fetch: (item) => fetchBook(item),
  async test() {
    const b = await audnexusBook('B08G9PRS1K', 0);
    if (!b) throw new Error('Audnexus returned no book for a known ASIN');
    return `Audnexus works (${b.title})`;
  },
  async search(_type, query): Promise<MatchCandidate[]> {
    // No title search in Audnexus: the "search" is an ASIN lookup.
    const asin = query.trim().toUpperCase();
    if (!isAsin(asin)) return [];
    const b = await audnexusBook(asin, 1);
    if (!b) return [];
    return [{
      provider: 'audnexus', id: b.asin, title: b.title, year: yearOf(b.releaseDate),
      subtitle: [(b.authors ?? []).map((a: any) => a.name).join(', '), b.seriesPrimary?.name ? `${b.seriesPrimary.name}${b.seriesPrimary.position ? ` #${b.seriesPrimary.position}` : ''}` : null].filter(Boolean).join(' · ') || null,
      overview: stripHtml(b.summary)?.slice(0, 400) ?? null, imageUrl: b.image ?? null,
    }];
  },
  matchIdKey: () => 'asin',
  missing: { label: 'audiobooks without an ASIN', where: "i.type = 'audiobook' AND json_extract(i.external_ids, '$.asin') IS NULL" },
};
