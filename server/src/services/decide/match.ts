/**
 * Movie Match: a group swipes through the same deck in the same order; when every member (or a majority) says
 * yes, everyone gets "It's a match!" over the WebSocket.
 *
 * Sessions live in memory (TTL 2 h after the last activity) and are keyed by member user id, so closing the app or
 * losing the connection never loses your place. The deck only ever contains titles every current member may see
 * (each member's own accessClause: libraries, parental rating cap, hide-unrated, kids profiles) — when someone with
 * a stricter profile joins, cards they can't see are taken out for everyone.
 */
import type { Item, MatchDeckResponse, MatchMember, MatchResult, MatchSessionState, MatchSettings, MatchVote, CreateMatchRequest, User } from '@mediamax/shared';
import { db, type Param } from '../../db.js';
import { itemsByIds } from '../items.js';
import { imageUrl } from '../images.js';
import { events } from '../events.js';
import { getUser } from '../auth.js';
import { badRequest, conflict, forbidden, notFound } from '../../util/errors.js';
import { newId } from '../../util/ids.js';
import { parseJson } from '../../util/misc.js';
import { clampList, groupAccess, numOrNull, rngFor, shuffle } from './common.js';

export const MATCH_TTL_MS = 2 * 3600_000;
export const DECK_SIZE = 60;
export const DECK_EXTEND = 30;
export const DECK_MAX = 300;
const MAX_SESSIONS = 200;
const MAX_PER_HOST = 3;
const MAX_MEMBERS = 12;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

interface MemberRec {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  joinedAt: number;
}

interface Session {
  id: string;
  code: string;
  hostUserId: string;
  hostDeviceRowId: string | null;
  hostDeviceName: string | null;
  settings: MatchSettings;
  members: Map<string, MemberRec>;
  deck: string[];
  votes: Map<string, Map<string, MatchVote>>;
  matched: Map<string, string>;
  ended: boolean;
  touchedAt: number;
  rng: () => number;
  /** Last broadcast online signature (to announce reconnects). */
  onlineSig: string;
}

const sessions = new Map<string, Session>();
let timer: NodeJS.Timeout | null = null;

export function _resetMatches() {
  sessions.clear();
}

/* ------------------------------- rules ------------------------------- */

/**
 * Is this card a match for a group of `memberCount` with these votes (current members only)?
 * - all: every member voted yes or super, nobody said no.
 * - majority: yes + 2 × super > half the group, from at least two different people.
 * A group of one never matches (there is nobody to agree with).
 */
export function isMatch(rule: MatchSettings['rule'], memberCount: number, votes: MatchVote[]): boolean {
  if (memberCount < 2) return false;
  const yes = votes.filter((v) => v === 'yes').length;
  const sup = votes.filter((v) => v === 'super').length;
  if (rule === 'all') return votes.length >= memberCount && yes + sup === memberCount;
  return yes + sup >= 2 && yes + 2 * sup > memberCount / 2;
}

export const enthusiasm = (yes: number, sup: number, no: number) => yes + 2 * sup - no;

/* -------------------------------- deck ------------------------------- */

export function normalizeSettings(b: CreateMatchRequest | undefined): MatchSettings {
  const s = b ?? {};
  return {
    kind: s.kind === 'shows' || s.kind === 'both' ? s.kind : 'movies',
    libraryIds: clampList(s.libraryIds),
    genres: clampList(s.genres),
    maxRuntimeMin: numOrNull(s.maxRuntimeMin, 1, 1000),
    unwatchedByAll: s.unwatchedByAll !== false,
    rule: s.rule === 'majority' ? 'majority' : 'all',
  };
}

interface DeckRow {
  id: string;
  type: string;
  community_rating: number | null;
  added_at: string;
  genres: string;
}

/** Items every member may see that fit the settings (slim rows). */
function pool(users: User[], s: MatchSettings, exclude: string[], seeded: boolean, onlyIds?: string[]): DeckRow[] {
  const g = groupAccess(users);
  const where = [g.sql];
  const params: Param[] = [...g.params];
  const types = s.kind === 'both' ? ['movie', 'show'] : s.kind === 'shows' ? ['show'] : ['movie'];
  where.push(`i.type IN (${types.map(() => '?').join(',')})`);
  params.push(...types);
  if (s.libraryIds.length) {
    where.push(`i.library_id IN (${s.libraryIds.map(() => '?').join(',')})`);
    params.push(...s.libraryIds);
  }
  if (s.genres.length) {
    where.push(`EXISTS (SELECT 1 FROM json_each(i.genres) WHERE json_each.value IN (${s.genres.map(() => '?').join(',')}))`);
    params.push(...s.genres);
  }
  if (s.maxRuntimeMin) {
    where.push(`(CASE WHEN i.type = 'show' THEN (SELECT AVG(e.duration_ms) FROM items e WHERE e.grandparent_id = i.id AND e.type = 'episode') ELSE i.duration_ms END) <= ?`);
    params.push(s.maxRuntimeMin * 60000);
  }
  const ids = users.map((u) => u.id);
  const inUsers = ids.map(() => '?').join(',');
  // Nobody in the group said "not interested" / thumbs down.
  where.push(`NOT EXISTS (SELECT 1 FROM user_data x WHERE x.item_id = i.id AND x.user_id IN (${inUsers}) AND (x.not_interested = 1 OR x.rating <= 4))`);
  params.push(...ids);
  if (s.unwatchedByAll) {
    where.push(`NOT EXISTS (SELECT 1 FROM user_data x WHERE x.item_id = i.id AND x.user_id IN (${inUsers}) AND x.played = 1)`);
    where.push(`NOT EXISTS (SELECT 1 FROM user_data x JOIN items e ON e.id = x.item_id WHERE e.grandparent_id = i.id AND x.user_id IN (${inUsers}) AND (x.played = 1 OR x.position_ms > 0))`);
    params.push(...ids, ...ids);
  }
  if (onlyIds) {
    where.push(`i.id IN (${onlyIds.map(() => '?').join(',') || 'NULL'})`);
    params.push(...onlyIds);
  }
  if (exclude.length) {
    where.push(`i.id NOT IN (${exclude.map(() => '?').join(',')})`);
    params.push(...exclude);
  }
  return db.all<DeckRow>(`SELECT i.id, i.type, i.community_rating, i.added_at, i.genres FROM items i WHERE ${where.join(' AND ')} ORDER BY ${seeded ? 'i.id' : 'RANDOM()'} LIMIT 3000`, ...params);
}

/** Genre weights from what the group has watched recently (movies and shows, episodes count for their show). */
function groupTaste(users: User[]): Map<string, number> {
  const ids = users.map((u) => u.id);
  if (!ids.length) return new Map();
  const rows = db.all<{ genres: string }>(
    `SELECT COALESCE(s.genres, i.genres) genres FROM user_data ud JOIN items i ON i.id = ud.item_id LEFT JOIN items s ON s.id = i.grandparent_id AND i.type = 'episode'
     WHERE ud.user_id IN (${ids.map(() => '?').join(',')}) AND (ud.played = 1 OR ud.favorite = 1) AND i.type IN ('movie','episode','show') AND COALESCE(ud.rating, 10) > 4
     ORDER BY ud.last_played_at DESC LIMIT 300`, ...ids);
  const w = new Map<string, number>();
  for (const r of rows) for (const g of parseJson<string[]>(r.genres, [])) w.set(g, (w.get(g) ?? 0) + 1);
  return w;
}

/** Which bucket each deck slot draws from: a smart mix of highly rated, related, recently added and random. */
const PATTERN = ['rated', 'related', 'recent', 'random', 'rated', 'related', 'recent', 'rated', 'random', 'related'] as const;

/**
 * Build `count` deck cards for the group (same order for everyone): a mix of highly rated, recently added, related
 * to what the group watched, and some random picks. Deterministic for a seeded `rng`.
 */
export function buildDeck(users: User[], s: MatchSettings, exclude: string[], count: number, rng: () => number, seeded = false): string[] {
  const rows = pool(users, s, exclude, seeded);
  if (!rows.length) return [];
  const taste = groupTaste(users);
  const relatedScore = (r: DeckRow) => parseJson<string[]>(r.genres, []).reduce((n, g) => n + (taste.get(g) ?? 0), 0);
  const lists: Record<(typeof PATTERN)[number], DeckRow[]> = {
    rated: [...rows].sort((a, b) => (b.community_rating ?? 0) - (a.community_rating ?? 0) || a.id.localeCompare(b.id)),
    recent: [...rows].sort((a, b) => b.added_at.localeCompare(a.added_at) || a.id.localeCompare(b.id)),
    related: taste.size ? rows.map((r) => ({ r, s: relatedScore(r) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id)).map((x) => x.r) : [],
    random: shuffle([...rows], rng),
  };
  // Light jitter inside the top of each ranked list so two sessions don't start identically.
  for (const k of ['rated', 'recent', 'related'] as const) {
    const head = lists[k].slice(0, Math.min(lists[k].length, count));
    lists[k] = [...shuffleWindows(head, 4, rng), ...lists[k].slice(head.length)];
  }
  const used = new Set<string>();
  const pos: Record<string, number> = { rated: 0, recent: 0, related: 0, random: 0 };
  const out: string[] = [];
  let slot = 0;
  let stalls = 0;
  while (out.length < count && out.length < rows.length && stalls < PATTERN.length * 2) {
    const k = PATTERN[slot++ % PATTERN.length];
    const list = lists[k];
    while (pos[k] < list.length && used.has(list[pos[k]].id)) pos[k]++;
    if (pos[k] >= list.length) {
      stalls++;
      continue;
    }
    stalls = 0;
    const id = list[pos[k]++].id;
    used.add(id);
    out.push(id);
  }
  return out;
}

function shuffleWindows<T>(arr: T[], size: number, rng: () => number): T[] {
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += size) out.push(...shuffle(arr.slice(i, i + size), rng));
  return out;
}

/* ------------------------------ sessions ----------------------------- */

const memberUsers = (s: Session): User[] => [...s.members.keys()].map((id) => {
  try {
    return getUser(id);
  } catch {
    return null;
  }
}).filter((u): u is User => !!u);

function newCode(): string {
  for (;;) {
    let c = '';
    for (let i = 0; i < 6; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
    if (![...sessions.values()].some((s) => s.code === c)) return c;
  }
}

const isOnline = (userId: string) => events.clients().some((c) => c.userId === userId);
const hostDeviceOnline = (s: Session) => !!s.hostDeviceRowId && events.clients().some((c) => c.deviceRowId === s.hostDeviceRowId);

function cursorOf(s: Session, userId: string): number {
  for (let i = 0; i < s.deck.length; i++) if (!s.votes.get(s.deck[i])?.has(userId)) return i;
  return s.deck.length;
}

function resultFor(s: Session, itemId: string, item?: Item | null): MatchResult {
  const v = [...(s.votes.get(itemId)?.entries() ?? [])].filter(([u]) => s.members.has(u)).map(([, x]) => x);
  const yes = v.filter((x) => x === 'yes').length;
  const sup = v.filter((x) => x === 'super').length;
  const no = v.filter((x) => x === 'no').length;
  const row = item ? null : db.get<{ title: string; year: number | null; poster: string | null; backdrop: string | null }>('SELECT title, year, poster, backdrop FROM items WHERE id = ?', itemId);
  return {
    itemId, title: item?.title ?? row?.title ?? '', year: item?.year ?? row?.year ?? null,
    posterUrl: item ? item.posterUrl : imageUrl(row?.poster ?? null), backdropUrl: item ? item.backdropUrl : imageUrl(row?.backdrop ?? null),
    yes, superLikes: sup, no, enthusiasm: enthusiasm(yes, sup, no), matchedAt: s.matched.get(itemId) ?? '',
  };
}

export function stateFor(s: Session, viewerId: string): MatchSessionState {
  const members: MatchMember[] = [...s.members.values()].map((m) => {
    const c = cursorOf(s, m.userId);
    return { userId: m.userId, displayName: m.displayName, avatarUrl: m.avatarUrl, isHost: m.userId === s.hostUserId, online: isOnline(m.userId), voted: c, done: c >= s.deck.length };
  });
  const matches = [...s.matched.keys()].map((id) => resultFor(s, id)).sort((a, b) => b.enthusiasm - a.enthusiasm || a.matchedAt.localeCompare(b.matchedAt));
  return {
    id: s.id, code: s.code, hostUserId: s.hostUserId, hostDeviceName: s.hostDeviceName, hostDeviceOnline: hostDeviceOnline(s),
    settings: s.settings, members, deckSize: s.deck.length, matches, ended: s.ended,
    expiresAt: new Date(s.touchedAt + MATCH_TTL_MS).toISOString(), myCursor: cursorOf(s, viewerId),
  };
}

function broadcast(s: Session) {
  for (const uid of s.members.keys()) events.toUser(uid, { type: 'match.state', session: stateFor(s, uid) });
}

function endSession(s: Session, reason: 'host' | 'expired') {
  s.ended = true;
  sessions.delete(s.id);
  for (const uid of s.members.keys()) events.toUser(uid, { type: 'match.ended', sessionId: s.id, reason });
}

/** Drop expired sessions; announce members coming online / going offline. */
export function sweepMatches(now = Date.now()) {
  for (const s of [...sessions.values()]) {
    if (now - s.touchedAt > MATCH_TTL_MS) {
      endSession(s, 'expired');
      continue;
    }
    const sig = [...s.members.keys()].map((u) => (isOnline(u) ? '1' : '0')).join('') + (hostDeviceOnline(s) ? 'h' : '');
    if (sig !== s.onlineSig) {
      s.onlineSig = sig;
      broadcast(s);
    }
  }
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(() => sweepMatches(), 5000);
  timer.unref?.();
}

function getSession(id: string): Session {
  const s = sessions.get(id);
  if (!s || s.ended || Date.now() - s.touchedAt > MATCH_TTL_MS) {
    if (s) endSession(s, 'expired');
    throw notFound('This match session has ended');
  }
  return s;
}

function memberSession(user: User, id: string): Session {
  const s = getSession(id);
  if (!s.members.has(user.id)) throw forbidden('Join the session first');
  s.touchedAt = Date.now();
  return s;
}

const memberRec = (u: User): MemberRec => ({ userId: u.id, displayName: u.displayName, avatarUrl: u.avatarUrl ?? null, joinedAt: Date.now() });

export function createMatch(user: User, device: { rowId?: string | null; name?: string | null } | null, req?: CreateMatchRequest & { seed?: number }): MatchSessionState {
  ensureTimer();
  if (sessions.size >= MAX_SESSIONS) throw conflict('Too many match sessions are running, try again later');
  const mine = [...sessions.values()].filter((s) => s.hostUserId === user.id).sort((a, b) => a.touchedAt - b.touchedAt);
  while (mine.length >= MAX_PER_HOST) endSession(mine.shift()!, 'host');
  const settings = normalizeSettings(req);
  const seeded = typeof req?.seed === 'number';
  const rng = rngFor(seeded ? req!.seed : null);
  const s: Session = {
    id: newId(), code: newCode(), hostUserId: user.id,
    hostDeviceRowId: device?.rowId && !device.rowId.startsWith('apikey:') ? device.rowId : null, hostDeviceName: device?.name ?? null,
    settings, members: new Map([[user.id, memberRec(user)]]), deck: [], votes: new Map(), matched: new Map(), ended: false,
    touchedAt: Date.now(), rng, onlineSig: '',
  };
  s.deck = buildDeck([user], settings, [], DECK_SIZE, rng, seeded);
  sessions.set(s.id, s);
  return stateFor(s, user.id);
}

/** Remove deck cards the current group may no longer see (or has watched), then top the deck back up. */
function reconcileDeck(s: Session) {
  const users = memberUsers(s);
  if (!users.length || !s.deck.length) return;
  const ok = new Set(pool(users, s.settings, [], true, s.deck).map((r) => r.id));
  const removed = s.deck.filter((id) => !ok.has(id));
  if (removed.length) {
    s.deck = s.deck.filter((id) => ok.has(id));
    for (const id of removed) {
      s.votes.delete(id);
      s.matched.delete(id);
    }
  }
  topUp(s);
}

function topUp(s: Session, force = false) {
  const furthest = Math.max(0, ...[...s.members.keys()].map((u) => cursorOf(s, u)));
  if (!force && s.deck.length - furthest > 10) return;
  if (s.deck.length >= DECK_MAX) return;
  const more = buildDeck(memberUsers(s), s.settings, s.deck, Math.min(DECK_EXTEND, DECK_MAX - s.deck.length), s.rng);
  s.deck.push(...more);
}

/** Re-check every voted card (after someone leaves, the rest may now all agree). */
function evaluateAll(s: Session): MatchResult[] {
  const found: MatchResult[] = [];
  for (const id of s.deck) {
    if (s.matched.has(id) || !s.votes.has(id)) continue;
    const r = evaluate(s, id);
    if (r) found.push(r);
  }
  return found;
}

function evaluate(s: Session, itemId: string): MatchResult | null {
  if (s.matched.has(itemId)) return null;
  const v = [...(s.votes.get(itemId)?.entries() ?? [])].filter(([u]) => s.members.has(u)).map(([, x]) => x);
  if (!isMatch(s.settings.rule, s.members.size, v)) return null;
  s.matched.set(itemId, new Date().toISOString());
  return resultFor(s, itemId);
}

function announce(s: Session, found: MatchResult[]) {
  for (const m of found) for (const uid of s.members.keys()) events.toUser(uid, { type: 'match.found', sessionId: s.id, match: m });
}

export function joinMatch(user: User, code: string): MatchSessionState {
  const c = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const s = [...sessions.values()].find((x) => x.code === c && !x.ended);
  if (!s) throw notFound('No match session with that code');
  getSession(s.id);
  s.touchedAt = Date.now();
  if (!s.members.has(user.id)) {
    if (s.members.size >= MAX_MEMBERS) throw conflict('This session is full');
    s.members.set(user.id, memberRec(user));
    reconcileDeck(s);
  }
  broadcast(s);
  return stateFor(s, user.id);
}

export function getMatch(user: User, id: string): MatchSessionState {
  return stateFor(memberSession(user, id), user.id);
}

export function leaveMatch(user: User, id: string) {
  const s = memberSession(user, id);
  if (user.id === s.hostUserId) return endSession(s, 'host');
  s.members.delete(user.id);
  for (const v of s.votes.values()) v.delete(user.id);
  const found = evaluateAll(s);
  broadcast(s);
  announce(s, found);
}

export function endMatch(user: User, id: string) {
  const s = memberSession(user, id);
  if (s.hostUserId !== user.id) throw forbidden('Only the host can end the session');
  endSession(s, 'host');
}

export function matchDeck(user: User, id: string, offset = 0, limit = 20): MatchDeckResponse {
  const s = memberSession(user, id);
  const from = Math.max(0, Math.min(s.deck.length, Math.floor(offset) || 0));
  const ids = s.deck.slice(from, from + Math.max(1, Math.min(60, Math.floor(limit) || 20)));
  const cards = itemsByIds(user, ids);
  const myVotes: Record<string, MatchVote> = {};
  for (const i of ids) {
    const v = s.votes.get(i)?.get(user.id);
    if (v) myVotes[i] = v;
  }
  return { offset: from, total: s.deck.length, cards, myVotes };
}

export function voteMatch(user: User, id: string, itemId: string, vote: MatchVote): { state: MatchSessionState; match: MatchResult | null } {
  const s = memberSession(user, id);
  if (!['yes', 'no', 'super'].includes(vote)) throw badRequest('vote must be yes, no or super');
  if (!s.deck.includes(itemId)) throw badRequest('That card is not in this deck');
  let v = s.votes.get(itemId);
  if (!v) s.votes.set(itemId, (v = new Map()));
  v.set(user.id, vote);
  const found = evaluate(s, itemId);
  topUp(s);
  broadcast(s);
  if (found) announce(s, [found]);
  return { state: stateFor(s, user.id), match: found };
}

export function extendMatch(user: User, id: string): MatchSessionState {
  const s = memberSession(user, id);
  topUp(s, true);
  broadcast(s);
  return stateFor(s, user.id);
}

export function matchResults(user: User, id: string): MatchResult[] {
  return stateFor(memberSession(user, id), user.id).matches;
}

/** "Play on…" the device that hosts the session (e.g. the living-room TV). Only matched titles can be started. */
export function playOnHost(user: User, id: string, itemId: string, fromDeviceName: string): { deviceName: string } {
  const s = memberSession(user, id);
  if (!s.matched.has(itemId)) throw badRequest('Only a match can be played on the host');
  const targets = events.clients().filter((c) => c.deviceRowId === s.hostDeviceRowId && c.userId === s.hostUserId);
  if (!s.hostDeviceRowId || !targets.length) throw conflict('The host device is not online');
  for (const t of targets) t.send({ type: 'remote.command', fromDeviceName, action: 'playItem', itemId });
  return { deviceName: s.hostDeviceName ?? targets[0].deviceName };
}
