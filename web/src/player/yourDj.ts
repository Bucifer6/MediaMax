/**
 * Your DJ: a personal set from the listener's own library in themed segments ("On repeat", "Throwbacks"…), with a
 * reason label per track, a "Switch it up" button and typed requests. The server picks the music
 * (POST /dj/session …); this is the client's pure state (no DOM), unit-tested in Node. The player (music.tsx) plays
 * the tracks through Automix like any other mix.
 */
import type { Item } from '@mediamax/shared';
import type { DjRequestResult, DjSegment, DjSegmentKind, DjSession } from './djTypes';

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

/** Home: rows that come before the Your DJ card by default ("what am I watching / listening to"). */
const DJ_AFTER = new Set(['continue', 'nextup']);
const rowBase = (id: string) => id.split(':')[0]!;

/**
 * Where the Your DJ card sits among the Home rows (an index into `rows`: the card goes before that row, or after the
 * last one when it equals rows.length); -1 = the profile hid it with Customize Home. With a saved order, its saved
 * place; otherwise right below Continue Watching / Listening and Next Up.
 */
export function placeYourDj(rows: { id: string; type: string }[], order: string[], hidden: string[], id = 'your-dj'): number {
  if (hidden.includes(id)) return -1;
  const k = order.indexOf(id);
  if (k >= 0) {
    const rank = (r: { id: string }) => {
      const a = order.indexOf(r.id);
      return a >= 0 ? a : order.indexOf(rowBase(r.id));
    };
    const i = rows.findIndex((r) => {
      const x = rank(r);
      return x < 0 || x > k;
    });
    return i < 0 ? rows.length : i;
  }
  let i = 0;
  while (i < rows.length && (DJ_AFTER.has(rows[i]!.type) || /listen/i.test(rows[i]!.id))) i++;
  return i;
}
