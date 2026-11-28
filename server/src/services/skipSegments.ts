import type { Marker, ParentalGuide, ParentalSeverity, SubmitMarkerRequest, SubmitMarkerResponse } from '@mediamax/shared';
import { db, type Row } from '../db.js';
import { badRequest, forbidden, notFound } from '../util/errors.js';
import { parseJson } from '../util/misc.js';
import { logger } from '../util/log.js';
import { getSettings } from './settings.js';
import { baseUrl, providerFetch, ProviderError } from './metadata/http.js';

const log = logger('skip-segments');

/**
 * Crowdsourced skip segments and the parental guide.
 *
 *  - IntroDB (api.introdb.app): intro / recap / outro by IMDb id (+ season / episode for TV); outro = end credits.
 *  - AniSkip (api.aniskip.com/v2): anime openings / endings / recaps by MyAnimeList id + episode number. Only for
 *    titles that carry a MAL id (NFO `<uniqueid type="mal">`); a show-level id is trusted for season 1 only, since MAL
 *    lists every season as its own entry.
 *
 * Both are off until the admin turns them on (Admin → Playback). The server makes the requests (only public title ids
 * are sent) and caches the answers (providerFetch: 7 days, misses 1 day). Local markers (audio fingerprint, chapters,
 * EDL, an admin's own timestamps) always win; crowd segments only fill the types the file has no marker for.
 */

type SegmentType = 'intro' | 'recap' | 'credits';

interface Ids {
  imdb: string | null;
  mal: string | null;
  isMovie: boolean;
  season: number | null;
  episode: number | null;
  durationSec: number;
}

const IMDB = /^tt\d{7,9}$/;

function idsFor(row: Row): Ids {
  const own = parseJson<Record<string, string>>(row.external_ids, {});
  const isMovie = row.type === 'movie';
  let imdb = own.imdb ?? null;
  let mal = own.mal ?? null;
  if (row.type === 'episode') {
    const season = row.parent_id ? db.get<Row>('SELECT external_ids, idx FROM items WHERE id = ?', row.parent_id) : null;
    const show = row.grandparent_id ? db.get<Row>('SELECT external_ids FROM items WHERE id = ?', row.grandparent_id) : null;
    const seasonIds = parseJson<Record<string, string>>(season?.external_ids, {});
    const showIds = parseJson<Record<string, string>>(show?.external_ids, {});
    // IntroDB keys TV by the series' IMDb id; an episode's own IMDb id is not what it expects.
    imdb = showIds.imdb ?? null;
    mal = seasonIds.mal ?? (row.parent_idx === 1 ? showIds.mal ?? null : null);
  }
  return {
    imdb: imdb && IMDB.test(imdb) ? imdb : null,
    mal: mal && /^\d{1,9}$/.test(mal) ? mal : null,
    isMovie,
    season: row.parent_idx ?? null,
    episode: row.idx ?? null,
    durationSec: Math.round((row.duration_ms ?? 0) / 1000),
  };
}

interface IntroDbSegment {
  start_ms?: number;
  end_ms?: number;
  start_sec?: number;
  end_sec?: number;
}

const segMs = (s: IntroDbSegment | null | undefined): [number, number] | null => {
  if (!s) return null;
  const a = s.start_ms ?? (s.start_sec != null ? s.start_sec * 1000 : NaN);
  const b = s.end_ms ?? (s.end_sec != null ? s.end_sec * 1000 : NaN);
  return Number.isFinite(a) && Number.isFinite(b) && b > a ? [Math.round(a), Math.round(b)] : null;
};

async function fromIntroDb(ids: Ids): Promise<Marker[]> {
  if (!ids.imdb) return [];
  if (!ids.isMovie && (ids.season == null || ids.episode == null || ids.season < 1 || ids.episode < 1)) return [];
  const q = ids.isMovie ? `imdb_id=${ids.imdb}&is_movie=true` : `imdb_id=${ids.imdb}&season=${ids.season}&episode=${ids.episode}`;
  const r = await providerFetch<Record<string, IntroDbSegment | null>>('introdb', `${baseUrl('introdb')}/segments?${q}`, { timeoutMs: 6000 });
  const d = r.data;
  if (!d) return [];
  const out: Marker[] = [];
  for (const [key, type] of [['intro', 'intro'], ['recap', 'recap'], ['outro', 'credits']] as const) {
    const ms = segMs(d[key]);
    if (ms) out.push({ type, startMs: ms[0], endMs: ms[1], source: 'introdb' });
  }
  return out;
}

const ANISKIP_TYPES: Record<string, SegmentType> = { op: 'intro', 'mixed-op': 'intro', ed: 'credits', 'mixed-ed': 'credits', recap: 'recap' };

async function fromAniSkip(ids: Ids): Promise<Marker[]> {
  const ep = ids.isMovie ? 1 : ids.episode;
  if (!ids.mal || ep == null || ep < 0) return [];
  const types = Object.keys(ANISKIP_TYPES).map((t) => `types=${t}`).join('&');
  const url = `${baseUrl('aniskip')}/skip-times/${ids.mal}/${ep}?${types}&episodeLength=${ids.durationSec || 0}`;
  const r = await providerFetch<{ found?: boolean; results?: { interval?: { startTime?: number; endTime?: number }; skipType?: string }[] }>('aniskip', url, { timeoutMs: 6000 });
  if (!r.data?.found) return [];
  const out: Marker[] = [];
  for (const x of r.data.results ?? []) {
    const type = ANISKIP_TYPES[x.skipType ?? ''];
    const a = Number(x.interval?.startTime);
    const b = Number(x.interval?.endTime);
    if (!type || !Number.isFinite(a) || !Number.isFinite(b) || b <= a) continue;
    if (!out.some((m) => m.type === type)) out.push({ type, startMs: Math.round(a * 1000), endMs: Math.round(b * 1000), source: 'aniskip' });
  }
  return out;
}

/** Crowd segments merged under the local ones: one marker per type, local first, then IntroDB, then AniSkip. */
export function mergeMarkers(local: Marker[], ...crowd: Marker[][]): Marker[] {
  const out = [...local];
  for (const list of crowd) {
    for (const m of list) if (!out.some((o) => o.type === m.type)) out.push(m);
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** The item's markers with crowd segments filled in (when the admin enabled a source). Never throws. */
export async function markersWithCrowd(itemId: string, local: Marker[]): Promise<Marker[]> {
  const cfg = getSettings().skipSegments;
  if (!cfg?.introDb && !cfg?.aniSkip) return local;
  const row = db.get<Row>("SELECT i.id, i.type, i.external_ids, i.parent_id, i.grandparent_id, i.idx, i.parent_idx, (SELECT MAX(duration_ms) FROM media WHERE item_id = i.id) AS duration_ms FROM items i WHERE i.id = ?", itemId);
  if (!row || (row.type !== 'movie' && row.type !== 'episode')) return local;
  const ids = idsFor(row);
  const safe = (p: Promise<Marker[]>, name: string) => p.catch((e) => (log.debug(`${name}: ${(e as Error).message}`), [] as Marker[]));
  const [introDb, aniSkip] = await Promise.all([
    cfg.introDb ? safe(fromIntroDb(ids), 'IntroDB') : Promise.resolve([]),
    cfg.aniSkip ? safe(fromAniSkip(ids), 'AniSkip') : Promise.resolve([]),
  ]);
  return mergeMarkers(local, introDb, aniSkip);
}

/**
 * Playback start: crowd segments when they arrive within `waitMs` (cached answers are instant). A slow first lookup
 * keeps running and fills the cache for the next play; playback is never held up longer than that.
 */
export function markersForPlayback(itemId: string, local: Marker[], waitMs = 1200): Promise<Marker[]> {
  const cfg = getSettings().skipSegments;
  if (!cfg?.introDb && !cfg?.aniSkip) return Promise.resolve(local);
  return Promise.race([markersWithCrowd(itemId, local), new Promise<Marker[]>((r) => setTimeout(() => r(local), waitMs).unref?.())]);
}

/* ------------------------------ submissions -------------------------------- */

/** Lengths IntroDB accepts (seconds); also a sanity check for our own copy. */
const LIMITS: Record<SegmentType, [number, number]> = { intro: [5, 300], recap: [5, 480], credits: [5, 900] };

/**
 * An admin's own timestamps for a segment: replaces that type's marker for everyone, and optionally goes to IntroDB
 * with the server's key. Viewers can't change shared markers (same rule as editing metadata).
 */
export async function submitMarker(user: { isAdmin: boolean }, itemId: string, req: SubmitMarkerRequest): Promise<SubmitMarkerResponse> {
  if (!user.isAdmin) throw forbidden('Only an admin can save segment timestamps for everyone');
  if (!req || !['intro', 'recap', 'credits'].includes(req.type)) throw badRequest('type must be intro, recap or credits');
  const startMs = Math.round(Number(req.startMs));
  const endMs = Math.round(Number(req.endMs));
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) throw badRequest('startMs and endMs must be times with endMs after startMs');
  const [lo, hi] = LIMITS[req.type];
  const len = (endMs - startMs) / 1000;
  if (len < lo || len > hi) throw badRequest(`A ${req.type} must last between ${lo} and ${hi} seconds`);
  const row = db.get<Row>("SELECT i.id, i.type, i.markers, i.external_ids, i.parent_id, i.grandparent_id, i.idx, i.parent_idx, (SELECT MAX(duration_ms) FROM media WHERE item_id = i.id) AS duration_ms FROM items i WHERE i.id = ?", itemId);
  if (!row) throw notFound('Item not found');
  if (row.type !== 'movie' && row.type !== 'episode') throw badRequest('Segments can only be saved for movies and episodes');
  if (row.duration_ms && endMs > row.duration_ms + 1000) throw badRequest('The segment ends after the end of the video');
  const markers = parseJson<Marker[]>(row.markers, []).filter((m) => m.type !== req.type);
  markers.push({ type: req.type, startMs, endMs, source: 'user' });
  markers.sort((a, b) => a.startMs - b.startMs);
  db.run('UPDATE items SET markers = ? WHERE id = ?', JSON.stringify(markers), itemId);
  let upstream: SubmitMarkerResponse['upstream'] = null;
  if (req.upstream) upstream = await sendToIntroDb(idsFor(row), req.type, startMs, endMs);
  return { markers, upstream };
}

async function sendToIntroDb(ids: Ids, type: SegmentType, startMs: number, endMs: number): Promise<{ sent: boolean; message: string | null }> {
  const key = getSettings().skipSegments?.introDbApiKey;
  if (!key) return { sent: false, message: 'No IntroDB API key is set (Admin → Playback)' };
  if (!ids.imdb) return { sent: false, message: 'This title has no IMDb id, which IntroDB needs' };
  if (!ids.isMovie && (ids.season == null || ids.episode == null)) return { sent: false, message: 'This episode has no season or episode number' };
  const body = {
    imdb_id: ids.imdb,
    segment_type: type === 'credits' ? 'outro' : type,
    start_sec: startMs / 1000,
    end_sec: endMs / 1000,
    ...(ids.isMovie ? { is_movie: true } : { season: ids.season, episode: ids.episode }),
  };
  try {
    await providerFetch('introdb', `${baseUrl('introdb')}/submit`, { service: 'introdb-submit', method: 'POST', body, headers: { 'X-API-Key': key }, ttlHours: 0, timeoutMs: 10000 });
    return { sent: true, message: null };
  } catch (e) {
    const status = e instanceof ProviderError ? e.status : null;
    const message = status === 401 ? 'IntroDB refused the API key' : status === 429 ? 'IntroDB: too many submissions this hour' : status === 400 ? 'IntroDB rejected these timestamps' : 'IntroDB could not be reached';
    return { sent: false, message };
  }
}

/* ------------------------------ parental guide ------------------------------ */

const GUIDE_CATEGORIES: Record<string, ParentalGuide['categories'][number]['category']> = {
  SEXUAL_CONTENT: 'nudity', NUDITY: 'nudity', VIOLENCE: 'violence', PROFANITY: 'profanity', ALCOHOL_DRUGS: 'alcohol', FRIGHTENING_INTENSE_SCENES: 'frightening',
};
const SEVERITIES: ParentalSeverity[] = ['none', 'mild', 'moderate', 'severe'];

/** The most-voted severity of a category ("none" only wins when it out-votes every real level). */
export function dominantSeverity(breakdowns: { severityLevel?: string; voteCount?: number }[] | null | undefined): ParentalSeverity | null {
  let best: { level: ParentalSeverity; votes: number } | null = null;
  let none = 0;
  for (const b of breakdowns ?? []) {
    const level = String(b.severityLevel ?? '').toLowerCase() as ParentalSeverity;
    const votes = Number(b.voteCount) || 0;
    if (!SEVERITIES.includes(level)) continue;
    if (level === 'none') none = votes;
    else if (!best || votes > best.votes) best = { level, votes };
  }
  if (!best) return none > 0 ? 'none' : null;
  return none > best.votes ? 'none' : best.level;
}

/** The parental guide card: content rating always, severities when the admin configured a guide source. */
export async function parentalGuide(itemId: string): Promise<ParentalGuide> {
  const row = db.get<Row>('SELECT id, type, content_rating, external_ids, grandparent_id, parent_id FROM items WHERE id = ?', itemId);
  if (!row) throw notFound('Item not found');
  let rating: string | null = row.content_rating ?? null;
  let ids = parseJson<Record<string, string>>(row.external_ids, {});
  if (row.type === 'episode' && row.grandparent_id) {
    const show = db.get<Row>('SELECT content_rating, external_ids FROM items WHERE id = ?', row.grandparent_id);
    rating ??= show?.content_rating ?? null;
    ids = parseJson<Record<string, string>>(show?.external_ids, {});
  }
  const out: ParentalGuide = { contentRating: rating, categories: [] };
  const template = getSettings().skipSegments?.parentalGuideUrl;
  if (!template || !ids.imdb || !IMDB.test(ids.imdb)) return out;
  try {
    const r = await providerFetch<{ parentsGuide?: { category?: string; severityBreakdowns?: { severityLevel?: string; voteCount?: number }[] }[] }>(
      'parentalGuide', template.replace('{imdb}', encodeURIComponent(ids.imdb)), { timeoutMs: 6000 },
    );
    for (const c of r.data?.parentsGuide ?? []) {
      const category = GUIDE_CATEGORIES[String(c.category ?? '').toUpperCase()];
      const severity = dominantSeverity(c.severityBreakdowns);
      if (category && severity && !out.categories.some((x) => x.category === category)) out.categories.push({ category, severity });
    }
  } catch (e) {
    // An unreachable guide source just means no severities on the card.
    log.debug(`Parental guide: ${(e as Error).message}`);
  }
  return out;
}
