import { useEffect } from 'react';
import { isTypingTarget } from './index';

const FOCUSABLE = 'a[href], button:not([disabled]), [data-nav], [tabindex]:not([tabindex="-1"])';

function visible(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Lightweight spatial (D-pad / arrow key) navigation for TV remotes and keyboards.
 * Only acts when focus is already on an element marked with `data-nav`, so it
 * never interferes with normal page scrolling or form controls.
 */
export function useSpatialNav(enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
      const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
      const d = dirs[e.key];
      if (!d) return;
      const cur = document.activeElement as HTMLElement | null;
      if (!cur || isTypingTarget(cur) || !cur.hasAttribute('data-nav')) return;
      if (cur.closest('.modal, .player, .guide-grid')) return;
      const scope = cur.closest('main, .rail') ?? document.body;
      const cr = cur.getBoundingClientRect();
      const cx = cr.left + cr.width / 2;
      const cy = cr.top + cr.height / 2;
      let best: HTMLElement | null = null;
      let bestScore = Infinity;
      scope.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
        if (el === cur || !visible(el)) return;
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const dx = x - cx;
        const dy = y - cy;
        const primary = d[0] ? dx * d[0] : dy * d[1];
        if (primary <= 4) return;
        const secondary = d[0] ? Math.abs(dy) : Math.abs(dx);
        const score = primary + secondary * 2.5;
        if (score < bestScore) {
          bestScore = score;
          best = el;
        }
      });
      if (best) {
        e.preventDefault();
        (best as HTMLElement).focus({ preventScroll: true });
        (best as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);
}

export { FOCUSABLE };
