import type { MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import type { NavigateFunction } from 'react-router-dom';
import type { Item } from '@mediamax/shared';
import { isCalm } from '../theme/fx';

/** Name shared by the clicked poster and the title page's poster during a view transition. */
export const POSTER_VT = 'mm-poster';

type VtDocument = Document & { startViewTransition?: (cb: () => void) => { finished: Promise<void> } };

/**
 * Poster → title page as a shared-element transition (View Transitions API). The clicked poster and the detail
 * page's poster share a `view-transition-name`, so the browser morphs one into the other while the pages
 * cross-fade. The item rides along in history state so the title page can draw its poster and backdrop on the
 * first frame, before its own data arrives. Without support (TV browsers, Firefox), in lite mode or with reduced
 * motion, the link navigates normally and the title page fades in (styles/lumen.css).
 */
export function posterTransition(e: MouseEvent<HTMLElement>, navigate: NavigateFunction, to: string, item: Item) {
  const doc = document as VtDocument;
  if (!doc.startViewTransition || isCalm() || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const art = e.currentTarget.querySelector<HTMLElement>('.card-art');
  if (!art) return;
  e.preventDefault();
  art.style.setProperty('view-transition-name', POSTER_VT);
  document.documentElement.classList.add('vt-poster');
  const t = doc.startViewTransition(() => {
    art.style.removeProperty('view-transition-name');
    flushSync(() => navigate(to, { state: { preview: item } }));
  });
  void t.finished.finally(() => document.documentElement.classList.remove('vt-poster'));
}

/** The item a card handed over (see posterTransition), when it matches the page being opened. */
export function previewFromState(state: unknown, id: string): Item | null {
  const p = (state as { preview?: Item } | null)?.preview;
  return p && p.id === id ? p : null;
}
