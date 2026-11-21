/**
 * Pure helpers for Movie Match, Roulette and the Random marathon / sleep timer (no DOM, unit-tested in
 * web/test/decide.test.ts).
 */
import type { MatchVote, RouletteFilters, StillWatchingSettings } from '@mediamax/shared';

/* ------------------------------- swipe ------------------------------- */

export interface SwipeInput {
  dx: number;
  dy: number;
  /** px/ms at release */
  vx: number;
  vy: number;
  width: number;
}

/**
 * Turn a released drag into a vote: far or fast enough to the right = yes, left = no, up = super like.
 * Returns null to spring the card back.
 */
export function swipeVote({ dx, dy, vx, vy, width }: SwipeInput): MatchVote | null {
  const far = Math.max(80, width * 0.28);
  const flick = 0.55;
  if (-dy > far * 0.9 && Math.abs(dy) > Math.abs(dx) * 1.2) return 'super';
  if (vy < -flick && Math.abs(vy) > Math.abs(vx) && -dy > 30) return 'super';
  if (dx > far || (vx > flick && dx > 30)) return 'yes';
  if (dx < -far || (vx < -flick && dx < -30)) return 'no';
  return null;
}

/** Card transform while dragging: a little rotation, like a real card pivoting under the finger. */
export function dragTransform(dx: number, dy: number, width: number): string {
  const rot = Math.max(-18, Math.min(18, (dx / Math.max(1, width)) * 22));
  return `translate3d(${dx.toFixed(1)}px, ${dy.toFixed(1)}px, 0) rotate(${rot.toFixed(2)}deg)`;
}

/** Which stamp (and how strongly) to show while dragging. */
export function dragHint(dx: number, dy: number, width: number): { vote: MatchVote | null; strength: number } {
  const far = Math.max(80, width * 0.28);
  if (-dy > Math.abs(dx) && dy < 0) return { vote: 'super', strength: Math.min(1, -dy / far) };
  if (dx === 0) return { vote: null, strength: 0 };
  return { vote: dx > 0 ? 'yes' : 'no', strength: Math.min(1, Math.abs(dx) / far) };
}

/** Where a card flies off to for a vote (fly-out animation target). */
export function flyOut(vote: MatchVote, width: number, height: number): { x: number; y: number; rot: number } {
  if (vote === 'super') return { x: 0, y: -height * 1.3, rot: 0 };
  return { x: (vote === 'yes' ? 1 : -1) * width * 1.5, y: 40, rot: vote === 'yes' ? 24 : -24 };
}

/** Keyboard / D-pad → vote. */
export function keyVote(key: string): MatchVote | null {
  if (key === 'ArrowRight') return 'yes';
  if (key === 'ArrowLeft') return 'no';
  if (key === 'ArrowUp') return 'super';
  return null;
}

/** Normalise a typed join code: upper case, unambiguous alphabet only, max 6. */
export const normalizeCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/[O0I1]/g, '').slice(0, 6);

/** The link a phone opens to join (also encoded in the QR code). */
export const joinUrl = (origin: string, code: string) => `${origin.replace(/\/$/, '')}/match/join/${encodeURIComponent(code)}`;

/* ------------------------------- reel -------------------------------- */

export interface ReelPlan {
  /** Poster ids in reel order (the pick sits at `targetIndex`). */
  order: string[];
  targetIndex: number;
  /** Final translateX (negative px) that centres the pick in a viewport of `viewport` px. */
  finalX: number;
}

/**
 * Lay out the roulette reel: decoys repeated to make a long strip, the pick placed near the end, and the final
 * offset that centres it. `jitter` (0..1) nudges the stop point within the card so it feels mechanical.
 */
export function planReel(pickId: string, decoyIds: string[], opts: { cardW: number; gap: number; viewport: number; laps?: number; jitter?: number }): ReelPlan {
  const laps = Math.max(1, opts.laps ?? 3);
  const pool = decoyIds.filter((d) => d !== pickId);
  const filler = pool.length ? pool : [pickId];
  const order: string[] = [];
  const total = Math.max(24, filler.length * laps);
  for (let i = 0; i < total; i++) order.push(filler[i % filler.length]);
  const targetIndex = order.length;
  order.push(pickId);
  // A few cards after the pick so the strip never ends in empty space.
  for (let i = 0; i < 4; i++) order.push(filler[(total + i) % filler.length]);
  const step = opts.cardW + opts.gap;
  const jitter = Math.max(-0.35, Math.min(0.35, ((opts.jitter ?? 0.5) - 0.5) * 0.7));
  const finalX = -(targetIndex * step + opts.cardW / 2 - opts.viewport / 2 + jitter * opts.cardW);
  return { order, targetIndex, finalX: Math.round(finalX) };
}

/** Ease for the reel: quick acceleration, long deceleration (ease-out quint with a short ease-in). */
export function reelEase(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  if (x < 0.12) return 0.5 * (x / 0.12) ** 2 * 0.12;
  const u = (x - 0.12) / 0.88;
  return 0.06 + 0.94 * (1 - (1 - u) ** 5);
}

/* ---------------------------- marathon ------------------------------- */

export const DEFAULT_STILL_WATCHING: StillWatchingSettings = { enabled: true, afterItems: 2, afterMinutes: 240 };

/** Mirror of the server rule (services/decide/marathon.ts): ask after N titles or N minutes with no input. */
export function stillWatchingDue(s: StillWatchingSettings, itemsSinceInput: number, msSinceInput: number): boolean {
  if (!s.enabled) return false;
  return itemsSinceInput >= s.afterItems || msSinceInput >= s.afterMinutes * 60_000;
}

/** Sleep timer choices. 'end' = end of this title; 'items:N' = after N titles. */
export type SleepChoice = { kind: 'minutes'; minutes: number } | { kind: 'end' } | { kind: 'items'; count: number };

export const SLEEP_FADE_MS = 30_000;

/** Volume multiplier during the final fade (1 → 0 over SLEEP_FADE_MS before the stop time). */
export function fadeFactor(msLeft: number, fadeMs = SLEEP_FADE_MS): number {
  if (msLeft >= fadeMs) return 1;
  if (msLeft <= 0) return 0;
  return msLeft / fadeMs;
}

/** Milliseconds until the sleep timer stops playback (null when it waits for a title boundary instead). */
export function sleepMsLeft(choice: SleepChoice, startedAt: number, now: number, titleRemainingMs: number | null): number | null {
  if (choice.kind === 'minutes') return Math.max(0, startedAt + choice.minutes * 60_000 - now);
  if (choice.kind === 'end') return titleRemainingMs == null ? null : Math.max(0, titleRemainingMs);
  return null;
}

/* --------------------------- filters (URL) --------------------------- */

/** Roulette filters ↔ URL search params (shareable / back-button friendly). */
export function filtersToParams(f: RouletteFilters): URLSearchParams {
  const p = new URLSearchParams();
  p.set('kind', f.kind);
  if (f.libraryIds?.length) p.set('lib', f.libraryIds.join(','));
  if (f.genres?.length) p.set('genre', f.genres.join(','));
  if (f.maxRuntimeMin) p.set('max', String(f.maxRuntimeMin));
  if (f.decade) p.set('decade', String(f.decade));
  if (f.minRating) p.set('rating', String(f.minRating));
  if (f.unwatchedOnly) p.set('unwatched', '1');
  if (f.fromMyList) p.set('mylist', '1');
  if (f.mood) p.set('mood', f.mood);
  if (f.weighted === false) p.set('weighted', '0');
  if (f.randomEpisode) p.set('randomEp', '1');
  return p;
}

export function paramsToFilters(p: URLSearchParams): RouletteFilters {
  const list = (k: string) => (p.get(k) ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const num = (k: string) => {
    const n = Number(p.get(k));
    return p.get(k) && Number.isFinite(n) && n > 0 ? n : null;
  };
  const mood = p.get('mood');
  return {
    kind: p.get('kind') === 'series' ? 'series' : 'movie',
    libraryIds: list('lib'),
    genres: list('genre'),
    maxRuntimeMin: num('max'),
    decade: num('decade'),
    minRating: num('rating'),
    unwatchedOnly: p.get('unwatched') === '1',
    fromMyList: p.get('mylist') === '1',
    mood: mood && ['feel-good', 'edge', 'mind-bending', 'laugh', 'family', 'short'].includes(mood) ? (mood as RouletteFilters['mood']) : null,
    weighted: p.get('weighted') !== '0',
    randomEpisode: p.get('randomEp') === '1',
  };
}

/** YouTube watch/short links → privacy-friendly embed URL (other trailer URLs are played directly). */
export function trailerEmbed(url: string): { kind: 'youtube' | 'video'; src: string } {
  const m = url.match(/(?:v=|youtu\.be\/|embed\/)([\w-]{6,})/);
  return /youtube\.com|youtu\.be/.test(url) && m ? { kind: 'youtube', src: `https://www.youtube-nocookie.com/embed/${m[1]}?autoplay=1` } : { kind: 'video', src: url };
}

/** Marathon id carried in the player URL (`/play/:id?marathon=…`). */
export const marathonPlayLink = (itemId: string, marathonId: string) => `/play/${encodeURIComponent(itemId)}?start=0&marathon=${encodeURIComponent(marathonId)}`;
