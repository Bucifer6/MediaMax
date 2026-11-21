import { useEffect } from 'react';
import { isCalm } from '../theme/fx';

/**
 * Light-catch and tilt for poster cards: one delegated pointer listener for the whole app (no per-card handlers)
 * writes the pointer position over the hovered card's artwork into --mx / --my (0…1); CSS turns that into a gentle
 * 3D tilt and a moving sheen (styles/lumen.css). Mouse only, and off in lite mode / reduced motion.
 */
export function useCardLight() {
  useEffect(() => {
    let current: HTMLElement | null = null;
    let raf = 0;
    let x = 0.5;
    let y = 0.5;
    const reset = () => {
      if (!current) return;
      current.style.removeProperty('--mx');
      current.style.removeProperty('--my');
      current.classList.remove('lit');
      current = null;
    };
    const onMove = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse') return;
      const art = (e.target as Element | null)?.closest?.('.card-art') as HTMLElement | null;
      if (art !== current) reset();
      if (!art || isCalm()) return;
      const r = art.getBoundingClientRect();
      x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
      current = art;
      if (!raf) {
        raf = requestAnimationFrame(() => {
          raf = 0;
          if (!current) return;
          current.style.setProperty('--mx', x.toFixed(3));
          current.style.setProperty('--my', y.toFixed(3));
          current.classList.add('lit');
        });
      }
    };
    document.addEventListener('pointermove', onMove, { passive: true });
    document.addEventListener('pointerleave', reset);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerleave', reset);
      cancelAnimationFrame(raf);
      reset();
    };
  }, []);
}
