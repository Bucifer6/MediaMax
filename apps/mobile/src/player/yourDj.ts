/**
 * Your DJ on the phone: a personal set from the listener's own library in themed segments, picked by the Vibe server
 * (POST /dj/session …) and played through Automix like any other mix (src/state/music.tsx). Mobile port of
 * web/src/player/yourDj.ts — keep the two in step.
 *
 * The phone is a thin client: no planning, templates or offline mode. When the server can't be reached (offline,
 * downloads only) or the admin switched the AI DJ off (DjStatus.ai / a 403), Your DJ is simply unavailable.
 *
 * Pure (no React Native imports): the reducer, queue helpers, availability and the small request helpers below take
 * an API object, so they are unit-tested in Node (tests/your-dj.test.mjs).
 */
import type { DjSegment, DjSegmentKind, DjSession, DjSessionRequestMiss, DjStatus, Item, UserPreferences, YourDjCommentary } from '../api/types';

export type DjRequestResult = DjSession | DjSessionRequestMiss;

/** Commentary preference. Defaults to 'intros' (as on the server and web) when nothing was saved. */
export function yourDjCommentary(prefs: Partial<UserPreferences> | null | undefined): YourDjCommentary {
  const c = prefs?.yourDj?.commentary;
  return c === 'off' || c === 'intros' || c === 'full' ? c : 'intros';
}

export type YourDjBusy = null | 'start' | 'switch' | 'request' | 'more';

export interface YourDjState {
  sessionId: string;
  /** Every segment this session has played, by id. */
  segments: Record<string, DjSegment>;
  /** Which segment each queued track came from. */
  itemSegment: Record<string, string>;
  /** Per-track reason ("big for you in 2019"). */
  reasons: Record<string, string>;
  /** The newest segment (what "Switch it up" switches away from). */
  segmentId: string;
  busy: YourDjBusy;
  /** A gentle line for the listener (request with no match, rules leaving little to choose from). Never an error. */
  message: string | null;
  /** Bumped when the set changes direction (switch / request), so the player jumps to the new segment. */
  turn: number;
}

export type YourDjAction =
  | { type: 'start'; session: DjSession }
  | { type: 'more'; session: DjSession }
  | { type: 'switch'; session: DjSession }
  | { type: 'request'; result: DjRequestResult }
  | { type: 'busy'; busy: YourDjBusy }
  | { type: 'dismiss' }
  | { type: 'end' };

export const isMiss = (r: DjRequestResult): r is { ok: false; message: string } => (r as { ok?: unknown }).ok === false && !('id' in r);

/** The gentle line when a request matches nothing (the server's message, or ours). */
export const NO_MATCH_FALLBACK = "I couldn't find that in your library within your play rules, so I'll keep this going.";

function absorb(s: YourDjState, session: DjSession, turn: boolean): YourDjState {
  const itemSegment = { ...s.itemSegment };
  for (const it of session.items) itemSegment[it.id] = session.segment.id;
  return {
    ...s,
    sessionId: session.id || s.sessionId,
    segments: { ...s.segments, [session.segment.id]: session.segment },
    itemSegment,
    reasons: { ...s.reasons, ...(session.reasons ?? {}) },
    segmentId: session.segment.id,
    busy: null,
    message: session.note ?? (turn ? null : s.message),
    turn: turn ? s.turn + 1 : s.turn,
  };
}

export function yourDjReducer(s: YourDjState | null, a: YourDjAction): YourDjState | null {
  switch (a.type) {
    case 'start': {
      const base: YourDjState = { sessionId: a.session.id, segments: {}, itemSegment: {}, reasons: {}, segmentId: a.session.segment.id, busy: null, message: null, turn: 0 };
      return absorb(base, a.session, false);
    }
    case 'end':
      return null;
    default:
      break;
  }
  if (!s) return s;
  switch (a.type) {
    case 'more':
      // More of the same (or the next segment, the server decides); no jump: it just queues up behind.
      return absorb(s, a.session, false);
    case 'switch':
      return absorb(s, a.session, true);
    case 'request':
      if (isMiss(a.result)) return { ...s, busy: null, message: a.result.message?.trim() || NO_MATCH_FALLBACK };
      return absorb(s, a.result, true);
    case 'busy':
      return { ...s, busy: a.busy, message: a.busy === 'request' || a.busy === 'switch' ? null : s.message };
    case 'dismiss':
      return { ...s, message: null };
  }
  return s;
}

const KIND_LABEL: Record<DjSegmentKind, string> = {
  'on-repeat': 'On repeat', throwbacks: 'Throwback', forgotten: 'Forgotten favourite', rare: 'Deep cut', recent: 'Just added',
  genre: 'Genre pick', decade: 'Decade pick', mood: 'Mood pick', request: 'Your request',
};
export const segmentKindLabel = (k: DjSegmentKind) => KIND_LABEL[k] ?? 'Your DJ';

/** The segment a track came from (null when it isn't one the DJ picked). */
export function segmentOf(s: YourDjState | null, itemId: string | null | undefined): DjSegment | null {
  if (!s || !itemId) return null;
  const id = s.itemSegment[itemId];
  return id ? s.segments[id] ?? null : null;
}

/** "Throwback · big for you in 2019": the track's kind of pick and why. */
export function reasonLabel(s: YourDjState | null, itemId: string | null | undefined): string | null {
  const seg = segmentOf(s, itemId);
  if (!seg || !itemId) return null;
  const why = (s!.reasons[itemId] || seg.reason || '').trim();
  const kind = segmentKindLabel(seg.kind);
  if (!why) return kind;
  // Don't repeat the kind when the reason already starts with it.
  return why.toLowerCase().startsWith(kind.toLowerCase()) ? why : `${kind} · ${why.charAt(0).toLowerCase()}${why.slice(1)}`;
}

/** Tracks the session played or queued (sent as `history`: never repeated, the last one is mixed out of). */
export function sessionHistory(queue: Item[], index: number, limit = 500): string[] {
  return queue.slice(0, Math.max(0, index + 1)).map((q) => q.id).slice(-limit);
}

/** Queue after "more": the new tracks go after everything queued (no duplicates). */
export function appendTracks(queue: Item[], items: Item[]): Item[] {
  const seen = new Set(queue.map((q) => q.id));
  return [...queue, ...items.filter((t) => !seen.has(t.id) && (seen.add(t.id), true))];
}

/**
 * Queue after a switch / request: the current track keeps playing, the new segment replaces what was coming up, so
 * the very next track is the new direction. Tracks already played aren't repeated.
 */
export function switchQueue(queue: Item[], index: number, items: Item[]): Item[] {
  const head = queue.slice(0, Math.max(0, index + 1));
  const played = new Set(head.map((q) => q.id));
  const fresh = items.filter((t) => !played.has(t.id) && (played.add(t.id), true));
  return fresh.length ? [...head, ...fresh] : queue;
}

/** Short spoken / captioned acknowledgement for the DJ button (used when the server sends no intro). */
export function switchAck(seg: DjSegment): string {
  return `Switching it up. ${seg.title}${seg.reason ? `: ${seg.reason.replace(/\.$/, '')}` : ''}.`;
}


/* ------------------------------------------------------------------ availability */

export interface DjAvailabilityInput {
  /** Signed in to a reachable server (not the offline / downloads-only mode). */
  signedIn: boolean;
  /** The device has a network connection. */
  online: boolean;
  /** GET /dj/status (null = not known yet / failed). */
  status: DjStatus | null;
  /** The server answered 403 to /dj/session or /dj/break (AI DJ switched off). */
  forbidden: boolean;
  /** The server has a music library this profile can see. */
  hasMusic: boolean;
}

/** Can Your DJ start? `note` is a short line for the (disabled) card; `hidden` = don't show the card at all. */
export function yourDjAvailability(i: DjAvailabilityInput): { available: boolean; hidden: boolean; note: string | null } {
  if (!i.hasMusic) return { available: false, hidden: true, note: null };
  if (!i.signedIn || !i.online) return { available: false, hidden: false, note: 'Needs a connection to your Vibe server.' };
  if (i.forbidden || i.status?.ai?.enabled === false || i.status?.ai?.yourDj === false) return { available: false, hidden: true, note: null };
  if (!i.status) return { available: false, hidden: false, note: 'Checking your server…' };
  return { available: true, hidden: false, note: null };
}

/** The AI DJ endpoints are usable (the server said so, and didn't answer 403 since). */
export function aiDjOn(i: Omit<DjAvailabilityInput, 'hasMusic'>): boolean {
  return i.signedIn && i.online && !i.forbidden && !!i.status && i.status.ai?.enabled !== false;
}

/* ------------------------------------------------------------------ server calls */

/** What these helpers need from the API client (src/api/client.ts). */
export interface YourDjApi {
  djSession(body: { presetId?: string; hour?: number }): Promise<DjSession>;
  djSessionMore(id: string, body: { history: string[]; hour?: number }): Promise<DjSession>;
  djSessionSwitch(id: string, body: { history: string[]; hour?: number }): Promise<DjSession>;
  djSessionRequest(id: string, body: { text: string; history: string[]; hour?: number }): Promise<DjRequestResult>;
}

const statusOf = (e: unknown) => (e as { status?: number } | null)?.status;
export const isForbidden = (e: unknown) => statusOf(e) === 403;

/** Start a session (null without asking when Your DJ isn't available). Throws on failure (403 = AI DJ off). */
export async function startSession(api: YourDjApi | null, available: boolean, presetId: string | undefined, hour = new Date().getHours()): Promise<DjSession | null> {
  if (!api || !available) return null;
  return api.djSession(presetId ? { presetId, hour } : { hour });
}

/** The next batch; a session the server forgot (404, 6 h idle / restart) quietly starts afresh with the same rules. */
export async function moreOrRestart(api: YourDjApi, sessionId: string, history: string[], presetId: string | undefined, hour = new Date().getHours()): Promise<DjSession> {
  try {
    return await api.djSessionMore(sessionId, { history, hour });
  } catch (e) {
    if (statusOf(e) !== 404) throw e;
    return api.djSession(presetId ? { presetId, hour } : { hour });
  }
}

/** A typed request. Never throws: a failure is a gentle "couldn't line that up" miss (the set carries on). */
export async function requestOrMiss(api: YourDjApi, sessionId: string, text: string, history: string[], hour = new Date().getHours()): Promise<DjRequestResult> {
  try {
    const r = await api.djSessionRequest(sessionId, { text, history, hour });
    if (!r || typeof r !== 'object') return { ok: false, message: NO_MATCH_FALLBACK };
    return r;
  } catch {
    return { ok: false, message: "I couldn't line that up just now, so I'll keep this going." };
  }
}

/** Skipped this early counts as "not for me" (POST /dj/feedback skip). */
export const SKIP_FEEDBACK_MS = 30000;
export function isEarlySkip(positionMs: number, durationMs: number): boolean {
  return positionMs < SKIP_FEEDBACK_MS && (!durationMs || positionMs < durationMs - 3000);
}
