import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Icon } from './Icon';

export function Row({ title, link, children, className, subtitle }: { title: ReactNode; link?: string; children: ReactNode; className?: string; subtitle?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [canLeft, setCanLeft] = useState(false);
  const [canRight, setCanRight] = useState(false);

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
    <section className={`row ${className ?? ''}`}>
      <div className="row-head">
        <h2 className="row-title">
          {link ? (
            <Link to={link}>
              {title} <Icon name="chevronRight" size={18} />
            </Link>
          ) : (
            title
          )}
        </h2>
        {subtitle && <span className="row-sub">{subtitle}</span>}
      </div>
      <div className="row-wrap">
        {canLeft && (
          <button className="row-arrow left" onClick={() => scroll(-1)} aria-label="Scroll left" tabIndex={-1}>
            <Icon name="chevronLeft" size={28} />
          </button>
        )}
        <div className="row-scroller" ref={ref} onScroll={update}>
          {children}
        </div>
        {canRight && (
          <button className="row-arrow right" onClick={() => scroll(1)} aria-label="Scroll right" tabIndex={-1}>
            <Icon name="chevronRight" size={28} />
          </button>
        )}
      </div>
    </section>
  );
}
