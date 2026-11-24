import type { DiscographyResponse, DiscographySection, Item, MissingRelease, RelatedArtist, RelatedArtistsResponse, User } from '@mediamax/shared';
import { db, type Row } from '../../db.js';
import { parseJson } from '../../util/misc.js';
import { logger } from '../../util/log.js';
import { baseUrl, norm, providerFetch, url } from '../metadata/http.js';
import { accessClause, getChildren, getItem, selectItems, withCredits } from '../items.js';
import { imageUrl } from '../images.js';
import { requestLevel } from '../requestPerms.js';
import { instanceFor } from '../arr/client.js';
import { creditsFromMb, rebuildCredits } from './credits.js';
import { getMusicSettings } from './settings.js';
import { isMbid } from './tags.js';

/**
 * MusicBrainz lookups beyond the metadata provider: a release's tracklist (recording MBIDs and artist credits for
 * tracks without them), an artist's release groups (discography / missing albums) and artist relationships.
 * Every call goes through providerFetch: 1 request/second, generic User-Agent, cached.
 */

const log = logger('musicbrainz');
const WEEK = 24 * 7;

export const mbGet = (path: string, params: Record<string, string | number>, ttlHours?: number) =>
  providerFetch('musicbrainz', url(baseUrl('musicbrainz'), path, { ...params, fmt: 'json' }), { ttlHours }).then((r) => r.data);

/* --------------------------- release → tracks --------------------------- */

/** Word-overlap similarity of two titles, 0..1 (ignores case, accents, punctuation). */
export function titleSimilarity(a: string, b: string): number {
  const x = norm(a), y = norm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.85;
  const A = new Set(x.split(' ')), B = new Set(y.split(' '));
  const inter = [...A].filter((w) => B.has(w)).length;
  return inter / new Set([...A, ...B]).size;
}

interface LibTrack { id: string; idx: number | null; parent_idx: number | null; duration_ms: number | null; title: string; external_ids: string; provider_meta: string | null; extra: string }

/**
 * Fill recording / release-track MBIDs (and MusicBrainz artist credits) of an album's tracks from its release's
 * tracklist: matched by disc + track number when the duration (±3 s) or title agrees, else by title + duration.
 * Ids already in the tags are kept. Returns how many tracks changed.
 */
export function fillRecordingsFromRelease(albumId: string, release: any): number {
  const media: any[] = release?.media ?? [];
  if (!media.length) return 0;
  const remote = media.flatMap((m: any) => (m.tracks ?? []).map((t: any) => ({
    disc: Number(m.position) || 1, pos: Number(t.position) || Number(t.number) || 0, title: String(t.title ?? t.recording?.title ?? ''),
    lengthMs: Number(t.length ?? t.recording?.length) || null, recording: t.recording?.id ?? null, releaseTrack: t.id ?? null,
    credit: t['artist-credit'] ?? t.recording?.['artist-credit'] ?? null,
  })));
  const tracks = db.all<LibTrack>("SELECT id, idx, parent_idx, duration_ms, title, external_ids, provider_meta, extra FROM items WHERE parent_id = ? AND type = 'track'", albumId);
  const durOk = (a: number | null, b: number | null) => !a || !b || Math.abs(a - b) <= 3000;
  const used = new Set<number>();
  const changed: string[] = [];
  for (const t of tracks) {
    let k = remote.findIndex((r, i) => !used.has(i) && r.disc === (t.parent_idx ?? 1) && r.pos === t.idx && (durOk(r.lengthMs, t.duration_ms) && (!!(r.lengthMs && t.duration_ms) || titleSimilarity(r.title, t.title) >= 0.5)));
    if (k < 0) {
      let best = -1, bestScore = 0;
      remote.forEach((r, i) => {
        if (used.has(i) || !durOk(r.lengthMs, t.duration_ms)) return;
        const s = titleSimilarity(r.title, t.title);
        if (s > bestScore) { best = i; bestScore = s; }
      });
      if (bestScore >= 0.75) k = best;
    }
    if (k < 0) continue;
    used.add(k);
    const r = remote[k];
    const ids = parseJson<Record<string, string>>(t.external_ids, {});
    const next = { ...ids };
    if (!next.musicbrainzRecording && isMbid(r.recording)) next.musicbrainzRecording = r.recording;
    if (!next.musicbrainzReleaseTrack && isMbid(r.releaseTrack)) next.musicbrainzReleaseTrack = r.releaseTrack;
    const pm = parseJson<Record<string, unknown>>(t.provider_meta, {});
    const credits = creditsFromMb(r.credit);
    const patch: Row = {};
    if (JSON.stringify(next) !== JSON.stringify(ids)) patch.external_ids = JSON.stringify(next);
    if (credits?.length && JSON.stringify(pm.credits) !== JSON.stringify(credits)) patch.provider_meta = JSON.stringify({ ...pm, credits });
    if (Object.keys(patch).length) {
      db.update('items', t.id, patch);
      changed.push(t.id);
    }
  }
  if (changed.length) {
    const lib = db.get<{ library_id: string }>('SELECT library_id FROM items WHERE id = ?', albumId)?.library_id;
    if (lib) rebuildCredits(lib, changed);
  }
  return changed.length;
}

/** Album-level facts from a release / release group (stored in provider_meta.mb). */
export function releaseFacts(release: any | null, rg: any | null): Record<string, unknown> {
  const g = rg ?? release?.['release-group'] ?? {};
  const types = [g['primary-type'], ...(g['secondary-types'] ?? [])].filter(Boolean).map((x: string) => x.toLowerCase());
  const li = release?.['label-info']?.[0];
  const firstDate = g['first-release-date'] || null;
  const out: Record<string, unknown> = {};
  if (types.length) out.types = types;
  if (release?.status) out.status = String(release.status).toLowerCase();
  if (firstDate) {
    out.firstDate = firstDate;
    out.firstYear = Number(String(firstDate).slice(0, 4)) || null;
  }
  if (li?.label?.name) out.label = li.label.name;
  if (li?.['catalog-number']) out.catalogNumber = li['catalog-number'];
  if (release?.barcode) out.barcode = release.barcode;
  return out;
}

/* ------------------------------ discography ------------------------------ */

export interface ReleaseGroup { id: string; title: string; primaryType: string | null; secondaryTypes: string[]; firstReleaseDate: string | null }

/** An artist's release groups (albums, EPs, singles), official only; up to 500, cached for 7 days. */
export async function releaseGroupsOf(artistMbid: string): Promise<ReleaseGroup[]> {
  const out: ReleaseGroup[] = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const r = await mbGet('/release-group', { artist: artistMbid, type: 'album|ep|single', 'release-group-status': 'website-default', limit: 100, offset }, WEEK);
    const list: any[] = r?.['release-groups'] ?? [];
    for (const g of list) out.push({ id: g.id, title: g.title, primaryType: g['primary-type'] ?? null, secondaryTypes: (g['secondary-types'] ?? []).map((s: string) => s.toLowerCase()), firstReleaseDate: g['first-release-date'] || null });
    const total = Number(r?.['release-group-count'] ?? 0);
    if (!list.length || offset + list.length >= total) break;
  }
  return out;
}

const SECTION_ORDER = ['album', 'ep', 'single', 'live', 'compilation', 'soundtrack', 'remix', 'demo', 'other'];
const SECTION_LABEL: Record<string, string> = {
  album: 'Albums', ep: 'EPs', single: 'Singles', live: 'Live', compilation: 'Compilations', soundtrack: 'Soundtracks', remix: 'Remixes', demo: 'Demos', other: 'Other releases',
};

/** Section of a release from its types: secondary types (live, compilation…) win over the primary one. */
export function sectionOf(types: string[] | null | undefined): string {
  const t = (types ?? []).map((x) => x.toLowerCase());
  for (const s of ['live', 'compilation', 'soundtrack', 'remix', 'demo']) if (t.includes(s)) return s;
  if (t.some((x) => ['dj-mix', 'mixtape', 'spokenword', 'interview', 'audiobook', 'audio drama', 'field recording'].includes(x))) return 'other';
  const p = t[0];
  if (p === 'ep' || p === 'single' || p === 'album') return p;
  if (p === 'other' || p === 'broadcast') return 'other';
  return 'album';
}

/** Group albums into release-type sections, in the usual discography order. */
export function groupDiscography(albums: Item[]): DiscographySection[] {
  const by = new Map<string, Item[]>();
  for (const a of albums) {
    const s = sectionOf(a.music?.releaseTypes);
    by.set(s, [...(by.get(s) ?? []), a]);
  }
  return SECTION_ORDER.filter((s) => by.has(s)).map((s) => ({ type: s, label: SECTION_LABEL[s], items: by.get(s)! }));
}

export function hiddenTypes(): string[] {
  const h = getMusicSettings().missingHide;
  return [h.singles && 'single', h.eps && 'ep', h.compilations && 'compilation', h.live && 'live', h.other && 'other'].filter(Boolean) as string[];
}

/** Release groups not in the library: by release-group MBID, else normalised title (+ year when both are known). */
export function missingFrom(rgs: ReleaseGroup[], owned: { rg: string | null; title: string; year: number | null }[], hide: string[]): ReleaseGroup[] {
  const ids = new Set(owned.map((o) => o.rg).filter(Boolean));
  const hiddenSections = new Set(hide);
  return rgs.filter((g) => {
    if (ids.has(g.id)) return false;
    const y = Number(String(g.firstReleaseDate ?? '').slice(0, 4)) || null;
    if (owned.some((o) => norm(o.title) === norm(g.title) && (!o.year || !y || Math.abs(o.year - y) <= 1))) return false;
    const sec = sectionOf([g.primaryType ?? 'album', ...g.secondaryTypes]);
    if (hiddenSections.has(sec) || (hiddenSections.has('other') && ['soundtrack', 'remix', 'demo'].includes(sec))) return false;
    return true;
  });
}

export async function discography(user: User, artistId: string): Promise<DiscographyResponse> {
  const artist = getItem(user, artistId, false);
  const albums = getChildren(user, artistId, { sort: 'year', order: 'desc', limit: 1000 }).items.filter((i) => i.type === 'album');
  const artistMbid = artist.externalIds.musicbrainzArtist ?? null;
  const hide = hiddenTypes();
  const canRequest = requestLevel(user, 'album') !== 'none' && !!instanceFor('lidarr');
  let missing: MissingRelease[] = [];
  let missingError: string | null = null;
  if (artistMbid && isMbid(artistMbid)) {
    try {
      const rgs = await releaseGroupsOf(artistMbid);
      const owned = albums.map((a) => ({ rg: a.externalIds.musicbrainzReleaseGroup ?? null, title: a.title, year: a.music?.originalYear ?? a.year ?? null }));
      missing = missingFrom(rgs, owned, hide)
        .sort((a, b) => String(b.firstReleaseDate ?? '').localeCompare(String(a.firstReleaseDate ?? '')))
        .map((g) => ({
          releaseGroupMbid: g.id, title: g.title, year: Number(String(g.firstReleaseDate ?? '').slice(0, 4)) || null, primaryType: g.primaryType, secondaryTypes: g.secondaryTypes,
          coverUrl: `${baseUrl('coverart')}/release-group/${g.id}/front-250`,
          requestStatus: db.get<{ status: string }>("SELECT status FROM media_requests WHERE media_type = 'album' AND tmdb_id = ? AND status NOT IN ('declined','failed') ORDER BY requested_at DESC LIMIT 1", g.id)?.status ?? null,
        }));
    } catch (e) {
      missingError = (e as Error).message;
      log.debug(`release groups of ${artistMbid}: ${missingError}`);
    }
  }
  const appearsOn = withCredits(selectItems(user, "i.type = 'track' AND i.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?) AND COALESCE(i.grandparent_id, '') != ?", [artistId, artistId], 'ORDER BY i.year DESC, i.sort_title LIMIT 50'));
  return { artistMbid, sections: groupDiscography(albums), missing, missingError, hiddenTypes: hide, appearsOn, canRequest };
}

/* --------------------------- related artists ---------------------------- */

const years = (r: any) => {
  const b = String(r.begin ?? '').slice(0, 4), e = String(r.end ?? '').slice(0, 4);
  return b || e ? `${b}${e ? `–${e}` : r.ended ? '–' : '–present'}` : '';
};

/** MusicBrainz artist-rels → Members / Member of / Collaborations / Related (names + MBIDs; library links added later). */
export function mapArtistRelations(rels: any[]): Omit<RelatedArtistsResponse, 'similar' | 'error'> {
  const out = { members: [] as RelatedArtist[], memberOf: [] as RelatedArtist[], collaborations: [] as RelatedArtist[], related: [] as RelatedArtist[] };
  const seen = new Set<string>();
  for (const r of rels ?? []) {
    if (r['target-type'] && r['target-type'] !== 'artist') continue;
    const a = r.artist;
    if (!a?.id || !a.name) continue;
    const type = String(r.type ?? '');
    const attrs = (r.attributes ?? []).filter((x: string) => x !== 'original');
    const when = years(r);
    let bucket: keyof typeof out;
    let label: string;
    if (type === 'member of band') {
      bucket = r.direction === 'backward' ? 'members' : 'memberOf';
      label = [attrs.join(', '), when].filter(Boolean).join(' · ');
    } else if (type === 'collaboration') {
      bucket = 'collaborations';
      label = when;
    } else {
      bucket = 'related';
      const t = type === 'is person' ? (r.direction === 'backward' ? 'performs as' : 'real person') : type;
      label = [t, attrs.join(', ')].filter(Boolean).join(' · ');
    }
    const key = `${bucket}:${a.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out[bucket].push({ name: a.name, mbid: a.id, itemId: null, posterUrl: null, detail: label || null });
  }
  return out;
}

/** ListenBrainz labs similar artists (no token). The labs response is a list of {artist_mbid, name, score, …}. */
export async function similarArtists(mbid: string): Promise<RelatedArtist[]> {
  const algorithm = 'session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30';
  const r = await providerFetch('listenbrainzLabs', url(baseUrl('listenbrainzLabs'), '/similar-artists/json', { artist_mbids: mbid, algorithm }), { ttlHours: WEEK });
  const flat: any[] = [];
  const walk = (x: any): void => void (Array.isArray(x) ? x.forEach(walk) : x && typeof x === 'object' ? (x.artist_mbid ? flat.push(x) : Array.isArray(x.data) ? walk(x.data) : null) : null);
  walk(r.data);
  return flat.filter((x) => x.artist_mbid !== mbid && x.name).sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, 20)
    .map((x) => ({ name: String(x.name), mbid: String(x.artist_mbid), itemId: null, posterUrl: null, detail: null }));
}

/** Link related artists to library artists the viewer can see (by MBID, else exact name). */
function linkToLibrary(user: User, list: RelatedArtist[]): RelatedArtist[] {
  if (!list.length) return list;
  const a = accessClause(user);
  return list.map((r) => {
    const row = db.get<{ id: string; poster: string | null }>(
      `SELECT i.id, i.poster FROM items i WHERE i.type = 'artist' AND ${a.sql} AND (json_extract(i.external_ids, '$.musicbrainzArtist') = ? OR i.title = ? COLLATE NOCASE)
       ORDER BY CASE WHEN json_extract(i.external_ids, '$.musicbrainzArtist') = ? THEN 0 ELSE 1 END LIMIT 1`, ...a.params, r.mbid ?? '', r.name, r.mbid ?? '');
    return row ? { ...r, itemId: row.id, posterUrl: imageUrl(row.poster) } : r;
  });
}

export async function relatedArtists(user: User, artistId: string): Promise<RelatedArtistsResponse> {
  const artist = getItem(user, artistId, false);
  const mbid = artist.externalIds.musicbrainzArtist;
  const empty: RelatedArtistsResponse = { members: [], memberOf: [], collaborations: [], related: [], similar: [], error: null };
  if (!mbid || !isMbid(mbid)) return { ...empty, error: 'This artist has no MusicBrainz id yet' };
  let res = empty;
  try {
    const a = await mbGet(`/artist/${encodeURIComponent(mbid)}`, { inc: 'artist-rels' }, WEEK);
    res = { ...empty, ...mapArtistRelations(a?.relations ?? []) };
  } catch (e) {
    res = { ...empty, error: (e as Error).message };
  }
  try {
    res.similar = await similarArtists(mbid);
  } catch (e) {
    log.debug(`similar artists: ${(e as Error).message}`);
  }
  return {
    ...res,
    members: linkToLibrary(user, res.members), memberOf: linkToLibrary(user, res.memberOf), collaborations: linkToLibrary(user, res.collaborations),
    related: linkToLibrary(user, res.related.slice(0, 30)), similar: linkToLibrary(user, res.similar),
  };
}
