/**
 * Your DJ: a personal set from the listener's own library in themed segments (On repeat, Throwbacks, Forgotten
 * favourites, Deep cuts, Recently added, a genre, a decade, a time-of-day mood, or a typed request), 4–6 tracks per
 * batch ordered with the mix scoring for smooth transitions, each with a reason label. Tracks the DJ played come back
 * only after a cooldown (default 7 days) and artists are spread out; skips and loves steer it. Plays started from a
 * Your DJ batch are flagged in play history so they never count as "you play this a lot". Everything stays inside
 * the listener's DJ rules and the admin's enforced restrictions. Sessions live in memory (6 h idle TTL).
 */
import crypto from 'node:crypto';
import type { DjSegment, DjSegmentKind, DjSession, TrackAnalysis, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { accessClause, itemsByIds } from '../items.js';
import { getSettings } from '../settings.js';
import { bus } from '../events.js';
import { logger } from '../../util/log.js';
import { getAnalyses, upgradeLazily } from './analysis.js';
import { buildMix, orderTracks } from './mix.js';
import { effectiveRules, rulesWhere, type EffectiveRules } from './rules.js';
import { findSeed, libraryGenres, parsePrompt, parsePromptRules, type ParsedPrompt } from './ai.js';
import { REAL_PLAY } from '../facts.js';
import { makeBreak, yourDjCommentary } from './host/breaks.js';

const log = logger('your-dj');
const TTL = 6 * 3600000;
const DAY = 86400000;

interface Segment extends DjSegment {
  /** Batches served from this segment so far. */
  batches: number;
  /** Builder parameters (genre / decade / mood / request). */
  param?: string;
  request?: ParsedPrompt;
}

interface Sess {
  id: string;
  userId: string;
  rules: { rules?: unknown; presetId?: unknown };
  touched: number;
  segment: Segment;
  kinds: DjSegmentKind[];
  served: Set<string>;
  /** Genre / decade / mood segments used (not repeated in a session). */
  params: string[];
  /** First item of each segment → the segment (for the segment intro break). */
  starts: Map<string, DjSegment>;
}

const sessions = new Map<string, Sess>();

function sweep() {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.touched > TTL) sessions.delete(k);
  while (sessions.size > 1000) sessions.delete(sessions.keys().next().value!);
}

export function getSession(user: User, id: string): Sess | null {
  sweep();
  const s = sessions.get(id);
  if (!s || s.userId !== user.id) return null;
  s.touched = Date.now();
  return s;
}

/** The segment that starts at `itemId` in this session (for the break planner), if any. */
export function segmentStartingAt(user: User, sessionId: string | undefined, itemId: string): DjSegment | null {
  if (!sessionId) return null;
  const s = getSession(user, sessionId);
  return s?.starts.get(itemId) ?? null;
}

/* ------------------------------ candidates ------------------------------ */

interface Row {
  id: string;
  artist_id: string | null;
  /** Builder-specific number (plays, days, year…), used for the reason label. */
  n?: number | null;
  d?: string | null;
}

interface Ctx {
  user: User;
  rules: EffectiveRules;
  history: Set<string>;
  /** Tracks the DJ played within the cooldown (excluded first; relaxed when a small library runs dry). */
  cooldownDays: number;
  hour: number;
  /** Cooldown relaxation (small libraries): every segment kind is tried at a level before relaxing further. */
  relax?: number;
}

/** Base WHERE on alias i: playable tracks the user may see, within the rules, not in history, not cooling down, not often skipped. */
function baseWhere(ctx: Ctx, relax: number): { where: string[]; params: Param[] } {
  const acc = accessClause(ctx.user, 'i');
  const rw = rulesWhere(ctx.user, ctx.rules);
  const where = [acc.sql, "i.type = 'track'", 'EXISTS (SELECT 1 FROM media m WHERE m.item_id = i.id)', ...rw.where];
  const params: Param[] = [...acc.params, ...rw.params];
  const hist = [...ctx.history].slice(-1500);
  if (hist.length) {
    where.push(`i.id NOT IN (${hist.map(() => '?').join(',')})`);
    params.push(...hist);
  }
  const days = relax === 0 ? ctx.cooldownDays : relax === 1 ? Math.min(1, ctx.cooldownDays) : 0;
  if (days > 0) {
    where.push('i.id NOT IN (SELECT item_id FROM dj_served WHERE user_id = ? AND at > ?)');
    params.push(ctx.user.id, new Date(Date.now() - days * DAY).toISOString());
  }
  if (relax < 2) {
    // Skip steering: tracks skipped twice lately stay out; artists the DJ served a lot in the last 3 hours rest.
    where.push("i.id NOT IN (SELECT item_id FROM dj_feedback WHERE user_id = ? AND kind = 'skip' AND at > ? GROUP BY item_id HAVING COUNT(*) >= 2)");
    params.push(ctx.user.id, new Date(Date.now() - 60 * DAY).toISOString());
    where.push('COALESCE(i.grandparent_id, \'\') NOT IN (SELECT artist_id FROM dj_served WHERE user_id = ? AND at > ? AND artist_id IS NOT NULL GROUP BY artist_id HAVING COUNT(*) >= 3)');
    params.push(ctx.user.id, new Date(Date.now() - 3 * 3600000).toISOString());
  }
  return { where, params };
}

/** Run a builder query at the context's relax level (0 = full cooldown, 1 = a day, 2 = only this session's tracks). */
function query(ctx: Ctx, select: (w: string, p: Param[]) => Row[]): Row[] {
  const b = baseWhere(ctx, ctx.relax ?? 0);
  return select(b.where.join(' AND '), b.params);
}

const ago = (d: number) => new Date(Date.now() - d * DAY).toISOString();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthYear = (iso: string) => {
  const d = new Date(iso);
  return `${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
};

interface Built {
  segment: Omit<Segment, 'id' | 'batches'>;
  rows: Row[];
  reason: (r: Row) => string;
}

const LIMIT = 60;

function onRepeat(ctx: Ctx): Built | null {
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, COUNT(h.id) n FROM items i JOIN play_history h ON h.item_id = i.id AND h.user_id = ? AND h.started_at > ? AND ${REAL_PLAY}
     WHERE ${w} GROUP BY i.id HAVING COUNT(h.id) >= 2 ORDER BY n DESC, RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ago(30), ...p));
  if (rows.length < 4) return null;
  return { segment: { kind: 'on-repeat', title: 'On repeat', reason: "Songs you've had on lately" }, rows, reason: (r) => `You've played this ${r.n} times this month` };
}

function throwbacks(ctx: Ctx): Built | null {
  // Heavy plays in a past period, not played (by you) for 4+ months.
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, COUNT(h.id) n, MAX(h.started_at) d FROM items i JOIN play_history h ON h.item_id = i.id AND h.user_id = ? AND ${REAL_PLAY}
     WHERE ${w} GROUP BY i.id HAVING COUNT(h.id) >= 3 AND MAX(h.started_at) < ? ORDER BY n DESC, RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ...p, ago(120)));
  if (rows.length >= 4) {
    return { segment: { kind: 'throwbacks', title: 'Throwbacks', reason: 'Songs you had on repeat a while ago' }, rows, reason: (r) => (r.d ? `Big for you around ${monthYear(r.d)}` : 'One you used to play a lot') };
  }
  // Libraries without much history yet: play counts from user data (imports, other apps).
  const ud = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, ud.play_count n, ud.last_played_at d FROM items i JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w} AND ud.play_count >= 3 AND (ud.last_played_at IS NULL OR ud.last_played_at < ?) ORDER BY ud.play_count DESC, RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ...p, ago(120)));
  if (ud.length < 4) return null;
  return { segment: { kind: 'throwbacks', title: 'Throwbacks', reason: 'Old favourites you haven\'t played for months' }, rows: ud, reason: (r) => (r.d ? `Last played ${monthYear(r.d)}` : 'One you used to play a lot') };
}

function forgotten(ctx: Ctx): Built | null {
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, ud.rating n, (SELECT MAX(h.started_at) FROM play_history h WHERE h.user_id = ? AND h.item_id = i.id AND ${REAL_PLAY}) d
     FROM items i JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w} AND (ud.favorite = 1 OR ud.rating >= 8) AND (ud.last_played_at IS NULL OR ud.last_played_at < ?) ORDER BY RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ctx.user.id, ...p, ago(60)));
  if (rows.length < 4) return null;
  return { segment: { kind: 'forgotten', title: 'Forgotten favourites', reason: "Songs you love but haven't played in a while" }, rows, reason: (r) => (r.d ? `A favourite you haven't played since ${monthYear(r.d)}` : 'One of your favourites') };
}

function rare(ctx: Ctx): Built | null {
  // Never / rarely played tracks by artists you do listen to (deep cuts), else anything rarely played.
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, COALESCE(ud.play_count, 0) n FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w} AND COALESCE(ud.play_count, 0) <= 1 AND i.grandparent_id IN (
       SELECT t.grandparent_id FROM play_history h JOIN items t ON t.id = h.item_id WHERE h.user_id = ? AND ${REAL_PLAY} AND t.grandparent_id IS NOT NULL GROUP BY t.grandparent_id HAVING COUNT(*) >= 3)
     ORDER BY RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ...p, ctx.user.id));
  if (rows.length >= 4) return { segment: { kind: 'rare', title: 'Deep cuts', reason: 'Rarely played songs from artists you love' }, rows, reason: (r) => (r.n ? 'You\'ve only played this once' : 'You haven\'t played this one yet') };
  const any = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, COALESCE(ud.play_count, 0) n FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w} AND COALESCE(ud.play_count, 0) <= 1 ORDER BY RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ...p));
  if (any.length < 4) return null;
  return { segment: { kind: 'rare', title: 'Rarely played', reason: 'Songs from your library you hardly ever hear' }, rows: any, reason: (r) => (r.n ? 'You\'ve only played this once' : 'You haven\'t played this one yet') };
}

function recent(ctx: Ctx): Built | null {
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id, CAST((julianday('now') - julianday(i.added_at)) AS INTEGER) n FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ?
     WHERE ${w} AND i.added_at > ? ORDER BY COALESCE(ud.play_count, 0) ASC, i.added_at DESC LIMIT ${LIMIT}`, ctx.user.id, ...p, ago(45)));
  if (rows.length < 4) return null;
  return { segment: { kind: 'recent', title: 'Recently added', reason: 'Fresh in your library' }, rows, reason: (r) => (r.n != null && r.n <= 1 ? 'Added today' : `Added ${r.n} days ago`) };
}

/** Genres the listener plays most (last 90 days), then the library's. */
function topGenres(ctx: Ctx): string[] {
  const rows = db.all<{ g: string; n: number }>(
    `SELECT LOWER(j.value) g, COUNT(*) n FROM play_history h JOIN items i ON i.id = h.item_id, json_each(i.genres) j
     WHERE h.user_id = ? AND h.started_at > ? AND ${REAL_PLAY} GROUP BY LOWER(j.value) ORDER BY n DESC LIMIT 8`, ctx.user.id, ago(90));
  return rows.map((r) => r.g).filter(Boolean);
}

function genre(ctx: Ctx, used: Set<string>): Built | null {
  const lib = libraryGenres(ctx.user);
  const names = new Map(lib.map((g) => [g.toLowerCase(), g]));
  const order = [...topGenres(ctx).filter((g) => names.has(g)), ...lib.map((g) => g.toLowerCase()).sort(() => Math.random() - 0.5)];
  for (const g of [...new Set(order)].filter((x) => !used.has(`genre:${x}`)).slice(0, 6)) {
    const rows = query(ctx, (w, p) => db.all<Row>(
      `SELECT i.id, i.grandparent_id artist_id FROM items i WHERE ${w} AND (EXISTS (SELECT 1 FROM json_each(i.genres) j WHERE LOWER(j.value) = ?)
        OR (COALESCE(i.genres, '[]') = '[]' AND EXISTS (SELECT 1 FROM items ga, json_each(ga.genres) j WHERE ga.id = i.parent_id AND LOWER(j.value) = ?))) ORDER BY RANDOM() LIMIT ${LIMIT}`, ...p, g, g));
    if (rows.length >= 4) {
      const name = names.get(g) ?? g;
      return { segment: { kind: 'genre', title: name, reason: `Because you like ${name}`, param: g }, rows, reason: () => `${name} from your library` };
    }
  }
  return null;
}

function decade(ctx: Ctx, used: Set<string>): Built | null {
  const yr = "COALESCE(i.year, (SELECT ya.year FROM items ya WHERE ya.id = i.parent_id))";
  const fav = db.all<{ dec: number }>(
    `SELECT (${yr} / 10) * 10 dec, COUNT(*) n FROM play_history h JOIN items i ON i.id = h.item_id WHERE h.user_id = ? AND ${REAL_PLAY} AND ${yr} > 1900 GROUP BY dec ORDER BY n DESC LIMIT 4`, ctx.user.id).map((r) => r.dec);
  const libDecs = db.all<{ dec: number }>(`SELECT DISTINCT (${yr} / 10) * 10 dec FROM items i WHERE i.type = 'track' AND ${yr} > 1900 LIMIT 20`).map((r) => r.dec).sort(() => Math.random() - 0.5);
  for (const d of [...new Set([...fav, ...libDecs])].filter((x) => !used.has(`decade:${x}`)).slice(0, 5)) {
    const rows = query(ctx, (w, p) => db.all<Row>(`SELECT i.id, i.grandparent_id artist_id, ${yr} n FROM items i WHERE ${w} AND ${yr} BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ${LIMIT}`, ...p, d, d + 9));
    if (rows.length >= 4) return { segment: { kind: 'decade', title: `Back to the ${d}s`, reason: `A trip to the ${d}s`, param: String(d) }, rows, reason: (r) => (r.n ? `From ${r.n}` : `From the ${d}s`) };
  }
  return null;
}

/** Time-of-day mood from analysed energy: mellow mornings and late nights, upbeat afternoons, feel-good evenings. */
function mood(ctx: Ctx): Built | null {
  const h = ctx.hour;
  const m = h < 5 || h >= 22 ? { title: 'Late-night chill', reason: 'Something calm for the late hours', lo: 0, hi: 0.4, dir: 'ASC' }
    : h < 11 ? { title: 'Easy morning', reason: 'A mellow start to the day', lo: 0, hi: 0.5, dir: 'ASC' }
    : h < 17 ? { title: 'Afternoon lift', reason: 'Upbeat songs for the afternoon', lo: 0.5, hi: 1, dir: 'DESC' }
    : { title: 'Evening feel-good', reason: 'Feel-good energy for the evening', lo: 0.45, hi: 0.9, dir: 'DESC' };
  // Energy is relative to the library: use percentiles of the analysed tracks.
  const all = db.all<{ e: number }>("SELECT energy e FROM track_analysis WHERE error IS NULL AND energy > 0 ORDER BY energy").map((r) => r.e);
  if (all.length < 8) return null;
  const pct = (q: number) => all[Math.min(all.length - 1, Math.max(0, Math.round(q * (all.length - 1))))];
  const rows = query(ctx, (w, p) => db.all<Row>(
    `SELECT i.id, i.grandparent_id artist_id FROM items i JOIN track_analysis ta ON ta.item_id = i.id WHERE ${w} AND ta.energy BETWEEN ? AND ? ORDER BY RANDOM() LIMIT ${LIMIT}`, ...p, pct(m.lo), pct(m.hi)));
  if (rows.length < 4) return null;
  return { segment: { kind: 'mood', title: m.title, reason: m.reason, param: m.title }, rows, reason: () => m.reason };
}

/** Last resort inside the rules: anything playable. */
function anything(ctx: Ctx): Built | null {
  const rows = query(ctx, (w, p) => db.all<Row>(`SELECT i.id, i.grandparent_id artist_id FROM items i LEFT JOIN user_data ud ON ud.item_id = i.id AND ud.user_id = ? WHERE ${w} ORDER BY COALESCE(ud.favorite, 0) DESC, RANDOM() LIMIT ${LIMIT}`, ctx.user.id, ...p));
  if (!rows.length) return null;
  return { segment: { kind: 'mood', title: 'From your library', reason: 'A mix from your library' }, rows, reason: () => 'From your library' };
}

const ROTATION: DjSegmentKind[] = ['on-repeat', 'forgotten', 'genre', 'recent', 'throwbacks', 'decade', 'rare', 'mood'];

function build(kind: DjSegmentKind, ctx: Ctx, used: Set<string>): Built | null {
  switch (kind) {
    case 'on-repeat': return onRepeat(ctx);
    case 'throwbacks': return throwbacks(ctx);
    case 'forgotten': return forgotten(ctx);
    case 'rare': return rare(ctx);
    case 'recent': return recent(ctx);
    case 'genre': return genre(ctx, used);
    case 'decade': return decade(ctx, used);
    case 'mood': return mood(ctx);
    default: return null;
  }
}

/* ------------------------------ batches ------------------------------ */

const batchSize = () => 4 + Math.floor(Math.random() * 3); // 4–6

/** Pick a batch from a builder's pool: spread artists, then order for smooth transitions (key, tempo, energy). */
function pickBatch(user: User, built: Built, history: string[], rules: EffectiveRules): string[] {
  const n = batchSize();
  // Prefer one track per artist among the first picks (the pool is ordered by the builder's preference).
  const perArtist = new Map<string, number>();
  const pool: string[] = [];
  for (const r of built.rows) {
    const a = r.artist_id ?? r.id;
    if ((perArtist.get(a) ?? 0) >= 1 && built.rows.length > n * 2) continue;
    perArtist.set(a, (perArtist.get(a) ?? 0) + 1);
    pool.push(r.id);
    if (pool.length >= n * 2) break;
  }
  if (pool.length < n) for (const r of built.rows) if (!pool.includes(r.id) && pool.length < n * 2) pool.push(r.id);
  try {
    return orderTracks(user, { itemIds: pool, history: history.slice(-50), limit: n, curve: 'steady' }, rules).ids;
  } catch {
    return pool.slice(0, n);
  }
}

function hourOf(h: unknown) {
  const n = Number(h);
  return Number.isInteger(n) && n >= 0 && n < 24 ? n : new Date().getHours();
}

async function respond(user: User, s: Sess, seg: Segment, ids: string[], reasons: Record<string, string>, hour: number, history: string[], note: string | null): Promise<DjSession> {
  const items = itemsByIds(user, ids);
  const stored = getAnalyses(items.map((i) => i.id));
  const analyses: Record<string, TrackAnalysis | null> = {};
  for (const it of items) {
    const a = stored.get(it.id);
    analyses[it.id] = a ? { ...a, timbre: null } : null;
  }
  upgradeLazily(items.map((i) => i.id), 6);
  const now = new Date().toISOString();
  for (const it of items) {
    s.served.add(it.id);
    db.run('INSERT INTO dj_served (user_id, item_id, artist_id, session_id, at) VALUES (?, ?, ?, ?, ?)', user.id, it.id, it.grandparentId ?? null, s.id, now);
  }
  const pub: DjSegment = { id: seg.id, kind: seg.kind, title: seg.title, reason: seg.reason };
  let intro = null;
  if (items[0]) {
    s.starts.set(items[0].id, pub);
    if (yourDjCommentary(user) !== 'off' && seg.batches === 1) {
      intro = await makeBreak({
        user, req: { mode: 'yourdj', nextItemId: items[0].id, previousItemId: history[history.length - 1], sessionId: s.id, tracksSinceBreak: 0, msSinceBreak: 0, introMs: analyses[items[0].id]?.cues?.introEndMs ?? undefined, hour },
        segmentStart: pub, ttsWaitMs: 8000,
      }).catch(() => null);
      // The intro was said here; the break planner shouldn't introduce the segment again.
      if (intro) s.starts.delete(items[0].id);
    }
  }
  return { id: s.id, segment: pub, items, analyses, reasons: Object.fromEntries(items.map((i) => [i.id, reasons[i.id] ?? seg.reason])), intro, note };
}

function ctxFor(user: User, s: Sess, history: string[], hour: number): Ctx {
  return { user, rules: effectiveRules(user, s.rules), history: new Set([...history, ...s.served]), cooldownDays: getSettings().ai?.djTrackCooldownDays ?? 7, hour };
}

/** Build the next segment, trying kinds in order (`avoid` = kinds not to use). */
async function nextSegment(user: User, s: Sess, history: string[], hour: number, opts: { avoid?: DjSegmentKind[]; prefer?: DjSegmentKind[] } = {}): Promise<DjSession> {
  const ctx = ctxFor(user, s, history, hour);
  const usedParams = new Set(s.params);
  const recent = s.kinds.slice(-3);
  const order = [...(opts.prefer ?? []), ...ROTATION.filter((k) => !recent.includes(k)), ...ROTATION.filter((k) => recent.includes(k))]
    .filter((k, i, a) => a.indexOf(k) === i && !(opts.avoid ?? []).includes(k));
  let built: Built | null = null;
  let note: string | null = null;
  // Every kind with the full cooldown first; only then relax it (small libraries), never the rules.
  for (const relax of [0, 1, 2]) {
    ctx.relax = relax;
    for (const k of order) if ((built = build(k, ctx, usedParams))) break;
    if (built) break;
  }
  if (!built && opts.avoid?.length) {
    // Nothing else fits: stay with what works rather than go outside the rules.
    for (const relax of [0, 2]) {
      ctx.relax = relax;
      for (const k of opts.avoid) if ((built = build(k, ctx, usedParams))) break;
      if (built) break;
    }
    if (built) note = 'Not much else fits your DJ rules right now, so here\'s more of the same.';
  }
  if (!built) for (const relax of [0, 2]) if (!built) built = anything({ ...ctx, relax });
  if (!built) {
    const seg: Segment = { id: crypto.randomUUID(), kind: 'mood', title: 'Your DJ', reason: 'Nothing to play', batches: 1 };
    s.segment = seg;
    return respond(user, s, seg, [], {}, hour, history, ctx.rules.sets.length ? 'Nothing in your library matches your DJ rules right now.' : 'There is no music in your library yet.');
  }
  const seg: Segment = { ...built.segment, id: crypto.randomUUID(), batches: 1 };
  s.segment = seg;
  s.kinds.push(seg.kind);
  if (seg.param) s.params.push(`${seg.kind}:${seg.param}`);
  const ids = pickBatch(user, built, [...history], ctx.rules);
  const reasons: Record<string, string> = {};
  const rowById = new Map(built.rows.map((r) => [r.id, r]));
  for (const id of ids) reasons[id] = built.reason(rowById.get(id) ?? { id, artist_id: null });
  if (ids.length < 4 && ctx.rules.sets.length && !note) note = 'Only a few songs fit your DJ rules right now.';
  return respond(user, s, seg, ids, reasons, hour, history, note);
}

/* ------------------------------ public API ------------------------------ */

const cleanHistory = (h: unknown): string[] => (Array.isArray(h) ? h.filter((x): x is string => typeof x === 'string' && x.length <= 100).slice(-2000) : []);

export async function startSession(user: User, body: { rules?: unknown; presetId?: unknown; hour?: unknown } = {}): Promise<DjSession> {
  sweep();
  const s: Sess = { id: crypto.randomUUID(), userId: user.id, rules: { rules: body.rules, presetId: body.presetId }, touched: Date.now(), segment: null as unknown as Segment, kinds: [], served: new Set(), params: [], starts: new Map() };
  sessions.set(s.id, s);
  return nextSegment(user, s, [], hourOf(body.hour), { prefer: ['on-repeat', 'forgotten'] });
}

/** More: another batch of a request segment (up to 3), else the next segment in rotation. */
export async function moreSession(user: User, s: Sess, body: { history?: unknown; hour?: unknown } = {}): Promise<DjSession> {
  const history = cleanHistory(body.history);
  const hour = hourOf(body.hour);
  const seg = s.segment;
  if (seg?.kind === 'request' && seg.request && seg.batches < 3) {
    const r = await requestBatch(user, s, seg.request, history, hour);
    if (r) {
      seg.batches++;
      return respond(user, s, seg, r.ids, r.reasons, hour, history, null);
    }
  }
  return nextSegment(user, s, history, hour);
}

/** "Switch it up": always a different segment kind than the current one. */
export async function switchSession(user: User, s: Sess, body: { history?: unknown; hour?: unknown } = {}): Promise<DjSession> {
  return nextSegment(user, s, cleanHistory(body.history), hourOf(body.hour), { avoid: s.segment ? [s.segment.kind] : [] });
}

async function requestBatch(user: User, s: Sess, parsed: ParsedPrompt, history: string[], hour: number): Promise<{ ids: string[]; reasons: Record<string, string> } | null> {
  const ctx = ctxFor(user, s, history, hour);
  const req = { ...parsed.request, prompt: undefined, durationMin: undefined };
  const seedId = parsed.seedName ? findSeed(user, parsed.seedName) : null;
  const n = batchSize();
  const used = ctx.history;
  try {
    // A seed ("like Daft Punk") starts fresh from it; otherwise continue from the last track played.
    const mix = buildMix(user, { ...req, ...(seedId ? { seedItemId: seedId } : {}), history: seedId ? [] : history.slice(-200), count: n + Math.min(30, used.size) }, ctx.rules);
    const ids = mix.tracks.map((t) => t.item.id).filter((id) => !used.has(id)).slice(0, n);
    if (!ids.length) return null;
    const label = parsed.summary && parsed.summary !== 'A mix from your library' ? `You asked for ${parsed.summary.toLowerCase()}` : 'You asked for this';
    return { ids, reasons: Object.fromEntries(ids.map((id) => [id, label])) };
  } catch {
    return null; // nothing matches (within the rules)
  }
}

/** A typed request ("90s hip hop", "something like Daft Punk"): the LLM chain understands it, else the built-in parser. */
export async function requestSession(user: User, s: Sess, body: { text?: unknown; history?: unknown; hour?: unknown }): Promise<DjSession | { ok: false; message: string }> {
  const text = typeof body.text === 'string' ? body.text.trim().slice(0, 300) : '';
  const history = cleanHistory(body.history);
  const hour = hourOf(body.hour);
  let parsed: ParsedPrompt;
  try {
    parsed = await parsePrompt(user, text);
  } catch (e) {
    log.info(`Request parsing fell back to the built-in parser: ${(e as Error).message}`);
    parsed = parsePromptRules(text, libraryGenres(user));
  }
  const r = await requestBatch(user, s, parsed, history, hour);
  if (!r) {
    const rules = effectiveRules(user, s.rules);
    return { ok: false, message: rules.sets.length ? `I couldn't find anything for “${text}” within your DJ rules. I'll keep the current vibe going.` : `I couldn't find anything for “${text}” in your library. I'll keep the current vibe going.` };
  }
  const title = parsed.summary && parsed.summary !== 'A mix from your library' ? parsed.summary : text;
  const seg: Segment = { id: crypto.randomUUID(), kind: 'request', title: title.charAt(0).toUpperCase() + title.slice(1), reason: `You asked for “${text}”`, batches: 1, request: parsed };
  s.segment = seg;
  s.kinds.push('request');
  return respond(user, s, seg, r.ids, r.reasons, hour, history, null);
}

/** Three request chips from the listener's history and the time of day. */
export function suggestions(user: User, hourIn?: unknown): string[] {
  const hour = hourOf(hourIn);
  const chips: string[] = [];
  const ctx = { user } as Ctx;
  const lib = new Map(libraryGenres(user).map((g) => [g.toLowerCase(), g]));
  const g = topGenres(ctx).find((x) => lib.has(x));
  if (g) chips.push(`More ${lib.get(g)}`);
  const yr = "COALESCE(i.year, (SELECT ya.year FROM items ya WHERE ya.id = i.parent_id))";
  const dec = db.get<{ dec: number }>(`SELECT (${yr} / 10) * 10 dec, COUNT(*) n FROM play_history h JOIN items i ON i.id = h.item_id WHERE h.user_id = ? AND ${REAL_PLAY} AND ${yr} > 1900 GROUP BY dec ORDER BY n DESC LIMIT 1`, user.id);
  if (dec?.dec) chips.push(`${dec.dec}s throwbacks`);
  const art = db.get<{ t: string }>(`SELECT ar.title t FROM play_history h JOIN items i ON i.id = h.item_id JOIN items ar ON ar.id = i.grandparent_id WHERE h.user_id = ? AND ${REAL_PLAY} AND h.started_at > ? GROUP BY ar.id ORDER BY COUNT(*) DESC LIMIT 1`, user.id, ago(60));
  if (art?.t) chips.push(`Something like ${art.t}`);
  const time = hour < 5 || hour >= 22 ? 'Late-night chill' : hour < 11 ? 'Easy morning' : hour < 14 ? 'Upbeat lunch break' : hour < 18 ? 'Focus music' : 'Evening wind-down';
  chips.unshift(time);
  // Fill from the library when there is little history.
  const extra = [...lib.values()].sort(() => Math.random() - 0.5);
  while (chips.length < 3 && extra.length) chips.push(`Some ${extra.shift()}`);
  for (const c of ['Surprise me', 'Upbeat songs', 'Chill vibes']) if (chips.length < 3) chips.push(c);
  return [...new Set(chips)].slice(0, 3);
}

/* -------------------------- play attribution -------------------------- */

/**
 * A playback of a track a Your DJ session handed this user in the last 12 hours is that session's play: flag it in
 * play history (source 'yourdj') so On repeat, stats and "you've played this N times" only count real choices.
 */
export function attributePlay(userId: string, itemId: string, historyId: number) {
  const row = db.get<{ rowid: number }>('SELECT rowid FROM dj_served WHERE user_id = ? AND item_id = ? AND played_at IS NULL AND at > ? ORDER BY at DESC LIMIT 1', userId, itemId, new Date(Date.now() - 12 * 3600000).toISOString());
  if (!row) return false;
  db.run('UPDATE dj_served SET played_at = ? WHERE rowid = ?', new Date().toISOString(), row.rowid);
  db.run("UPDATE play_history SET source = 'yourdj' WHERE id = ?", historyId);
  return true;
}

bus.on('playback.start', (s: { ctx?: { user?: { id?: string } }; itemId?: string | null; historyId?: number | null }) => {
  try {
    if (s?.ctx?.user?.id && s.itemId && s.historyId) attributePlay(s.ctx.user.id, s.itemId, s.historyId);
  } catch (e) {
    log.warn(`Could not attribute a Your DJ play: ${(e as Error).message}`);
  }
});

/** Tests. */
export const resetSessions = () => sessions.clear();
