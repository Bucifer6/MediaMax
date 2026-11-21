import type { RemoteKey, TrickplayInfo } from '@mediamax/shared';

/** Movement (px) below which a touch counts as a tap. */
export const TAP_SLOP = 14;
/** Distance (px) of finger travel that emits one D-pad step while swiping (hold and keep moving to repeat). */
export const SWIPE_STEP = 64;

/** A finished touch → OK (tap) or a D-pad direction (swipe), or null (a slow, long press). */
export function classifyGesture(dx: number, dy: number, ms: number): RemoteKey | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  if (ax < TAP_SLOP && ay < TAP_SLOP) return ms < 600 ? 'ok' : null;
  if (Math.max(ax, ay) < 28) return null;
  return ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}

/** Steps to emit while the finger is still moving: whole SWIPE_STEPs along the dominant axis since the last emit. */
export function swipeSteps(dx: number, dy: number): { key: RemoteKey; n: number } | null {
  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  const n = Math.floor(Math.max(ax, ay) / SWIPE_STEP);
  if (!n) return null;
  return { key: ax > ay ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'), n };
}

/** What to send to the TV's text field when the phone's keyboard field changes from `prev` to `next`. */
export function textDiff(prev: string, next: string): { backspaces: number; text: string } {
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  return { backspaces: prev.length - i, text: next.slice(i) };
}

/** Where the thumbnail for `ms` is in the trickplay sprite sheets (CSS background values). */
export function trickplayTile(tp: TrickplayInfo, ms: number): { url: string; x: number; y: number; w: number; h: number } | null {
  if (!tp.count || !tp.sheets.length) return null;
  const idx = Math.max(0, Math.min(tp.count - 1, Math.floor(ms / tp.intervalMs)));
  const perSheet = tp.columns * tp.rows;
  const sheet = Math.floor(idx / perSheet);
  const within = idx % perSheet;
  const url = tp.sheets[sheet];
  if (!url) return null;
  return { url, x: (within % tp.columns) * tp.width, y: Math.floor(within / tp.columns) * tp.height, w: tp.width, h: tp.height };
}

/** The TV's position now, from its last report (it reports on change and every ~10 s while playing). */
export function estimatePosition(state: { positionMs: number; paused: boolean; durationMs: number | null } | null, receivedAt: number, now = Date.now()): number {
  if (!state) return 0;
  const p = state.positionMs + (state.paused ? 0 : Math.max(0, now - receivedAt));
  return state.durationMs ? Math.min(state.durationMs, p) : p;
}
