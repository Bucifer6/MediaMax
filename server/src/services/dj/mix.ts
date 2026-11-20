import type { DjEnergyCurve, DjMix, DjMixRequest, DjMixTrack, DjTransition, TrackAnalysis, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { accessClause, getItem } from '../items.js';
import { badRequest, notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { getAnalyses } from './analysis.js';
import { keyCompatibility } from './dsp.js';

interface Cand {
  id: string;
  artistId: string | null;
  albumId: string | null;
  genres: string[];
  durationMs: number;
  favorite: boolean;
  rating: number | null;
  a: TrackAnalysis | null;
}

const CURVES: DjEnergyCurve[] = ['steady', 'build', 'peak', 'wave', 'chill'];

/** Target energy *percentile* (0–1) at position p (0–1) through the mix. */
export function curveTarget(curve: DjEnergyCurve, p: number, seedPct: number): number {
  switch (curve) {
    case 'build': return 0.25 + 0.65 * p;
    case 'peak': return p < 0.7 ? 0.35 + 0.6 * (p / 0.7) : 0.95 - 0.4 * ((p - 0.7) / 0.3);
    case 'wave': return 0.55 + 0.3 * Math.sin(2 * Math.PI * 2 * p);
    case 'chill': return 0.2;
    default: return seedPct;
  }
}

/** Tempo distance as a fraction, allowing half/double time (a 70 BPM track mixes with a 140 BPM one). */
export function tempoDistance(a: number | null, b: number | null): { d: number; ratio: number } | null {
  if (!a || !b) return null;
  let best = { d: Infinity, ratio: 1 };
  for (const m of [1, 2, 0.5]) {
    const d = Math.abs(b * m - a) / a;
    if (d < best.d) best = { d, ratio: a / (b * m) };
  }
  return best;
}

/** How to get from track A into track B. */
export function planTransition(a: TrackAnalysis | null, aDur: number, b: TrackAnalysis | null): DjTransition {
  const keyMatch = keyCompatibility(a?.camelot ?? null, b?.camelot ?? null);
  const tempo = tempoDistance(a?.bpm ?? null, b?.bpm ?? null);
  if (!a || !b) {
    // Unanalysed: a plain fade over the last few seconds.
    const cueOut = a?.cueOutMs ?? aDur;
    return { mixOutMs: Math.max(0, cueOut - 6000), mixInMs: b?.cueInMs ?? 0, crossfadeMs: 6000, tempoRatio: 1, style: 'fade', keyMatch, bpmDelta: null };
  }
  const bpmDelta = tempo ? Math.round(tempo.d * 1000) / 10 : null;
  const beatable = !!tempo && tempo.d <= 0.08 && (a.bpmConfidence ?? 0) >= 0.35 && (b.bpmConfidence ?? 0) >= 0.35;
  const clash = keyMatch === 'clash';
  let style: DjTransition['style'] = beatable && !clash ? 'blend' : clash && (!tempo || tempo.d > 0.08) ? 'cut' : 'fade';
  const beatMs = a.bpm ? 60000 / a.bpm : 500;
  let crossfade: number;
  if (style === 'blend') {
    // 16 or 32 beats, shaped by how long the outro/intro are.
    const outroLen = a.outroStartMs != null ? a.cueOutMs - a.outroStartMs : 0;
    const introLen = b.introEndMs != null ? b.introEndMs - b.cueInMs : 0;
    const room = Math.max(outroLen, introLen);
    crossfade = (room >= beatMs * 30 ? 32 : 16) * beatMs;
    crossfade = Math.min(Math.max(crossfade, 6000), 20000);
  } else if (style === 'fade') crossfade = 5000;
  else crossfade = 1500;
  // Mix out where the outro starts, but always early enough to finish the fade before the audio ends.
  let mixOut = Math.min(a.outroStartMs ?? Infinity, a.cueOutMs - crossfade);
  mixOut = Math.max(a.cueInMs + Math.min(30000, a.durationMs / 3), mixOut);
  if (mixOut + crossfade > a.cueOutMs) crossfade = Math.max(1000, a.cueOutMs - mixOut);
  let mixIn = b.cueInMs;
  if (style === 'blend' && a.bpm && b.bpm && a.beatOffsetMs != null && b.beatOffsetMs != null) {
    // Snap the mix-out to a bar (4 beats) of A's grid and the mix-in to the first beat of B at/after its cue-in.
    const barA = beatMs * 4;
    mixOut = a.beatOffsetMs + Math.floor((mixOut - a.beatOffsetMs) / barA) * barA;
    const beatB = 60000 / b.bpm;
    mixIn = b.beatOffsetMs + Math.ceil((b.cueInMs - b.beatOffsetMs) / beatB) * beatB;
    if (mixIn < 0) mixIn += beatB;
  } else if (style === 'blend') style = 'fade';
  const tempoRatio = style === 'blend' && tempo ? Math.round(tempo.ratio * 1000) / 1000 : 1;
  return { mixOutMs: Math.round(Math.max(0, mixOut)), mixInMs: Math.round(Math.max(0, mixIn)), crossfadeMs: Math.round(crossfade), tempoRatio, style, keyMatch, bpmDelta };
}

const lc = (s: string) => s.toLowerCase();

function loadCandidates(user: User, req: DjMixRequest): Cand[] {
  const acc = accessClause(user, 'i');
  const where = [acc.sql, "i.type = 'track'", 'EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id)'];
  const params: Param[] = [...acc.params];
  if (req.libraryId) {
    where.push('i.library_id = ?');
    params.push(req.libraryId);
  }
  const rows = db.all(
    `SELECT i.id, i.grandparent_id artist_id, i.parent_id album_id, i.genres, i.duration_ms, al.genres album_genres, ud.favorite, ud.rating
     FROM items i LEFT JOIN items al ON al.id = i.parent_id LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${where.join(' AND ')} LIMIT 50000`, user.id, ...params);
  const analyses = getAnalyses(rows.map((r) => r.id));
  const wantGenres = (req.genres ?? []).map(lc);
  return rows
    .map((r) => ({
      id: r.id, artistId: r.artist_id, albumId: r.album_id,
      // A track's own genre tags win; the album's genres are only a fallback for untagged tracks.
      genres: [...new Set((parseJson<string[]>(r.genres, []).length ? parseJson<string[]>(r.genres, []) : parseJson<string[]>(r.album_genres, [])).map(lc))],
      durationMs: r.duration_ms ?? 0, favorite: !!r.favorite, rating: r.rating ?? null, a: analyses.get(r.id) ?? null,
    }))
    .filter((c) => !wantGenres.length || c.genres.some((g) => wantGenres.includes(g)))
    .filter((c) => {
      if (req.bpmMin == null && req.bpmMax == null) return true;
      const b = c.a?.bpm;
      if (!b) return false;
      // Half/double time counts as in range.
      return [b, b * 2, b / 2].some((x) => (req.bpmMin == null || x >= req.bpmMin) && (req.bpmMax == null || x <= req.bpmMax));
    });
}

/** Resolve the seed into a starting track and a "flavour" (genres) for the mix. */
function resolveSeed(user: User, req: DjMixRequest, cands: Cand[], byId: Map<string, Cand>): { start: Cand | null; genres: Set<string> } {
  const genres = new Set((req.genres ?? []).map(lc));
  const history = req.history ?? [];
  const last = history.length ? byId.get(history[history.length - 1]) ?? null : null;
  if (last) {
    last.genres.forEach((g) => genres.add(g));
    return { start: null, genres };
  }
  if (!req.seedItemId) {
    const pool = cands.filter((c) => c.favorite || (c.rating ?? 0) >= 8);
    const from = pool.length ? pool : cands;
    return { start: from[Math.floor(Math.random() * from.length)] ?? null, genres };
  }
  const seed = db.get<{ id: string; type: string }>('SELECT id, type FROM items WHERE id = ?', req.seedItemId);
  if (!seed) throw notFound('Seed item not found');
  getItem(user, seed.id, false); // access check
  let pool: Cand[] = [];
  if (seed.type === 'track') pool = cands.filter((c) => c.id === seed.id);
  else if (seed.type === 'album') pool = cands.filter((c) => c.albumId === seed.id);
  else if (seed.type === 'artist') pool = cands.filter((c) => c.artistId === seed.id);
  else if (seed.type === 'playlist' || seed.type === 'collection') {
    const ids = new Set(db.all<{ item_id: string }>('SELECT item_id FROM collection_items WHERE collection_id = ?', seed.id).map((r) => r.item_id));
    pool = cands.filter((c) => ids.has(c.id));
  } else throw badRequest('Seed must be a track, album, artist or playlist');
  if (!pool.length) throw badRequest('No playable tracks for that seed');
  for (const c of pool) c.genres.forEach((g) => genres.add(g));
  const start = pool.find((c) => c.id === seed.id) ?? pool.slice().sort((x, y) => Number(y.favorite) - Number(x.favorite) || (y.rating ?? 0) - (x.rating ?? 0))[0];
  return { start, genres };
}

function percentile(sorted: number[], q: number) {
  if (!sorted.length) return 0.5;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))];
}

/** Build an ordered DJ mix (or the next `count` tracks of a continuous mix). */
export function buildMix(user: User, req: DjMixRequest): DjMix {
  const curve: DjEnergyCurve = CURVES.includes(req.curve as DjEnergyCurve) ? (req.curve as DjEnergyCurve) : 'steady';
  const harmonic = req.harmonic !== false;
  const artistGap = Math.max(0, Math.min(20, req.artistGap ?? 3));
  const cands = loadCandidates(user, req);
  if (!cands.length) throw badRequest('No music matches those filters');
  const byId = new Map(cands.map((c) => [c.id, c]));
  const { start, genres } = resolveSeed(user, req, cands, byId);
  const energies = cands.filter((c) => c.a).map((c) => c.a!.energy).sort((x, y) => x - y);
  const analyzedShare = cands.length ? energies.length / cands.length : 0;

  const history = (req.history ?? []).filter((id) => byId.has(id) || db.get('SELECT 1 FROM items WHERE id = ?', id));
  const used = new Set(history);
  const recentArtists: (string | null)[] = history.slice(-artistGap).map((id) => byId.get(id)?.artistId ?? null);
  let prev: Cand | null = history.length ? byId.get(history[history.length - 1]) ?? null : null;
  const seedEnergy = (start ?? prev)?.a?.energy;
  const seedPct = seedEnergy != null && energies.length ? energies.findIndex((e) => e >= seedEnergy) / energies.length : 0.55;

  const targetMs = (req.durationMin ?? 60) * 60000;
  const maxCount = req.count != null ? Math.max(1, Math.min(100, req.count)) : 200;
  const out: Cand[] = [];
  let total = 0;
  if (start && !used.has(start.id)) {
    out.push(start);
    used.add(start.id);
    recentArtists.push(start.artistId);
    total += start.durationMs;
    prev = start;
  }
  // Continuous mode keeps the curve moving with the history length (≈ 30-track arc).
  const position = () => (req.count != null ? ((history.length + out.length) % 30) / 30 : Math.min(1, total / targetMs));

  while (out.length < maxCount && (req.count != null || total < targetMs)) {
    const target = percentile(energies, curveTarget(curve, position(), seedPct));
    const blocked = new Set(recentArtists.slice(-artistGap).filter(Boolean));
    let pool = cands.filter((c) => !used.has(c.id) && !(c.artistId && blocked.has(c.artistId)));
    if (!pool.length) pool = cands.filter((c) => !used.has(c.id));
    if (!pool.length) break;
    if (pool.length > 4000) {
      // Big libraries: score a genre-weighted random sample.
      const inGenre = pool.filter((c) => c.genres.some((g) => genres.has(g)));
      const sample = (arr: Cand[], n: number) => (arr.length <= n ? arr : Array.from({ length: n }, () => arr[Math.floor(Math.random() * arr.length)]));
      pool = [...new Set([...sample(inGenre, 2500), ...sample(pool, 1500)])];
    }
    let best: Cand | null = null;
    let bestScore = -Infinity;
    for (const c of pool) {
      let s = 0;
      const a = c.a;
      if (prev?.a && a) {
        if (harmonic) {
          const k = keyCompatibility(prev.a.camelot, a.camelot);
          s += 0.3 * (k === 'perfect' ? 1 : k === 'compatible' ? 0.85 : k === 'energy' ? 0.55 : k === 'unknown' ? 0.45 : 0.05);
        }
        const t = tempoDistance(prev.a.bpm, a.bpm);
        s += 0.3 * (t ? Math.exp(-Math.pow(t.d / 0.04, 2)) : 0.35);
      } else s += 0.25;
      s += a ? 0.25 * Math.max(0, 1 - Math.abs(a.energy - target) * 3) : 0.08;
      if (genres.size) {
        const overlap = c.genres.filter((g) => genres.has(g)).length;
        s += 0.15 * (overlap ? Math.min(1, overlap / Math.min(3, c.genres.length || 1)) : 0);
      }
      if (req.preferFavorites !== false) s += (c.favorite ? 0.06 : 0) + ((c.rating ?? 0) / 10) * 0.04;
      if (prev && c.albumId && c.albumId === prev.albumId) s -= 0.1; // variety
      s += Math.random() * 0.04;
      if (s > bestScore) {
        bestScore = s;
        best = c;
      }
    }
    if (!best) break;
    out.push(best);
    used.add(best.id);
    recentArtists.push(best.artistId);
    total += best.durationMs;
    prev = best;
  }

  // Materialise items and transitions.
  const tracks: DjMixTrack[] = [];
  let before: Cand | null = history.length ? byId.get(history[history.length - 1]) ?? null : null;
  let durationMs = 0;
  for (const c of out) {
    let item;
    try {
      item = getItem(user, c.id, false);
    } catch {
      continue;
    }
    const transition = before ? planTransition(before.a, before.durationMs, c.a) : null;
    tracks.push({ item, analysis: c.a, transition });
    durationMs += c.durationMs - (transition ? transition.crossfadeMs + transition.mixInMs : 0);
    before = c;
  }
  return { tracks, durationMs: Math.max(0, durationMs), curve, analyzedShare: Math.round(analyzedShare * 100) / 100 };
}
