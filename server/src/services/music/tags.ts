import fs from 'node:fs';

/**
 * MusicBrainz tags as written by MusicBrainz Picard (and beets, foobar2000…), read from ffprobe's tag map.
 *
 * Tag names differ per container; ffprobe exposes them as:
 * - Vorbis comments (FLAC, Ogg, Opus): MUSICBRAINZ_TRACKID, MUSICBRAINZ_ALBUMID, … (repeated keys are joined with ";")
 * - ID3 (MP3): TXXX frames by description ("MusicBrainz Album Id", …). ffprobe shows only the first value of a
 *   multi-valued TXXX frame and doesn't show the UFID frame that holds the recording id, so MP3s are also read
 *   directly (readId3Extras) for those two.
 * - MP4 (M4A/ALAC): "----:com.apple.iTunes:MusicBrainz Track Id" freeform atoms, shown as "MusicBrainz Track Id".
 * Keys are compared case-insensitively with spaces, underscores and the iTunes prefix removed.
 */

export interface MbTags {
  recording: string | null;
  releaseTrack: string | null;
  release: string | null;
  releaseGroup: string | null;
  artists: string[];
  albumArtists: string[];
  work: string | null;
  acoustid: string | null;
  /** Primary type first, then secondary types, lower case. */
  releaseTypes: string[];
  releaseStatus: string | null;
  originalDate: string | null;
  originalYear: number | null;
  barcode: string | null;
  catalogNumber: string | null;
  label: string | null;
  /** ARTISTS / ALBUMARTISTS multi-value names. */
  artistNames: string[];
  albumArtistNames: string[];
  compilation: boolean;
  discSubtitle: string | null;
}

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
export const isMbid = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/** All valid UUIDs in a tag value (handles ";", "/", NUL, ", " and repeated-key joins). */
export function mbids(v: string | null | undefined): string[] {
  if (!v) return [];
  return [...new Set((String(v).match(UUID_RE) ?? []).map((x) => x.toLowerCase()))];
}
const one = (v: string | null | undefined): string | null => mbids(v)[0] ?? null;

/** "MusicBrainz Album Id", "MUSICBRAINZ_ALBUMID", "----:com.apple.iTunes:MusicBrainz Album Id" → "musicbrainzalbumid". */
export function normKey(k: string): string {
  const base = k.includes(':') ? k.slice(k.lastIndexOf(':') + 1) : k;
  return base.toLowerCase().replace(/^txxx[:/]?/, '').replace(/[\s_\-.]+/g, '');
}

export function normTags(tags: Record<string, string | undefined | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) {
    if (v === undefined || v === null || v === '') continue;
    const nk = normKey(k);
    // Keep the first spelling seen; repeated keys from different spellings are joined.
    out[nk] = out[nk] && out[nk] !== String(v) ? `${out[nk]};${v}` : String(v);
  }
  return out;
}

/** Split a multi-value name tag. "/" only splits when the MBID count says so (AC/DC stays whole). */
export function splitNames(v: string | null | undefined, expected = 0): string[] {
  if (!v) return [];
  let parts = String(v).split(/\s*[;\u0000]\s*/).map((s) => s.trim()).filter(Boolean);
  if (parts.length === 1 && expected > 1) {
    const slash = parts[0].split(/\s*\/\s*/).map((s) => s.trim()).filter(Boolean);
    if (slash.length === expected) parts = slash;
  }
  return parts;
}

const RELEASE_TYPES = new Set(['album', 'single', 'ep', 'broadcast', 'other', 'compilation', 'soundtrack', 'spokenword', 'interview', 'audiobook', 'audio drama', 'live', 'remix', 'dj-mix', 'mixtape/street', 'mixtape', 'demo', 'field recording']);
export function parseReleaseTypes(v: string | null | undefined): string[] {
  if (!v) return [];
  const out: string[] = [];
  for (const raw of String(v).split(/\s*[;,/\u0000]\s*/)) {
    const t = raw.trim().toLowerCase().replace(/^mixtape\/street$/, 'mixtape');
    if (t && RELEASE_TYPES.has(t) && !out.includes(t)) out.push(t);
  }
  return out;
}

const first = (n: Record<string, string>, ...keys: string[]) => {
  for (const k of keys) if (n[k]) return n[k];
  return null;
};

/** Parse MusicBrainz ids and release facts from (any-case) tags. */
export function parseMbTags(tags: Record<string, string | undefined | null>): MbTags {
  const n = normTags(tags);
  const artists = mbids(first(n, 'musicbrainzartistid'));
  const albumArtists = mbids(first(n, 'musicbrainzalbumartistid', 'musicbrainzreleaseartistid'));
  const od = first(n, 'originaldate', 'originalreleasedate', 'tdor');
  const oy = first(n, 'originalyear', 'tory');
  const originalYear = Number(String(od ?? oy ?? '').slice(0, 4)) || null;
  const types = parseReleaseTypes(first(n, 'releasetype', 'musicbrainzalbumtype', 'musicbrainzreleasetype'));
  const comp = first(n, 'compilation', 'cpil', 'tcmp');
  return {
    recording: one(first(n, 'musicbrainztrackid', 'musicbrainzrecordingid', 'httpmusicbrainzorg', 'ufid')),
    releaseTrack: one(first(n, 'musicbrainzreleasetrackid')),
    release: one(first(n, 'musicbrainzalbumid', 'musicbrainzreleaseid')),
    releaseGroup: one(first(n, 'musicbrainzreleasegroupid')),
    artists,
    albumArtists,
    work: one(first(n, 'musicbrainzworkid')),
    acoustid: one(first(n, 'acoustidid')),
    releaseTypes: types,
    releaseStatus: (first(n, 'releasestatus', 'musicbrainzalbumstatus') ?? '').toLowerCase().split(/[;/]/)[0].trim() || null,
    originalDate: od && /^\d{4}(-\d{2}(-\d{2})?)?/.test(od) ? od.slice(0, 10) : null,
    originalYear,
    barcode: first(n, 'barcode', 'upc', 'ean')?.split(/[;/]/)[0].trim() || null,
    catalogNumber: first(n, 'catalognumber', 'catalog', 'catalognum')?.split(/[;]/)[0].trim() || null,
    label: first(n, 'label', 'organization', 'publisher')?.split(/[;]/)[0].trim() || null,
    artistNames: splitNames(first(n, 'artists'), artists.length),
    albumArtistNames: splitNames(first(n, 'albumartists'), albumArtists.length),
    compilation: comp === '1' || /^true$/i.test(comp ?? '') || types.includes('compilation'),
    discSubtitle: first(n, 'discsubtitle', 'setsubtitle', 'tsst'),
  };
}

/* ------------------------------ raw ID3v2 ------------------------------ */

/**
 * Minimal ID3v2.3/2.4 reader for what ffprobe drops: the UFID "http://musicbrainz.org" frame (recording id) and
 * every value of multi-valued TXXX frames. Reads at most the tag (capped at 1 MiB). Never throws.
 *
 * Asynchronous on purpose: music libraries often live on another PC's share (\PC\Music). A synchronous read there
 * blocks the whole server — every request, stream and the health check — for as long as Windows waits for the
 * share (up to a minute when that PC is busy or waking up).
 */
export async function readId3Extras(file: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  let fh: fs.promises.FileHandle | null = null;
  try {
    fh = await fs.promises.open(file, 'r');
    const head = Buffer.alloc(10);
    if ((await fh.read(head, 0, 10, 0)).bytesRead < 10 || head.toString('latin1', 0, 3) !== 'ID3') return out;
    const ver = head[3];
    if (ver !== 3 && ver !== 4) return out;
    const size = ((head[6] & 0x7f) << 21) | ((head[7] & 0x7f) << 14) | ((head[8] & 0x7f) << 7) | (head[9] & 0x7f);
    const len = Math.min(size, 1 << 20);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, 10);
    let pos = 0;
    if (head[5] & 0x40) {
      // Extended header: skip it.
      const ext = ver === 4 ? ((buf[0] & 0x7f) << 21) | ((buf[1] & 0x7f) << 14) | ((buf[2] & 0x7f) << 7) | (buf[3] & 0x7f) : buf.readUInt32BE(0) + 4;
      pos = ext;
    }
    while (pos + 10 <= len) {
      const id = buf.toString('latin1', pos, pos + 4);
      if (!/^[A-Z0-9]{4}$/.test(id)) break;
      const fsz = ver === 4 ? ((buf[pos + 4] & 0x7f) << 21) | ((buf[pos + 5] & 0x7f) << 14) | ((buf[pos + 6] & 0x7f) << 7) | (buf[pos + 7] & 0x7f) : buf.readUInt32BE(pos + 4);
      const body = buf.subarray(pos + 10, Math.min(len, pos + 10 + fsz));
      pos += 10 + fsz;
      if (id === 'UFID') {
        const z = body.indexOf(0);
        if (z > 0 && body.toString('latin1', 0, z) === 'http://musicbrainz.org') out['ufid'] = body.toString('latin1', z + 1).replace(/\0+$/, '');
      } else if (id === 'TXXX' && body.length > 1) {
        const parts = decodeText(body.subarray(1), body[0]).split('\u0000');
        const desc = parts.shift() ?? '';
        const vals = parts.filter(Boolean);
        if (desc && vals.length) out[desc] = vals.join(';');
      }
    }
  } catch {
    /* unreadable: no extras */
  } finally {
    await fh?.close().catch(() => {});
  }
  return out;
}

function decodeText(b: Buffer, enc: number): string {
  if (enc === 0) return b.toString('latin1');
  if (enc === 3) return b.toString('utf8');
  // UTF-16 (with BOM) / UTF-16BE: decode per value so BOMs inside multi-value frames are handled.
  let s = '';
  let le = enc === 1;
  for (let i = 0; i + 1 < b.length; i += 2) {
    if (enc === 1 && b[i] === 0xff && b[i + 1] === 0xfe) { le = true; continue; }
    if (enc === 1 && b[i] === 0xfe && b[i + 1] === 0xff) { le = false; continue; }
    s += String.fromCharCode(le ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1]);
  }
  return s;
}

/** ffprobe tags + the raw ID3 extras for MP3s (extras win: they carry every value). */
export async function tagsWithId3(file: string, tags: Record<string, string>): Promise<Record<string, string>> {
  if (!/\.mp3$/i.test(file)) return tags;
  const extra = await readId3Extras(file);
  return Object.keys(extra).length ? { ...tags, ...extra } : tags;
}

/** The MusicBrainz-related subset of a file's tags, kept in the item's extra JSON so unchanged files needn't be re-probed. */
export function mbTagSubset(tags: Record<string, string>): Record<string, string> {
  const keep = /^(musicbrainz|acoustidid|releasetype|releasestatus|originaldate|originalyear|originalreleasedate|barcode|upc|catalognumber|label|publisher|organization|artists|albumartists|compilation|discsubtitle|setsubtitle|ufid|tdor|tory|tsst|httpmusicbrainzorg)/;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tags)) if (keep.test(normKey(k)) && v) out[k] = String(v).slice(0, 2000);
  return out;
}
