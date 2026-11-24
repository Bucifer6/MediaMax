import path from 'node:path';
import type { DjEnergyCurve, DjMix, DjMixRequest, DjOrderRequest, DjOrderSource, DjMixTrack, DjPhraseType, DjTransition, DjTransitionFx, DjTransitionPreference, TrackAnalysis, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { accessClause, allowedLibraryIds, assertCanSee, getItem } from '../items.js';
import { badRequest, notFound } from '../../util/errors.js';
import { parseJson } from '../../util/misc.js';
import { getAnalysis, getMixFeatures, type MixFeatures } from './analysis.js';
import { keyCompatibility, similarity } from './dsp.js';
import { firstDownbeat, phraseAt, phraseMixPoints } from './phrases.js';
export { firstDownbeat };
import { skipStats } from './ai.js';
import { effectiveRules, rulesWhere, type EffectiveRules } from './rules.js';

interface Cand {
  id: string;
  artistId: string | null;
  albumId: string | null;
  genres: string[];
  durationMs: number;
  favorite: boolean;
  rating: number | null;
  year: number | null;
  /** Lean analysis features for scoring (null = not analysed yet). */
  f: MixFeatures | null;
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

export interface PlanOptions {
  /** Transition feel (default auto). */
  preference?: DjTransitionPreference;
  /** Largest tempo change (fraction, default 0.08) used to beat-match. */
  maxStretch?: number;
  /** Genre tags of the two tracks (lower case), for the effect chooser. */
  genresA?: string[];
  genresB?: string[];
}

const DANCE = /house|techno|trance|edm|electro|dance|drum ?(and|&|n) ?bass|dnb|dubstep|garage|breaks|disco|club|hardstyle|progressive/;
const HIPHOP = /hip.?hop|rap|trap|r&b|rnb|grime/;
const ACOUSTIC = /folk|acoustic|classical|jazz|singer|ambient|soundtrack|country|blues/;

/**
 * Pick the mixer effect for a transition (adapted from OpenDJ's automix styles — phrase/EQ bass swap, filter fade,
 * echo-out, plain crossfade — OpenDJ lets the user pick one; here it is chosen per pair). Rules of thumb:
 *  - beat-matched dance music: swap the basslines on a phrase line (two basslines together sound muddy);
 *  - energy falling away, or harmonically awkward but tempo-close: filter the outgoing track out (HPF) so its
 *    harmony and low end leave first;
 *  - tempos too far apart to beat-match (or a key clash): echo the outgoing track out on its beat and drop the
 *    new one in, which hides the change of groove;
 *  - acoustic / no steady beat, or "minimal": a plain crossfade.
 */
export function chooseFx(input: {
  style: DjTransition['style'];
  preference: DjTransitionPreference;
  energyDelta: number;
  tempoGap: number | null;
  maxStretch?: number;
  keyMatch: DjTransition['keyMatch'];
  outPhrase: DjPhraseType | null;
  inPhrase: DjPhraseType | null;
  hasBeat: boolean;
  genres: string[];
}): { fx: DjTransitionFx; reason: string } {
  const { style, preference: pref, energyDelta: dE, tempoGap, keyMatch, outPhrase, inPhrase, hasBeat, genres } = input;
  const maxStretch = input.maxStretch ?? 0.08;
  const g = genres.join(' ');
  const dance = DANCE.test(g);
  const acoustic = !dance && ACOUSTIC.test(g);
  const hiphop = HIPHOP.test(g);
  if (pref === 'minimal') return { fx: 'none', reason: 'Minimal transitions' };
  const farTempo = tempoGap != null && tempoGap > maxStretch;
  if (style === 'cut' || (style === 'fade' && farTempo)) {
    // Can't beat-match: echo the old groove out (needs a beat to time the echo).
    if (hasBeat && pref !== 'smooth' && !acoustic) return { fx: 'echo', reason: farTempo ? 'Tempos too far apart to blend: echo out' : 'Keys clash: echo out' };
    if (pref === 'smooth' && hasBeat) return { fx: 'filter', reason: 'Tempos differ: filter the old track out' };
    return { fx: 'none', reason: 'No common groove: plain crossfade' };
  }
  if (style === 'fade') {
    if (acoustic || !hasBeat) return { fx: 'none', reason: 'No steady beat: gentle crossfade' };
    if (keyMatch === 'clash') return { fx: 'filter', reason: 'Keys clash: high-pass the old track out' };
    return pref === 'energetic' ? { fx: 'echo', reason: 'Energetic: echo out' } : { fx: 'filter', reason: 'Filter fade' };
  }
  // Beat-matched blend.
  if (acoustic) return { fx: dE < -0.15 ? 'filter' : 'none', reason: 'Acoustic: long crossfade' };
  if (pref === 'energetic') {
    if (outPhrase === 'drop' && dE < -0.1) return { fx: 'echo', reason: 'Out of a drop into calmer music: echo out' };
    return { fx: 'bassSwap', reason: 'Energetic: bass swap on the phrase' };
  }
  if (dE < -0.15 || outPhrase === 'breakdown') return { fx: 'filter', reason: 'Energy falls: filter fade' };
  if (pref === 'smooth' && !dance && !hiphop) return { fx: 'filter', reason: 'Smooth: filter fade' };
  if (dE > 0.15) return { fx: 'bassSwap', reason: 'Energy rises: bass swap on the phrase' };
  if (inPhrase === 'drop' || inPhrase === 'buildup') return { fx: 'bassSwap', reason: 'Into a drop: bass swap on the phrase' };
  return { fx: 'bassSwap', reason: 'Bass swap on the phrase' };
}

const snapBars = (bars: number) => (bars >= 30 ? 32 : bars >= 14 ? 16 : bars >= 7 ? 8 : 4);

/** How to get from track A into track B: mix points on phrases (falling back to bars), length, tempo and effect. */
export function planTransition(a: TrackAnalysis | null, aDur: number, b: TrackAnalysis | null, opts: PlanOptions = {}): DjTransition {
  const pref: DjTransitionPreference = opts.preference ?? 'auto';
  const maxStretch = Math.max(0.01, Math.min(0.16, opts.maxStretch ?? 0.08));
  const keyMatch = keyCompatibility(a?.camelot ?? null, b?.camelot ?? null);
  const tempo = tempoDistance(a?.bpm ?? null, b?.bpm ?? null);
  if (!a || !b) {
    // Unanalysed: a plain fade over the last few seconds.
    const len = pref === 'minimal' ? 4000 : 6000;
    const cueOut = a?.cueOutMs ?? aDur;
    return { mixOutMs: Math.max(0, cueOut - len), mixInMs: b?.cueInMs ?? 0, crossfadeMs: len, tempoRatio: 1, style: 'fade', keyMatch, bpmDelta: null, fx: 'none', reason: 'Not analysed yet: plain fade' };
  }
  const bpmDelta = tempo ? Math.round(tempo.d * 1000) / 10 : null;
  const hasBeat = !!a.bpm && (a.bpmConfidence ?? 0) >= 0.35;
  const beatable = !!tempo && tempo.d <= maxStretch && hasBeat && (b.bpmConfidence ?? 0) >= 0.35;
  const clash = keyMatch === 'clash';
  let style: DjTransition['style'] = beatable && !clash ? 'blend' : clash && (!tempo || tempo.d > maxStretch) ? 'cut' : 'fade';
  const beatMs = a.bpm ? 60000 / a.bpm : 500;
  const barA = beatMs * 4;
  const gridA = a.downbeatMs ?? a.beatOffsetMs;
  const gridB = b.downbeatMs ?? b.beatOffsetMs;

  // Mix-out: start of A's outro phrase (phrase analysis), else the loudness-based outro (snapped to a bar below).
  let phraseAligned = false;
  let mixOut: number;
  const ph = a.phrases?.length && a.downbeatMs != null && a.bpm ? phraseMixPoints(a.phrases, a.downbeatMs, a.bpm, a.cueOutMs) : null;
  if (ph) {
    mixOut = ph.mixOutMs;
    phraseAligned = true;
  } else mixOut = a.outroStartMs ?? Infinity;

  // Mix-in: B's first downbeat (bar 1 of its intro phrase), else the first beat after its cue-in.
  const mixIn = firstDownbeat(b);

  // Length: whole phrases (4/8/16/32 bars) shaped by the outro/intro and the preference.
  let crossfade: number;
  if (style === 'blend') {
    const outroLen = Math.max(0, a.cueOutMs - (Number.isFinite(mixOut) ? mixOut : a.cueOutMs));
    const introPhrase = b.phrases?.[0];
    const introLen = introPhrase ? introPhrase.endMs - mixIn : b.introEndMs != null ? b.introEndMs - b.cueInMs : 0;
    let bars = snapBars(Math.max(outroLen, introLen) / barA);
    if (pref === 'minimal') bars = Math.min(bars, 8);
    else if (pref === 'energetic') bars = Math.max(8, Math.min(bars, 16));
    else if (pref === 'smooth') bars = Math.max(bars, 16);
    else bars = Math.max(8, Math.min(bars, 32));
    crossfade = Math.min(Math.max(bars * barA, 6000), pref === 'smooth' ? 48000 : 36000);
  } else if (style === 'fade') crossfade = pref === 'minimal' ? 3500 : pref === 'smooth' ? 8000 : 5000;
  else crossfade = 1500;

  // Keep the whole transition inside A's audible part. On a phrase start, shorten the blend to the whole
  // phrases that still fit (32 → 16 → 8 → 4 bars) rather than leaving the phrase line.
  if (ph && style === 'blend' && mixOut + crossfade > a.cueOutMs) {
    const fit = [32, 16, 8, 4].map((n) => n * barA).find((len) => len <= crossfade && mixOut + len <= a.cueOutMs + 0.25 * barA);
    if (fit) crossfade = Math.min(fit, Math.max(1000, a.cueOutMs - mixOut));
  }
  if (!Number.isFinite(mixOut) || mixOut + crossfade > a.cueOutMs) mixOut = a.cueOutMs - crossfade;
  const earliest = a.cueInMs + Math.min(30000, a.durationMs / 3);
  if (mixOut < earliest) {
    mixOut = earliest;
    phraseAligned = false;
  }
  if (mixOut + crossfade > a.cueOutMs) crossfade = Math.max(1000, a.cueOutMs - mixOut);

  // Snap to A's grid: keep a phrase start as is; otherwise prefer an 8-bar line, then a bar.
  if (a.bpm && gridA != null) {
    const onBar = Math.abs(((mixOut - gridA) / barA) - Math.round((mixOut - gridA) / barA)) * barA < 5;
    if (!onBar) {
      phraseAligned = false;
      const bar = gridA + Math.floor((mixOut - gridA) / barA + 1e-6) * barA;
      const eight = gridA + Math.floor((mixOut - gridA) / (barA * 8) + 1e-6) * barA * 8;
      mixOut = eight >= earliest && eight + crossfade <= a.cueOutMs + barA ? eight : bar;
    }
  } else if (style === 'blend') style = 'fade';
  if (style === 'blend' && (b.bpm == null || gridB == null)) style = 'fade';

  const outPhrase = phraseAt(a.phrases, mixOut + 1)?.type ?? null;
  const inPhrase = phraseAt(b.phrases, mixIn + 1)?.type ?? null;
  const tempoRatio = style === 'blend' && tempo ? Math.round(tempo.ratio * 1e5) / 1e5 : 1; // 5 decimals: 0.1 % off drifts 60 ms a minute

  const { fx, reason } = chooseFx({
    style, preference: pref, energyDelta: (b.energy ?? 0.5) - (a.energy ?? 0.5), tempoGap: tempo?.d ?? null, maxStretch, keyMatch, outPhrase, inPhrase,
    hasBeat, genres: [...(opts.genresA ?? []), ...(opts.genresB ?? [])],
  });

  // Echo-out: short (2 bars, timed on A's beat); the new track drops in on the bar.
  if (fx === 'echo') crossfade = Math.max(2000, Math.min(6000, barA * 2));
  const swapAtMs = fx === 'bassSwap' ? Math.round(bassSwapPoint(b, mixIn, crossfade, tempoRatio, barA)) : undefined;

  return {
    mixOutMs: Math.round(Math.max(0, mixOut)), mixInMs: Math.round(Math.max(0, mixIn)), crossfadeMs: Math.round(crossfade), tempoRatio, style, keyMatch, bpmDelta,
    fx, ...(swapAtMs != null ? { swapAtMs } : {}), phraseAligned: phraseAligned && !!a.phrases?.length, outPhrase, inPhrase,
    beatMs: a.bpm ? Math.round(beatMs * 100) / 100 : null, reason,
  };
}

/**
 * When to swap the basslines, in ms after the transition starts: a phrase boundary of the incoming track inside
 * the middle of the window (closest to its centre), else an 8/4/2/1-bar line counted from the mix-in point
 * (adapted from OpenDJ phraseSwapPoint).
 */
export function bassSwapPoint(b: TrackAnalysis, mixInMs: number, crossfadeMs: number, tempoRatio: number, barMs: number): number {
  const r = tempoRatio || 1;
  const lenIn = crossfadeMs * r; // incoming-track time covered by the transition
  const lo = mixInMs + 0.2 * lenIn, hi = mixInMs + 0.85 * lenIn, mid = mixInMs + 0.5 * lenIn;
  const pick = (c: number[]) => c.filter((x) => x >= lo && x <= hi).sort((x, y) => Math.abs(x - mid) - Math.abs(y - mid))[0];
  const fromPhrases = pick((b.phrases ?? []).map((p) => p.startMs));
  if (fromPhrases != null) return (fromPhrases - mixInMs) / r;
  const barIn = b.bpm ? 240000 / b.bpm : barMs * r;
  for (const bars of [8, 4, 2, 1]) {
    const step = bars * barIn;
    const c: number[] = [];
    for (let k = Math.ceil((lo - mixInMs) / step - 1e-6); mixInMs + k * step <= hi + 1e-6; k++) c.push(mixInMs + k * step);
    const p = pick(c);
    if (p != null) return (p - mixInMs) / r;
  }
  return crossfadeMs / 2;
}

const lc = (s: string) => s.toLowerCase();

const CAND_SQL = `SELECT i.id, i.grandparent_id artist_id, i.parent_id album_id, i.genres, i.duration_ms, al.genres album_genres, ud.favorite, ud.rating, COALESCE(i.year, al.year) year
     FROM items i LEFT JOIN items al ON al.id = i.parent_id LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?`;

/** Tracks the user can see matching `where` (plus the access clause), with their mix features (one lean query each). */
function selectCandidates(user: User, where: string[], params: Param[], limit = 50000): Cand[] {
  const acc = accessClause(user, 'i');
  const rows = db.all(
    `${CAND_SQL} WHERE ${[acc.sql, "i.type = 'track'", 'EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id)', ...where].join(' AND ')} LIMIT ${limit}`,
    user.id, ...acc.params, ...params);
  const feats = getMixFeatures(rows.map((r) => r.id));
  return rows.map((r) => {
    const own = parseJson<string[]>(r.genres, []);
    return {
      id: r.id, artistId: r.artist_id, albumId: r.album_id,
      // A track's own genre tags win; the album's genres are only a fallback for untagged tracks.
      genres: [...new Set((own.length ? own : parseJson<string[]>(r.album_genres, [])).map(lc))],
      durationMs: r.duration_ms ?? 0, favorite: !!r.favorite, rating: r.rating ?? null, year: r.year ?? null, f: feats.get(r.id) ?? null,
    };
  });
}

function loadCandidates(user: User, req: DjMixRequest, rules: EffectiveRules): Cand[] {
  // DJ rules (the listener's preset ∩ admin-enforced restrictions) bound every candidate, endless top-ups included.
  const { where, params } = rulesWhere(user, rules);
  if (req.libraryId) {
    where.push('i.library_id = ?');
    params.push(req.libraryId);
  }
  const wantGenres = (req.genres ?? []).map(lc);
  return selectCandidates(user, where, params)
    .filter((c) => !wantGenres.length || c.genres.some((g) => wantGenres.includes(g)))
    .filter((c) => (req.yearFrom == null || (c.year != null && c.year >= req.yearFrom)) && (req.yearTo == null || (c.year != null && c.year <= req.yearTo)))
    .filter((c) => req.maxTrackMinutes == null || !c.durationMs || c.durationMs <= req.maxTrackMinutes * 60000)
    .filter((c) => {
      if (req.bpmMin == null && req.bpmMax == null) return true;
      const b = c.f?.bpm;
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

/* ------------------------------ scoring ------------------------------ */

interface ScoreCtx {
  harmonic: boolean;
  genres: Set<string>;
  /** Unit-length z-scored timbre vectors by track id (cosine similarity = dot product); empty below 5 tracks. */
  z: Map<string, Float64Array>;
  seedZ: Float64Array | null;
  skips: { tracks: Map<string, number>; artists: Map<string, number> };
  preferFavorites: boolean;
}

/** z-score every timbre fingerprint against the candidates' statistics once, so each comparison is a dot product. */
function timbreIndex(cands: Cand[]): Map<string, Float64Array> {
  const out = new Map<string, Float64Array>();
  const dims = cands.find((c) => c.f?.timbre?.length)?.f?.timbre?.length ?? 0;
  const withT = dims ? cands.filter((c) => c.f?.timbre?.length === dims) : [];
  if (withT.length < 5) return out;
  const mean = new Float64Array(dims);
  const std = new Float64Array(dims);
  for (const c of withT) for (let i = 0; i < dims; i++) mean[i] += c.f!.timbre![i] / withT.length;
  for (const c of withT) for (let i = 0; i < dims; i++) std[i] += (c.f!.timbre![i] - mean[i]) ** 2 / withT.length;
  for (let i = 0; i < dims; i++) std[i] = Math.sqrt(std[i]) || 1;
  for (const c of withT) {
    const v = new Float64Array(dims);
    let n = 0;
    for (let i = 0; i < dims; i++) {
      v[i] = (c.f!.timbre![i] - mean[i]) / std[i];
      n += v[i] * v[i];
    }
    if (n > 0) {
      n = Math.sqrt(n);
      for (let i = 0; i < dims; i++) v[i] /= n;
      out.set(c.id, v);
    }
  }
  return out;
}
const dot = (a: Float64Array, b: Float64Array) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};
const keyMemo = new Map<string, ReturnType<typeof keyCompatibility>>();
const keyCompat = (a: string | null, b: string | null) => {
  const k = `${a}|${b}`;
  let v = keyMemo.get(k);
  if (!v) keyMemo.set(k, (v = keyCompatibility(a, b)));
  return v;
};

/** How well `c` follows `prev` (key, tempo, energy target, genre, timbre, taste); higher is better. */
function scoreCand(ctx: ScoreCtx, prev: Cand | null, c: Cand, target: number): number {
  let s = 0;
  const a = c.f;
  if (prev?.f && a) {
    if (ctx.harmonic) {
      const k = keyCompat(prev.f.camelot, a.camelot);
      s += 0.3 * (k === 'perfect' ? 1 : k === 'compatible' ? 0.85 : k === 'energy' ? 0.55 : k === 'unknown' ? 0.45 : 0.05);
    }
    const t = tempoDistance(prev.f.bpm, a.bpm);
    s += 0.3 * (t ? Math.exp(-Math.pow(t.d / 0.04, 2)) : 0.35);
  } else s += 0.25;
  s += a ? 0.25 * Math.max(0, 1 - Math.abs(a.energy - target) * 3) : 0.08;
  if (ctx.genres.size) {
    let overlap = 0;
    for (const g of c.genres) if (ctx.genres.has(g)) overlap++;
    s += 0.15 * (overlap ? Math.min(1, overlap / Math.min(3, c.genres.length || 1)) : 0);
  }
  // "Sounds like": close to the previous track and to the seed (keeps the mix coherent beyond tempo/key).
  const zc = ctx.z.get(c.id);
  if (zc) {
    const zp = prev ? ctx.z.get(prev.id) : undefined;
    s += 0.12 * Math.max(0, zp ? dot(zp, zc) : 0) + 0.08 * Math.max(0, ctx.seedZ ? dot(ctx.seedZ, zc) : 0);
  }
  s -= Math.min(0.5, 0.25 * (ctx.skips.tracks.get(c.id) ?? 0)) + Math.min(0.2, 0.04 * (c.artistId ? ctx.skips.artists.get(c.artistId) ?? 0 : 0));
  if (ctx.preferFavorites) s += (c.favorite ? 0.06 : 0) + ((c.rating ?? 0) / 10) * 0.04;
  if (prev && c.albumId && c.albumId === prev.albumId) s -= 0.1; // variety
  return s + Math.random() * 0.04;
}

/** Candidates of one request, with the in-genre subset precomputed for sampling big libraries. */
interface CandPool {
  all: Cand[];
  inGenre: Cand[];
}
const candPool = (all: Cand[], genres: Set<string>): CandPool => ({ all, inGenre: genres.size && all.length > SAMPLE_OVER ? all.filter((c) => c.genres.some((g) => genres.has(g))) : [] });
/** Above this many candidates each step scores a (genre-weighted) random sample instead of everything. */
const SAMPLE_OVER = 4000;

/** The best next track (not used, artist gap respected when possible), in one pass without building pools. */
function pickNext(ctx: ScoreCtx, pool: CandPool, used: Set<string>, recentArtists: (string | null)[], artistGap: number, prev: Cand | null, target: number): Cand | null {
  const blocked = new Set(recentArtists.slice(-artistGap).filter(Boolean));
  let best: Cand | null = null;
  let bestScore = -Infinity;
  let fallback: Cand | null = null;
  let fallbackScore = -Infinity;
  const consider = (c: Cand) => {
    if (used.has(c.id)) return;
    const s = scoreCand(ctx, prev, c, target);
    if (c.artistId && blocked.has(c.artistId)) {
      if (s > fallbackScore) {
        fallbackScore = s;
        fallback = c;
      }
    } else if (s > bestScore) {
      bestScore = s;
      best = c;
    }
  };
  const { all, inGenre } = pool;
  if (all.length <= SAMPLE_OVER) for (const c of all) consider(c);
  else {
    // Big libraries: score a genre-weighted random sample (duplicates are harmless).
    const draw = (arr: Cand[], n: number) => {
      if (arr.length <= n) for (const c of arr) consider(c);
      else for (let i = 0; i < n; i++) consider(arr[Math.floor(Math.random() * arr.length)]);
    };
    draw(inGenre, 2500);
    draw(all, inGenre.length ? 1500 : SAMPLE_OVER);
    // A sample of a nearly used-up library can come back empty: fall back to a full pass.
    if (!best && !fallback) for (const c of all) consider(c);
  }
  return best ?? fallback;
}

const PREFS: DjTransitionPreference[] = ['auto', 'smooth', 'energetic', 'minimal'];
/** Planner options from a request (preference and the clamped tempo-stretch limit). */
export function transitionOptions(transitions: unknown, maxStretchPct: unknown): Pick<PlanOptions, 'preference' | 'maxStretch'> {
  const pct = typeof maxStretchPct === 'number' ? maxStretchPct : typeof maxStretchPct === 'string' && maxStretchPct.trim() ? Number(maxStretchPct) : NaN;
  return {
    preference: PREFS.includes(transitions as DjTransitionPreference) ? (transitions as DjTransitionPreference) : 'auto',
    maxStretch: Number.isFinite(pct) && pct > 0 ? Math.max(1, Math.min(16, pct)) / 100 : 0.08,
  };
}

/**
 * Length of a mix as played: each track runs from its mix-in point until the next track starts at its mix-out
 * point (the tail after that is faded or skipped); the last track plays to its end.
 */
class MixClock {
  private committed = 0;
  private lastIn = 0;
  private lastDur = 0;
  private any = false;
  /** Add a track; `t` is the transition into it (null: a plain gap-less follow-on). The first track starts at `firstInMs`. */
  add(durationMs: number, t: DjTransition | null, firstInMs = 0) {
    if (!this.any) this.lastIn = firstInMs;
    else if (t) {
      this.committed += Math.max(0, t.mixOutMs - this.lastIn);
      this.lastIn = t.mixInMs;
    } else {
      this.committed += Math.max(0, this.lastDur - this.lastIn);
      this.lastIn = 0;
    }
    this.lastDur = durationMs;
    this.any = true;
  }
  get totalMs() {
    return this.any ? this.committed + Math.max(0, this.lastDur - this.lastIn) : 0;
  }
}

/** Build an ordered DJ mix (or the next `count` tracks of a continuous mix). */
export function buildMix(user: User, req: DjMixRequest, rules: EffectiveRules = effectiveRules(user, req)): DjMix {
  const curve: DjEnergyCurve = CURVES.includes(req.curve as DjEnergyCurve) ? (req.curve as DjEnergyCurve) : 'steady';
  const artistGap = Math.max(0, Math.min(20, req.artistGap ?? 3));
  const cands = loadCandidates(user, req, rules);
  if (!cands.length) throw badRequest('No music matches those filters');
  const byId = new Map(cands.map((c) => [c.id, c]));
  const { start, genres } = resolveSeed(user, req, cands, byId);
  const energies = cands.filter((c) => c.f).map((c) => c.f!.energy).sort((x, y) => x - y);
  const z = timbreIndex(cands);
  const seedCand = start ?? (req.history?.length ? byId.get(req.history[req.history.length - 1]) : null) ?? null;
  const ctx: ScoreCtx = {
    harmonic: req.harmonic !== false, genres, z, seedZ: seedCand ? z.get(seedCand.id) ?? null : null,
    // Listener feedback: recently skipped tracks and artists are played less.
    skips: skipStats(user.id), preferFavorites: req.preferFavorites !== false,
  };
  const analyzedShare = cands.length ? energies.length / cands.length : 0;
  const pool = candPool(cands, genres);

  const history = (req.history ?? []).filter((id) => byId.has(id) || db.get('SELECT 1 FROM items WHERE id = ?', id));
  const used = new Set(history);
  const recentArtists: (string | null)[] = history.slice(-artistGap).map((id) => byId.get(id)?.artistId ?? null);
  let prev: Cand | null = history.length ? byId.get(history[history.length - 1]) ?? null : null;
  const seedEnergy = (start ?? prev)?.f?.energy;
  const seedPct = seedEnergy != null && energies.length ? Math.max(0, energies.findIndex((e) => e >= seedEnergy)) / energies.length : 0.55;

  const planOpts = (x: Cand, y: Cand): PlanOptions => ({ ...transitionOptions(req.transitions, req.maxStretchPct), genresA: x.genres, genresB: y.genres });
  const full = analysisLoader();
  const targetMs = (req.durationMin ?? 60) * 60000;
  const maxCount = req.count != null ? Math.max(1, Math.min(100, req.count)) : 200;
  const out: Cand[] = [];
  // The mix's length as played (mix-in to mix-out of each track), so "1 hour" means an hour of mix.
  const clock = new MixClock();
  const add = (c: Cand) => {
    clock.add(c.durationMs, out.length ? planTransition(full(out[out.length - 1]), out[out.length - 1].durationMs, full(c), planOpts(out[out.length - 1], c)) : null);
    out.push(c);
    used.add(c.id);
    recentArtists.push(c.artistId);
    prev = c;
  };
  if (start && !used.has(start.id)) add(start);
  // Continuous mode keeps the curve moving with the history length (≈ 30-track arc).
  const position = () => (req.count != null ? ((history.length + out.length) % 30) / 30 : Math.min(1, clock.totalMs / targetMs));

  while (out.length < maxCount && (req.count != null || clock.totalMs < targetMs)) {
    const target = percentile(energies, curveTarget(curve, position(), seedPct));
    const best = pickNext(ctx, pool, used, recentArtists, artistGap, prev, target);
    if (!best) break;
    add(best);
  }

  // Materialise items and transitions.
  const tracks: DjMixTrack[] = [];
  let before: Cand | null = history.length ? byId.get(history[history.length - 1]) ?? null : null;
  const played = new MixClock();
  for (const c of out) {
    let item;
    try {
      item = getItem(user, c.id, false);
    } catch {
      continue;
    }
    const transition = before ? planTransition(full(before), before.durationMs, full(c), planOpts(before, c)) : null;
    tracks.push({ item, analysis: full(c), transition });
    // Continuing from the history: count from the first new track's mix-in.
    played.add(c.durationMs, transition, transition?.mixInMs ?? 0);
    before = c;
  }
  return { tracks, durationMs: Math.max(0, played.totalMs), curve, analyzedShare: Math.round(analyzedShare * 100) / 100 };
}

/** Full analyses, loaded only for the tracks a mix actually uses (scoring needs just the lean features). */
function analysisLoader() {
  const cache = new Map<string, TrackAnalysis | null>();
  return (c: Cand): TrackAnalysis | null => {
    if (!c.f) return null;
    let a = cache.get(c.id);
    if (a === undefined) cache.set(c.id, (a = getAnalysis(c.id)));
    return a;
  };
}

/* --------------------------- order as a mix --------------------------- */

const MAX_ORDER_IDS = 5000;

/** SQL (on alias i) selecting the tracks of a source, after checking the user may see it. */
export function sourceWhere(user: User, src: DjOrderSource): { where: string[]; params: Param[] } {
  if (!src || typeof src !== 'object' || typeof src.id !== 'string' || !src.id) throw badRequest('source needs a type and an id');
  switch (src.type) {
    case 'library':
    case 'folder': {
      if (!allowedLibraryIds(user).includes(src.id)) throw notFound('Library not found');
      if (src.type === 'library') return { where: ['i.library_id = ?'], params: [src.id] };
      if (typeof src.path !== 'string' || !src.path.trim()) throw badRequest('A folder source needs a path');
      const lib = db.get<{ paths: string }>('SELECT paths FROM libraries WHERE id = ?', src.id);
      const roots = parseJson<string[]>(lib?.paths ?? '[]', []).map((r) => path.resolve(r));
      const want = src.path.trim();
      const dir = path.isAbsolute(want) ? path.resolve(want) : null;
      const inLib = (d: string) => roots.some((r) => d === r || d.startsWith(r.endsWith(path.sep) ? r : r + path.sep));
      const dirs = dir ? (inLib(dir) ? [dir] : []) : roots.map((r) => path.resolve(r, want)).filter(inLib);
      if (!dirs.length) throw badRequest('That folder is not inside the library');
      const esc = (d: string) => (d.endsWith(path.sep) ? d : d + path.sep).replace(/[\\%_]/g, (c) => `\\${c}`) + '%';
      return {
        where: ['i.library_id = ?', `EXISTS (SELECT 1 FROM media fm WHERE fm.item_id = i.id AND (${dirs.map(() => "fm.path LIKE ? ESCAPE '\\'").join(' OR ')}))`],
        params: [src.id, ...dirs.map(esc)],
      };
    }
    case 'genre': {
      const g = src.id.trim().toLowerCase();
      const where = [`(EXISTS (SELECT 1 FROM json_each(i.genres) j WHERE LOWER(j.value) = ?)
        OR (COALESCE(i.genres, '[]') = '[]' AND EXISTS (SELECT 1 FROM items ga, json_each(ga.genres) j WHERE ga.id = i.parent_id AND LOWER(j.value) = ?)))`];
      const params: Param[] = [g, g];
      if (src.libraryId) {
        where.push('i.library_id = ?');
        params.push(src.libraryId);
      }
      return { where, params };
    }
    case 'artist':
      assertCanSee(user, src.id);
      return { where: ['(i.grandparent_id = ? OR i.id IN (SELECT track_id FROM track_artists WHERE artist_id = ?))'], params: [src.id, src.id] };
    case 'album':
      assertCanSee(user, src.id);
      return { where: ['i.parent_id = ?'], params: [src.id] };
    case 'playlist':
      assertCanSee(user, src.id);
      return { where: ['i.id IN (SELECT item_id FROM collection_items WHERE collection_id = ?)'], params: [src.id] };
    default:
      throw badRequest('source.type must be library, genre, artist, album, playlist or folder');
  }
}

/** Explicit ids (a queue): tracks as is; albums, artists and playlists expand to their tracks. */
function idsCandidates(user: User, ids: string[], extra: { where: string[]; params: Param[] }): Cand[] {
  const out = new Map<string, Cand>();
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const q = chunk.map(() => '?').join(',');
    const pl = accessClause(user, 'pl');
    for (const c of selectCandidates(user, [`(i.id IN (${q}) OR i.parent_id IN (${q}) OR i.grandparent_id IN (${q}) OR i.id IN (SELECT ci.item_id FROM collection_items ci WHERE ci.collection_id IN (SELECT pl.id FROM items pl WHERE pl.id IN (${q}) AND pl.type IN ('playlist','collection') AND ${pl.sql})))`, ...extra.where],
      [...chunk, ...chunk, ...chunk, ...chunk, ...pl.params, ...extra.params], MAX_ORDER_IDS)) {
      if (out.size < MAX_ORDER_IDS) out.set(c.id, c);
    }
  }
  return [...out.values()];
}

/**
 * Put a source's tracks (or a list of ids) in a mix-friendly order: each next track is the best by key (Camelot),
 * tempo (half/double aware), timbre and an energy arc across the whole source, never repeating, artists spread out.
 * Local and deterministic apart from a small random tie-break; no AI, no network. Pages with `history`.
 */
export function orderTracks(user: User, req: DjOrderRequest, rules: EffectiveRules = effectiveRules(user, req)): { ids: string[]; total: number; remaining: number } {
  if (req.itemIds != null && (!Array.isArray(req.itemIds) || req.itemIds.length > MAX_ORDER_IDS || req.itemIds.some((x) => typeof x !== 'string'))) {
    throw badRequest(`itemIds must be a list of up to ${MAX_ORDER_IDS} ids`);
  }
  if (req.history != null && (!Array.isArray(req.history) || req.history.length > 5000 || req.history.some((x) => typeof x !== 'string'))) throw badRequest('history must be a list of up to 5000 ids');
  if (!req.itemIds?.length && !req.source) throw badRequest('Send itemIds or a source');
  const limit = Math.max(1, Math.min(500, Math.floor(Number(req.limit) || 100)));
  const rw = rulesWhere(user, rules);
  let cands = req.itemIds?.length ? idsCandidates(user, req.itemIds, rw) : [];
  if (req.source) {
    const { where, params } = sourceWhere(user, req.source);
    const fromSource = selectCandidates(user, [...where, ...rw.where], [...params, ...rw.params]);
    if (req.itemIds?.length) {
      const keep = new Set(fromSource.map((c) => c.id));
      cands = cands.filter((c) => keep.has(c.id));
    } else cands = fromSource;
  }
  const total = cands.length;
  const byId = new Map(cands.map((c) => [c.id, c]));
  const history = req.history ?? [];
  const used = new Set(history);
  const left = cands.filter((c) => !used.has(c.id));
  if (!left.length) return { ids: [], total, remaining: 0 };
  // Continue from the last played track, even when it is not part of this source.
  const lastId = history[history.length - 1];
  let prev: Cand | null = lastId ? byId.get(lastId) ?? null : null;
  if (lastId && !prev) prev = selectCandidates(user, ['i.id = ?'], [lastId], 1)[0] ?? null;
  const energies = cands.filter((c) => c.f).map((c) => c.f!.energy).sort((x, y) => x - y);
  const z = timbreIndex(prev && !byId.has(prev.id) ? [...cands, prev] : cands);
  const genres = new Set<string>();
  const curve: DjEnergyCurve = CURVES.includes(req.curve as DjEnergyCurve) ? (req.curve as DjEnergyCurve) : 'peak';
  const ctx: ScoreCtx = { harmonic: req.harmonic !== false, genres, z, seedZ: null, skips: skipStats(user.id), preferFavorites: false };
  const recentArtists: (string | null)[] = history.slice(-2).map((id) => byId.get(id)?.artistId ?? null);
  const pool = candPool(cands, genres);
  const out: Cand[] = [];
  const take = (c: Cand) => {
    out.push(c);
    used.add(c.id);
    recentArtists.push(c.artistId);
    prev = c;
  };
  if (!prev) {
    // Open gently: the requested track, else one from the lower-middle of the source's energy range.
    const asked = req.startItemId ? left.find((c) => c.id === req.startItemId) : undefined;
    const lo = percentile(energies, 0.15), hi = percentile(energies, 0.4);
    const openers = left.filter((c) => c.f && c.f.energy >= lo && c.f.energy <= hi);
    take(asked ?? (openers.length ? openers : left)[Math.floor(Math.random() * (openers.length || left.length))]);
  }
  const seedPct = 0.5;
  while (out.length < limit) {
    const target = percentile(energies, curveTarget(curve, Math.min(1, (history.length + out.length) / Math.max(1, total)), seedPct));
    const next = pickNext(ctx, pool, used, recentArtists, 2, prev, target);
    if (!next) break;
    take(next);
  }
  return { ids: out.map((c) => c.id), total, remaining: Math.max(0, left.length - out.length) };
}
