/**
 * Watch-together timing shared by the server and every player: server clock offset from ping round trips, the room's
 * expected position, and gentle drift correction (a small playback-rate change instead of a hard seek).
 * Pure TypeScript, no imports, no DOM.
 *
 * The canonical copy lives in shared/src/syncClock.ts; `node scripts/sync-types.mjs` copies it verbatim to
 * server/src/services/syncClock.ts, web/src/player/syncClock.ts and apps/mobile/src/player/syncClock.ts.
 */

export interface ClockSample {
  /** Client clock when the ping was sent (ms). */
  sentAt: number;
  /** Server clock in the reply (ms). */
  serverAt: number;
  /** Client clock when the reply arrived (ms). */
  receivedAt: number;
}

/**
 * Server time minus client time (ms), from the samples with the shortest round trips (they have the least queueing
 * delay). Assumes the reply took half the round trip. null without usable samples.
 */
export function clockOffset(samples: ClockSample[]): number | null {
  const ok = samples.filter((s) => s.receivedAt >= s.sentAt && s.receivedAt - s.sentAt < 5000);
  if (!ok.length) return null;
  const best = [...ok].sort((a, b) => (a.receivedAt - a.sentAt) - (b.receivedAt - b.sentAt)).slice(0, Math.max(1, Math.ceil(ok.length / 3)));
  const offsets = best.map((s) => s.serverAt - (s.sentAt + (s.receivedAt - s.sentAt) / 2)).sort((a, b) => a - b);
  return Math.round(offsets[Math.floor(offsets.length / 2)]);
}

export interface RoomClock {
  state: 'playing' | 'paused';
  positionMs: number;
  /** Server time of the last change (ms). */
  updatedAt: number;
  /** Someone is buffering: the room's clock is held. */
  waiting?: boolean;
}

/** Where the room is now (ms into the title), given the client's offset to the server clock. */
export function expectedPosition(room: RoomClock, clientNow: number, offsetMs: number): number {
  if (room.state !== 'playing' || room.waiting) return room.positionMs;
  const serverNow = clientNow + offsetMs;
  return room.positionMs + Math.max(0, serverNow - room.updatedAt);
}

/** Drift bands: inside DEAD nothing happens; up to SEEK the rate is nudged; beyond it a seek is the only fix. */
export const DRIFT_DEAD_MS = 120;
export const DRIFT_SEEK_MS = 2500;
const MAX_RATE_DELTA = 0.05;

/**
 * What to do about drift (local − expected, ms; positive = ahead of the room): keep 1×, play slightly slower or
 * faster (at most ±5 %, closing the gap in roughly ten seconds), or seek.
 */
export function driftCorrection(driftMs: number): { kind: 'none'; rate: 1 } | { kind: 'rate'; rate: number } | { kind: 'seek' } {
  const a = Math.abs(driftMs);
  if (!Number.isFinite(driftMs) || a < DRIFT_DEAD_MS) return { kind: 'none', rate: 1 };
  if (a > DRIFT_SEEK_MS) return { kind: 'seek' };
  const delta = Math.min(MAX_RATE_DELTA, a / 10000);
  return { kind: 'rate', rate: Math.round((driftMs > 0 ? 1 - delta : 1 + delta) * 1000) / 1000 };
}
