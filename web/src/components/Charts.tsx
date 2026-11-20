import { useEffect, useRef, useState, type ReactNode } from 'react';

/** "42 min", "3.5 h", "120 h". */
export function formatMinutes(min: number): string {
  if (!min || min < 1) return '0 min';
  if (min < 60) return `${Math.round(min)} min`;
  const h = min / 60;
  return `${h < 10 ? h.toFixed(1).replace(/\.0$/, '') : Math.round(h).toLocaleString()} h`;
}

/** Animate a number from 0 to `value` (skipped for reduced-motion users). */
export function useCountUp(value: number, ms = 1100): number {
  const [shown, setShown] = useState(value);
  const raf = useRef(0);
  useEffect(() => {
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      /* ignore */
    }
    if (reduce || value <= 0) {
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const tick = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const eased = 1 - Math.pow(1 - p, 3);
      setShown(value * eased);
      if (p < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf.current);
  }, [value, ms]);
  return shown;
}

export function CountUp({ value, decimals = 0 }: { value: number; decimals?: number }) {
  const v = useCountUp(value);
  return <>{v.toLocaleString(undefined, { maximumFractionDigits: decimals, minimumFractionDigits: decimals })}</>;
}

/**
 * Simple vertical bar chart drawn with CSS. Every bar has a text label for
 * screen readers; the tallest bar is highlighted.
 */
export function BarChart({
  values, labels, axisLabels, format = (v) => v.toLocaleString(), height = 160, highlightMax = true, className, title,
}: {
  values: number[];
  /** Full label per bar (tooltip / screen readers). */
  labels: string[];
  /** Short label under each bar; null hides that one (e.g. every 3rd hour). */
  axisLabels?: (string | null)[];
  format?: (v: number) => string;
  height?: number;
  highlightMax?: boolean;
  className?: string;
  title?: string;
}) {
  const max = Math.max(0, ...values);
  const peak = highlightMax && max > 0 ? values.indexOf(max) : -1;
  return (
    <figure className={`barchart ${className ?? ''}`} aria-label={title}>
      <div className="barchart-bars" style={{ height }} role="list">
        {values.map((v, i) => (
          <div
            key={i}
            className={`barchart-col ${i === peak ? 'peak' : ''}`}
            role="listitem"
            aria-label={`${labels[i]}: ${format(v)}`}
            title={`${labels[i]}: ${format(v)}`}
            tabIndex={values.length <= 31 ? 0 : undefined}
          >
            <div className="barchart-bar" style={{ height: max > 0 ? `${Math.max(v > 0 ? 2 : 0, (v / max) * 100)}%` : 0, animationDelay: `${Math.min(i * 18, 600)}ms` }} />
          </div>
        ))}
      </div>
      {axisLabels && (
        <div className="barchart-axis" aria-hidden="true">
          {axisLabels.map((l, i) => <span key={i}>{l ?? ''}</span>)}
        </div>
      )}
    </figure>
  );
}

/** Horizontal bars with a label and value on each row. */
export function HBars({ rows, format = (v) => v.toLocaleString(), tone }: { rows: { label: ReactNode; value: number; key?: string; color?: string }[]; format?: (v: number) => string; tone?: 'primary' | 'accent' }) {
  const max = Math.max(0, ...rows.map((r) => r.value));
  return (
    <ul className={`hbars ${tone === 'accent' ? 'hbars-accent' : ''}`}>
      {rows.map((r, i) => (
        <li key={r.key ?? i}>
          <div className="hbars-text">
            <span className="hbars-label">{r.label}</span>
            <span className="hbars-value">{format(r.value)}</span>
          </div>
          <div className="hbars-track">
            <div className="hbars-fill" style={{ width: max > 0 ? `${(r.value / max) * 100}%` : 0, background: r.color, animationDelay: `${i * 60}ms` }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
