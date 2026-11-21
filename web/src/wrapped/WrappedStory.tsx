import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import type { WrappedStory as Story } from '@mediamax/shared';
import { Icon } from '../components/Icon';
import { Img, Spinner } from '../components/ui';
import { useToast } from '../state/toast';
import { buildCards, tintColors, MONTHS, type StoryCard } from './cards';
import { canvasToPng, renderCard, sampleColor, shareOrDownload } from './exportCard';
import './wrapped.css';

const CARD_MS = 6500;
const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Full-screen, story-style Wrapped: progress bars, tap / arrow keys / D-pad / swipe to move, auto-advance (pauses
 * while held, hidden or with reduced motion), artwork-tinted backgrounds and kinetic type. Each card exports as a
 * 1080×1920 PNG; "Share all" hands every card to the share sheet (or downloads them).
 */
export function WrappedStory({ story, brand, onClose }: { story: Story; brand: string; onClose: () => void }) {
  const toast = useToast();
  const cards = useMemo(() => buildCards(story, brand), [story, brand]);
  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(() => reducedMotion());
  const [elapsed, setElapsed] = useState(0);
  const [tints, setTints] = useState<Record<string, [number, number, number] | null>>({});
  const [busy, setBusy] = useState<null | 'one' | 'all'>(null);
  const root = useRef<HTMLDivElement>(null);
  const card = cards[i];

  // Artwork colours, sampled once per card.
  useEffect(() => {
    let alive = true;
    for (const c of cards) {
      if (!c.image) continue;
      void sampleColor(c.image).then((rgb) => alive && setTints((t) => ({ ...t, [c.id]: rgb })));
    }
    return () => {
      alive = false;
    };
  }, [cards]);

  const go = useCallback((d: number) => {
    setElapsed(0);
    setI((x) => {
      const n = x + d;
      if (n >= cards.length) return x;
      return Math.max(0, n);
    });
  }, [cards.length]);

  // Auto-advance.
  useEffect(() => {
    if (paused) return;
    const started = Date.now() - elapsed;
    const t = window.setInterval(() => {
      const e = Date.now() - started;
      if (e >= CARD_MS) {
        if (i < cards.length - 1) go(1);
        else setPaused(true);
      } else setElapsed(e);
    }, 100);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused, i, cards.length, go]);
  useEffect(() => {
    const vis = () => document.hidden && setPaused(true);
    document.addEventListener('visibilitychange', vis);
    return () => document.removeEventListener('visibilitychange', vis);
  }, []);

  // Keyboard / TV remote: left/right step, OK toggles pause, Back/Escape closes.
  useEffect(() => {
    root.current?.focus();
    const key = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('.wrs-actions')) {
        if (e.key === 'Escape') onClose();
        return;
      }
      if (e.key === 'ArrowRight' || e.key === 'PageDown') go(1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') go(-1);
      else if (e.key === ' ' || e.key === 'Enter' || e.key === 'MediaPlayPause') setPaused((p) => !p);
      else if (e.key === 'Escape' || e.key === 'Backspace') onClose();
      else if (e.key === 'ArrowDown') {
        root.current?.querySelector<HTMLElement>('.wrs-actions button')?.focus();
      } else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    document.body.classList.add('modal-open');
    return () => {
      window.removeEventListener('keydown', key, true);
      document.body.classList.remove('modal-open');
    };
  }, [go, onClose]);

  // Touch: tap left third = back, elsewhere = next; swipe left/right; hold = pause.
  const touch = useRef<{ x: number; y: number; t: number } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const onDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('button, a')) return;
    touch.current = { x: e.clientX, y: e.clientY, t: Date.now() };
    holdTimer.current = window.setTimeout(() => setPaused(true), 250);
  };
  const onUp = (e: React.PointerEvent) => {
    if (holdTimer.current) window.clearTimeout(holdTimer.current);
    const s = touch.current;
    touch.current = null;
    if (!s) return;
    const dx = e.clientX - s.x;
    const dt = Date.now() - s.t;
    if (dt > 250 && Math.abs(dx) < 20) {
      setPaused(reducedMotion());
      return;
    }
    if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    else {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
      go(e.clientX - r.left < r.width / 3 ? -1 : 1);
    }
  };

  const exportOne = async (c: StoryCard, idx: number) => {
    const canvas = await renderCard(c, brand, idx, cards.length, tints[c.id] ?? undefined);
    return new File([await canvasToPng(canvas)], `wrapped-${story.year ?? 'all-time'}-${String(idx + 1).padStart(2, '0')}-${c.id}.png`, { type: 'image/png' });
  };
  const share = async (all: boolean) => {
    setBusy(all ? 'all' : 'one');
    setPaused(true);
    try {
      const files = all ? await Promise.all(cards.map((c, idx) => exportOne(c, idx))) : [await exportOne(card, i)];
      const r = await shareOrDownload(files, `${brand} Wrapped ${story.year ?? ''}`.trim());
      if (r === 'downloaded') toast.success(all ? `Saved ${files.length} images` : 'Image saved');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const tint = tintColors(tints[card.id] ?? null, card.hue);
  const style = { '--wr-from': tint.from, '--wr-to': tint.to, '--wr-accent': tint.accent } as CSSProperties;
  return createPortal(
    <div className="wrs" role="dialog" aria-modal="true" aria-label={`${brand} Wrapped story`} ref={root} tabIndex={-1} style={style} data-own-arrows="">
      <div className="wrs-frame" onPointerDown={onDown} onPointerUp={onUp} onPointerCancel={() => { touch.current = null; }}>
        <div className="wrs-bars" aria-hidden="true">
          {cards.map((c, n) => (
            <span key={c.id}><i style={{ transform: `scaleX(${n < i ? 1 : n > i ? 0 : paused && reducedMotion() ? 1 : elapsed / CARD_MS})` }} /></span>
          ))}
        </div>
        <div className="wrs-top">
          <span className="wrs-brand">{brand}</span>
          <button className="btn-icon" onClick={() => setPaused((p) => !p)} aria-label={paused ? 'Play story' : 'Pause story'}><Icon name={paused ? 'play' : 'pause'} size={20} /></button>
          <button className="btn-icon" onClick={onClose} aria-label="Close story"><Icon name="x" size={22} /></button>
        </div>
        {card.image && <div className="wrs-wash" style={{ backgroundImage: `url("${card.image}${card.image.startsWith('/api/') ? '?w=600' : ''}")` }} aria-hidden="true" />}
        <CardView key={card.id} card={card} />
        <div className="wrs-actions">
          <button className="btn btn-glass btn-sm" disabled={!!busy} onClick={() => void share(false)}>
            {busy === 'one' ? <Spinner size={14} /> : <Icon name="download" size={14} />} Save card
          </button>
          <button className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void share(true)}>
            {busy === 'all' ? <Spinner size={14} /> : <Icon name="external" size={14} />} Share all
          </button>
        </div>
        <span className="sr-only" aria-live="polite">Card {i + 1} of {cards.length}: {card.eyebrow}. {card.big ?? ''} {card.bigUnit ?? ''} {card.headline}. {card.sub ?? ''}</span>
      </div>
    </div>,
    document.body,
  );
}

function CardView({ card }: { card: StoryCard }) {
  return (
    <div className={`wrs-card wrs-${card.kind}`}>
      <span className="wrs-eyebrow k-in" style={{ '--d': '0ms' } as CSSProperties}>{card.eyebrow}</span>
      {card.image && ['titles', 'binge', 'intro', 'music', 'outro'].includes(card.kind) && (
        <div className="wrs-art k-pop" style={{ '--d': '80ms' } as CSSProperties}><Img src={card.image} width={360} alt="" /></div>
      )}
      {card.image && card.kind === 'people' && (
        <div className="wrs-face k-pop" style={{ '--d': '80ms' } as CSSProperties}><Img src={card.image} width={300} alt="" /></div>
      )}
      {card.big && (
        <div className="wrs-big k-slam" style={{ '--d': '160ms' } as CSSProperties}>
          {card.big}
          {card.bigUnit && <small>{card.bigUnit}</small>}
        </div>
      )}
      <h2 className="wrs-headline">
        {card.headline.split(' ').map((w, n) => (
          <span key={n} className="k-word" style={{ '--d': `${260 + n * 70}ms` } as CSSProperties}>{w} </span>
        ))}
      </h2>
      {card.sub && <p className="wrs-sub k-in" style={{ '--d': '520ms' } as CSSProperties}>{card.sub}</p>}
      {card.traits && card.traits.length > 0 && (
        <ul className="wrs-traits">
          {card.traits.map((t, n) => <li key={t} className="k-pop" style={{ '--d': `${620 + n * 90}ms` } as CSSProperties}>{t}</li>)}
        </ul>
      )}
      {card.list && card.kind !== 'intro' && (
        <ol className="wrs-list">
          {card.list.map((r, n) => (
            <li key={`${r.title}-${n}`} className="k-row" style={{ '--d': `${600 + n * 90}ms` } as CSSProperties}>
              <b>{n + 1}</b>
              {r.image && <span className={`wrs-thumb ${r.round ? 'round' : ''}`}><Img src={r.image} width={90} alt="" /></span>}
              <span className="wrs-row-text"><strong>{r.title}</strong><small>{r.meta}</small></span>
            </li>
          ))}
        </ol>
      )}
      {card.heat && <Heatmap heat={card.heat} />}
    </div>
  );
}

function Heatmap({ heat }: { heat: number[][] }) {
  const max = Math.max(1, ...heat.flat());
  return (
    <div className="wrs-heat" role="img" aria-label="Minutes watched per day, January to December">
      {heat.map((days, m) => (
        <div key={m} className="wrs-heat-row k-row" style={{ '--d': `${400 + m * 50}ms` } as CSSProperties}>
          <span>{MONTHS[m][0]}</span>
          {days.map((v, d) => <i key={d} style={{ opacity: v > 0 ? 0.25 + 0.75 * Math.sqrt(v / max) : 0.08 }} className={v > 0 ? 'on' : ''} />)}
        </div>
      ))}
    </div>
  );
}
