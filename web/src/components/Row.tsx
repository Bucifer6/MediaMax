import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type React from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

/**
 * Mouse drag-to-scroll with momentum for a horizontal row (touch and trackpads already have native momentum).
 * A drag past a few pixels swallows the click that ends it, so dragging over a poster doesn't open it.
 */
function useDragScroll(ref: React.RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let startX = 0;
    let startLeft = 0;
    let lastX = 0;
    let lastT = 0;
    let v = 0;
    let dragging = false;
    let moved = false;
    let raf = 0;
    const glide = () => {
      v *= 0.94;
      if (Math.abs(v) < 0.02) return;
      el.scrollLeft -= v * 16;
      raf = requestAnimationFrame(glide);
    };
    const down = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || e.button !== 0) return;
      cancelAnimationFrame(raf);
      dragging = true;
      moved = false;
      startX = lastX = e.clientX;
      startLeft = el.scrollLeft;
      lastT = performance.now();
      v = 0;
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) > 6) {
        moved = true;
        el.classList.add('dragging');
        el.setPointerCapture(e.pointerId);
      }
      if (!moved) return;
      const now = performance.now();
      v = (e.clientX - lastX) / Math.max(1, now - lastT);
      lastX = e.clientX;
      lastT = now;
      el.scrollLeft = startLeft - dx;
    };
    const up = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = false;
      el.classList.remove('dragging');
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
      if (moved) raf = requestAnimationFrame(glide);
    };
    const click = (e: MouseEvent) => {
      if (moved) {
        e.preventDefault();
        e.stopPropagation();
        moved = false;
      }
    };
    const noDrag = (e: DragEvent) => e.preventDefault();
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    el.addEventListener('click', click, true);
    el.addEventListener('dragstart', noDrag);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      el.removeEventListener('click', click, true);
      el.removeEventListener('dragstart', noDrag);
    };
  }, [ref]);
}

/** ←/→ move focus between the row's cards (TV mode has its own spatial navigation). */
function onRowKey(e: React.KeyboardEvent<HTMLDivElement>) {
  if ((e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') || e.altKey || e.metaKey || e.ctrlKey || document.documentElement.classList.contains('tv')) return;
  const scroller = e.currentTarget;
  const items = [...scroller.children].map((c) => (c.matches('a, button, [tabindex]') ? c : c.querySelector('a[href], button, [tabindex]:not([tabindex="-1"])'))).filter(Boolean) as HTMLElement[];
  const i = items.findIndex((el) => el === document.activeElement || el.contains(document.activeElement));
  if (i < 0) return;
  const next = items[i + (e.key === 'ArrowRight' ? 1 : -1)];
  if (!next) return;
  e.preventDefault();
  next.focus();
  next.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
}

/**
 * A titled horizontal row of cards. Header: title (a link when `link` is set), optional subtitle, ‹ › page buttons and
 * "See all". Scroller: snap, native momentum, mouse drag, ←/→ between cards.
 */
export function Row({ title, link, children, className, subtitle, id, actions, linkLabel = 'See all' }: { title: ReactNode; link?: string; children: ReactNode; className?: string; subtitle?: ReactNode; id?: string; actions?: ReactNode; linkLabel?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);
  const headingId = useId();
  useDragScroll(ref);

  const update = () => {
    const el = ref.current;
    if (!el) return;
    setCanLeft(el.scrollLeft > 4);
    setCanRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 4);
  };
  useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [children]);

  const scroll = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' });
  };

  return (
    <section className={`row ${className ?? ''}`} data-row-id={id} aria-labelledby={headingId}>
      <div className="row-head">
        <h2 className="row-title" id={headingId}>
          {link ? (
            <Link to={link}>
              {title} <Icon name="chevronRight" size={20} />
            </Link>
          ) : (
            title
          )}
        </h2>
        {subtitle && <span className="row-sub">{subtitle}</span>}
        <div className="row-nav">
          {actions}
          {(canLeft || canRight) && (
            <>
              <button className="row-arrow" onClick={() => scroll(-1)} aria-label="Scroll left" disabled={!canLeft}>
                <Icon name="chevronLeft" size={18} />
              </button>
              <button className="row-arrow" onClick={() => scroll(1)} aria-label="Scroll right" disabled={!canRight}>
                <Icon name="chevronRight" size={18} />
              </button>
            </>
          )}
          {link && (
            <Link to={link} className="see-all hide-sm" tabIndex={-1} aria-hidden="true">
              {linkLabel}
            </Link>
          )}
        </div>
      </div>
      <div className="row-wrap" data-left={canLeft || undefined} data-right={canRight || undefined}>
        <div className="row-scroller" ref={ref} onScroll={update} onKeyDown={onRowKey}>
          {children}
        </div>
      </div>
    </section>
  );
}
