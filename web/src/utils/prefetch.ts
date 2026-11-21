/**
 * Warm route chunks before they are needed, so the first click doesn't wait on the network and the parse.
 *
 * - The video player chunk loads when a play button is hovered or focused (anything marked `data-play`; the
 *   detail page's Play button is focused on open, so on TVs it loads as soon as a title is opened).
 * - A page chunk loads when a link to it is hovered or focused (a poster card → the title page).
 * - The pages people open next from Home (title detail, library, search) load once the browser is idle.
 *
 * The specifiers match App.tsx's lazy() imports, so the bundler serves the same chunks.
 */
const once = new Map<string, Promise<unknown>>();
function warm(key: string, load: () => Promise<unknown>) {
  if (once.has(key)) return;
  once.set(key, load().catch(() => once.delete(key)));
}

export const prefetchPlayer = () => warm('player', () => import('../player/VideoPlayer'));

export function prefetchCommonPages() {
  warm('item', () => import('../pages/ItemDetail'));
  warm('library', () => import('../pages/Library'));
  warm('search', () => import('../pages/Search'));
}

const idle = (fn: () => void) => {
  const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number };
  if (w.requestIdleCallback) w.requestIdleCallback(fn, { timeout: 4000 });
  else window.setTimeout(fn, 1500);
};

let installed = false;
export function installPrefetch() {
  if (installed) return;
  installed = true;
  const onIntent = (e: Event) => {
    const t = e.target as Element | null;
    if (!t || typeof t.closest !== 'function') return;
    if (t.closest('[data-play]')) prefetchPlayer();
    // Pointing at (or, on a TV, focusing) a link is a strong hint of the next page.
    const a = t.closest('a[href]');
    const href = a?.getAttribute('href') ?? '';
    if (href.startsWith('/item/')) warm('item', () => import('../pages/ItemDetail'));
    else if (href.startsWith('/library/')) warm('library', () => import('../pages/Library'));
    else if (href.startsWith('/search')) warm('search', () => import('../pages/Search'));
  };
  document.addEventListener('pointerover', onIntent, { passive: true });
  document.addEventListener('focusin', onIntent);
  // After the first screen has rendered and settled.
  if (document.readyState === 'complete') idle(prefetchCommonPages);
  else window.addEventListener('load', () => idle(prefetchCommonPages), { once: true });
}
