import type { ArtistCredit } from '@mediamax/shared';
import { db } from '../../db.js';
import { parseJson } from '../../util/misc.js';
import { parseMbTags, type MbTags } from './tags.js';

/**
 * Multi-artist credits ("A feat. B & C"): an ordered list of credited artists with the join phrase after each one.
 * Sources, best first: the file's ARTISTS / MUSICBRAINZ_ARTISTID tags, MusicBrainz artist-credits (stored in the
 * track's provider_meta.credits when the album's release was looked up), AcoustID identifications, and as a last
 * resort a split of the artist string — only when every part is an existing library artist, so "Simon & Garfunkel"
 * stays one artist.
 */

export interface RawCredit {
  name: string;
  mbid: string | null;
  joinPhrase: string;
}

const SEP_RE = /(\s+(?:feat\.?|ft\.?|featuring|with|vs\.?|x|×|&|and)\s+|\s*,\s+|\s*;\s*)/i;

/** "A feat. B & C" → parts ["A","B","C"] and separators [" feat. "," & "]. */
export function splitArtistString(s: string): { parts: string[]; seps: string[] } {
  const bits = s.split(SEP_RE);
  const parts: string[] = [];
  const seps: string[] = [];
  for (let i = 0; i < bits.length; i++) {
    if (i % 2 === 0) parts.push(bits[i].trim());
    else seps.push(bits[i]);
  }
  return { parts, seps };
}

/** Join phrases for `names` as they appear in the display string; null when a name can't be found in order. */
export function joinPhrasesFrom(display: string, names: string[]): string[] | null {
  const lower = display.toLowerCase();
  const pos: [number, number][] = [];
  let at = 0;
  for (const n of names) {
    const i = lower.indexOf(n.toLowerCase(), at);
    if (i < 0) return null;
    pos.push([i, i + n.length]);
    at = i + n.length;
  }
  if (pos[0][0] !== 0) return null;
  return pos.map(([, end], k) => (k + 1 < pos.length ? display.slice(end, pos[k + 1][0]) : display.slice(end)));
}

const defaultJoins = (n: number) => Array.from({ length: n }, (_, i) => (i === n - 1 ? '' : i === n - 2 ? ' & ' : ', '));

/** Credits from file tags (ARTISTS names + MUSICBRAINZ_ARTISTID ids); null when the tags don't describe several/identified artists. */
export function creditsFromTags(display: string | null, mb: MbTags): RawCredit[] | null {
  const ids = mb.artists;
  let names = mb.artistNames;
  if (!names.length && ids.length === 1 && display) names = [display];
  if (!names.length && ids.length > 1 && display) {
    const sp = splitArtistString(display);
    if (sp.parts.length === ids.length) names = sp.parts;
  }
  if (!names.length) return null;
  const joins = (display && joinPhrasesFrom(display, names)) || defaultJoins(names.length);
  return names.map((name, i) => ({ name, mbid: ids.length === names.length ? ids[i] : names.length === 1 ? ids[0] ?? null : null, joinPhrase: joins[i] ?? '' }));
}

/** MusicBrainz artist-credit array (ws/2 JSON) → credits. */
export function creditsFromMb(ac: any[] | null | undefined): RawCredit[] | null {
  if (!Array.isArray(ac) || !ac.length) return null;
  return ac.map((c) => ({ name: String(c.name ?? c.artist?.name ?? ''), mbid: c.artist?.id ?? null, joinPhrase: String(c.joinphrase ?? '') })).filter((c) => c.name);
}

/**
 * Untagged fallback: split "A & B" only when the whole string isn't itself a known artist and every part is one.
 * `known(name)` answers whether a library artist has exactly that name (case-insensitive).
 */
export function fallbackCredits(display: string, known: (name: string) => boolean): RawCredit[] | null {
  if (!display || known(display)) return null;
  const { parts, seps } = splitArtistString(display);
  if (parts.length < 2 || parts.some((p) => !p || !known(p))) return null;
  return parts.map((name, i) => ({ name, mbid: null, joinPhrase: seps[i] ?? '' }));
}

/** Rebuild track_artists for every track of a library (after a scan; cheap, local only), or just `onlyTracks`. */
export function rebuildCredits(libraryId: string, onlyTracks?: string[]) {
  const artists = db.all<{ id: string; title: string; mb: string | null }>(
    "SELECT id, title, json_extract(external_ids, '$.musicbrainzArtist') mb FROM items WHERE library_id = ? AND type = 'artist'", libraryId);
  const byName = new Map<string, string>();
  const byMb = new Map<string, string>();
  for (const a of artists) {
    if (!byName.has(a.title.toLowerCase())) byName.set(a.title.toLowerCase(), a.id);
    if (a.mb) byMb.set(a.mb, a.id);
  }
  const known = (n: string) => byName.has(n.toLowerCase());
  const only = onlyTracks ? new Set(onlyTracks) : null;
  const tracks = db.all<{ id: string; extra: string; provider_meta: string | null; artist: string | null }>(
    `SELECT t.id, t.extra, t.provider_meta, g.title artist FROM items t LEFT JOIN items g ON g.id = t.grandparent_id WHERE t.library_id = ? AND t.type = 'track'`, libraryId)
    .filter((t) => !only || only.has(t.id));
  db.tx(() => {
    if (only) for (const t of tracks) db.run('DELETE FROM track_artists WHERE track_id = ?', t.id);
    else db.run("DELETE FROM track_artists WHERE track_id IN (SELECT id FROM items WHERE library_id = ? AND type = 'track')", libraryId);
    for (const t of tracks) {
      const credits = trackCredits(t, known);
      credits.forEach((c, i) => {
        const artistId = (c.mbid && byMb.get(c.mbid)) || byName.get(c.name.toLowerCase()) || null;
        db.run('INSERT OR REPLACE INTO track_artists (track_id, position, name, artist_id, mbid, join_phrase) VALUES (?, ?, ?, ?, ?, ?)', t.id, i, c.name.slice(0, 300), artistId, c.mbid, c.joinPhrase.slice(0, 40));
      });
    }
  });
}

/** Credits of one track row (extra + provider_meta + album artist name). */
export function trackCredits(t: { extra: string; provider_meta: string | null; artist: string | null }, known: (n: string) => boolean): RawCredit[] {
  const extra = parseJson<{ tags?: Record<string, string | null>; mbTags?: Record<string, string> }>(t.extra, {});
  const pm = parseJson<{ credits?: RawCredit[]; identified?: { artist?: string } }>(t.provider_meta, {});
  const display = extra.tags?.artist || pm.identified?.artist || t.artist || null;
  const fromTags = creditsFromTags(display, parseMbTags(extra.mbTags ?? {}));
  if (fromTags?.length) return fromTags;
  if (pm.credits?.length) return pm.credits;
  if (display) return fallbackCredits(display, known) ?? [{ name: display, mbid: null, joinPhrase: '' }];
  return [];
}

/** Credits for a set of tracks (one query). */
export function creditsFor(trackIds: string[]): Map<string, ArtistCredit[]> {
  const out = new Map<string, ArtistCredit[]>();
  for (let i = 0; i < trackIds.length; i += 400) {
    const chunk = trackIds.slice(i, i + 400);
    const rows = db.all<{ track_id: string; name: string; artist_id: string | null; mbid: string | null; join_phrase: string }>(
      `SELECT track_id, name, artist_id, mbid, join_phrase FROM track_artists WHERE track_id IN (${chunk.map(() => '?').join(',')}) ORDER BY track_id, position`, ...chunk);
    for (const r of rows) {
      const list = out.get(r.track_id) ?? [];
      list.push({ name: r.name, artistId: r.artist_id, mbid: r.mbid, joinPhrase: r.join_phrase });
      out.set(r.track_id, list);
    }
  }
  return out;
}
