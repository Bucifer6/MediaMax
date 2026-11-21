import { lazy, Suspense, useEffect, useSyncExternalStore, type FocusEvent, type MouseEvent } from 'react';
import { createPortal } from 'react-dom';
import type { Item } from '@mediamax/shared';

// The expanded card itself is fetched on the first peek (keeps it out of the main bundle).
const PeekCard = lazy(() => import('./PeekCard'));

/**
 * "Peek" cards: dwell on a poster (mouse hover, or D-pad focus on a TV) and an expanded card grows out of it with
 * the backdrop (and trailer, where enabled), logo or title, year · runtime · rating, progress and quick actions.
 * It is drawn in a portal over the page, so rows never reflow; it closes when the pointer / focus leaves or the
 * page scrolls. One peek at a time, owned by <PeekLayer/> in Layout.
 */

const PEEK_TYPES = new Set(['movie', 'show', 'episode', 'video', 'season']);
const DWELL_MOUSE = 650;
const DWELL_FOCUS = 1100;

export type Peek = { item: Item; el: HTMLElement; via: 'mouse' | 'focus' } | null;
let state: Peek = null;
let timer = 0;
let closeTimer = 0;
const listeners = new Set<() => void>();
const emit = (p: Peek) => {
  state = p;
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

export function closePeek() {
  window.clearTimeout(timer);
  window.clearTimeout(closeTimer);
  if (!state) return;
  // Focus inside the peek (a TV remote) goes back to its card rather than being lost.
  const card = state.el;
  const hadFocus = !!document.activeElement?.closest('.peek');
  emit(null);
  if (hadFocus && card.isConnected) card.focus({ preventScroll: true });
}

function intent(item: Item, el: HTMLElement, via: 'mouse' | 'focus') {
  window.clearTimeout(timer);
  window.clearTimeout(closeTimer);
  if (state && state.el !== el) emit(null);
  timer = window.setTimeout(() => {
    if (el.isConnected) emit({ item, el, via });
  }, via === 'mouse' ? DWELL_MOUSE : DWELL_FOCUS);
}

/** Keep the peek open (the pointer moved from the card onto it). */
export const cancelClose = () => window.clearTimeout(closeTimer);

export function leave(el: HTMLElement, delay = 140) {
  window.clearTimeout(timer);
  if (!state || state.el !== el) return;
  window.clearTimeout(closeTimer);
  closeTimer = window.setTimeout(() => emit(null), delay);
}

const canHover = () => !!window.matchMedia?.('(hover: hover) and (pointer: fine)').matches;
export const isTv = () => document.documentElement.classList.contains('tv');

/** Props to spread on a card's root element. Empty for items that have nothing worth peeking at. */
export function peekHandlers(item: Item) {
  if (!PEEK_TYPES.has(item.type)) return {};
  return {
    onMouseEnter: (e: MouseEvent<HTMLElement>) => {
      if (canHover()) intent(item, e.currentTarget, 'mouse');
    },
    onMouseLeave: (e: MouseEvent<HTMLElement>) => leave(e.currentTarget),
    onFocus: (e: FocusEvent<HTMLElement>) => {
      // TV remotes (D-pad focus) and keyboard users; a mouse click's focus doesn't count.
      if (e.currentTarget === e.target && (isTv() || e.currentTarget.matches(':focus-visible'))) intent(item, e.currentTarget, 'focus');
    },
    onBlur: (e: FocusEvent<HTMLElement>) => {
      const to = e.relatedTarget as Node | null;
      if (to && document.querySelector('.peek')?.contains(to)) return;
      leave(e.currentTarget, 60);
    },
  };
}

export function PeekLayer() {
  const peek = useSyncExternalStore(subscribe, () => state);
  useEffect(() => {
    if (!peek) return;
    const close = () => closePeek();
    // Any scroll (page or a row) moves the card from under the peek.
    window.addEventListener('scroll', close, { capture: true, passive: true });
    window.addEventListener('resize', close);
    const key = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('scroll', close, { capture: true });
      window.removeEventListener('resize', close);
      window.removeEventListener('keydown', key);
    };
  }, [peek]);
  // Close when the route changes under it (the card unmounts).
  useEffect(() => {
    if (!peek) return;
    const t = window.setInterval(() => !peek.el.isConnected && closePeek(), 400);
    return () => window.clearInterval(t);
  }, [peek]);
  if (!peek) return null;
  return createPortal(<Suspense fallback={null}><PeekCard key={peek.item.id} peek={peek} /></Suspense>, document.body);
}

