import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { TrickplayInfo } from '@mediamax/shared';
import { formatClock } from '../utils/format';
import { Icon } from '../components/Icon';

/** The chapter at `ms` (chapters sorted by start). */
export function chapterAt(chapters: { title: string; startMs: number; endMs: number }[] | null | undefined, ms: number) {
  let hit: { title: string; startMs: number; endMs: number } | null = null;
  for (const c of chapters ?? []) if (ms >= c.startMs && (!c.endMs || ms < c.endMs)) hit = c;
  return hit;
}

/** One trickplay thumbnail cut out of its sprite sheet, scaled to `displayWidth`. */
export function TrickplayThumb({ info, ms, displayWidth }: { info: TrickplayInfo; ms: number; displayWidth: number }) {
  const perSheet = Math.max(1, info.columns * info.rows);
  const n = Math.max(0, Math.min(info.count - 1, Math.floor(ms / Math.max(1, info.intervalMs))));
  const sheet = info.sheets[Math.floor(n / perSheet)];
  if (!sheet) return null;
  const k = displayWidth / info.width;
  const w = info.width * k;
  const h = info.height * k;
  const col = n % info.columns;
  const row = Math.floor(n / info.columns) % info.rows;
  return (
    <div
      className="trickplay-thumb"
      style={{
        width: w,
        height: h,
        backgroundImage: `url("${sheet}")`,
        backgroundSize: `${info.columns * w}px ${info.rows * h}px`,
        backgroundPosition: `${-col * w}px ${-row * h}px`,
      }}
    />
  );
}

/** Warm the browser cache with all sprite sheets so scrubbing feels instant. */
function preloadSheets(info: TrickplayInfo) {
  for (const url of info.sheets) {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
  }
}

/** Scrubbable seek bar with buffered range, markers, hover time and optional trickplay previews. */
export function SeekBar({
  positionMs, durationMs, bufferedMs = 0, onSeek, markers, className, disabled, trickplay, previewMs = null, chapters,
}: {
  positionMs: number;
  durationMs: number;
  bufferedMs?: number;
  onSeek: (ms: number) => void;
  markers?: { startMs: number; endMs: number; type: string }[];
  className?: string;
  disabled?: boolean;
  trickplay?: TrickplayInfo | null;
  /** Seek target being stepped with the keyboard / TV remote (D-pad): shows the preview there. */
  previewMs?: number | null;
  /** Chapter names shown under the preview. */
  chapters?: { title: string; startMs: number; endMs: number }[] | null;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; ms: number } | null>(null);
  // Arrow keys on the focused bar: preview the new position for a moment.
  const [keyMs, setKeyMs] = useState<number | null>(null);
  const keyTimer = useRef<number | null>(null);
  const preloaded = useRef<TrickplayInfo | null>(null);
  const dur = durationMs > 0 ? durationMs : 1;
  const keyPreview = keyMs ?? previewMs;
  const active = hover !== null || drag !== null || keyPreview != null;
  useEffect(() => () => {
    if (keyTimer.current) window.clearTimeout(keyTimer.current);
  }, []);
  const flashKey = (ms: number) => {
    setKeyMs(ms);
    if (keyTimer.current) window.clearTimeout(keyTimer.current);
    keyTimer.current = window.setTimeout(() => setKeyMs(null), 1500);
  };
  useEffect(() => {
    if (active && trickplay && preloaded.current !== trickplay) {
      preloaded.current = trickplay;
      preloadSheets(trickplay);
    }
  }, [active, trickplay]);

  const msAt = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    return { ms: f * dur, x: f * r.width };
  };

  useEffect(() => {
    if (drag === null) return;
    const move = (e: PointerEvent) => setDrag(msAt(e.clientX).ms);
    const up = (e: PointerEvent) => {
      onSeek(msAt(e.clientX).ms);
      setDrag(null);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drag !== null]);

  const shown = drag ?? positionMs;
  return (
    <div
      className={`seekbar ${disabled ? 'disabled' : ''} ${className ?? ''}`}
      ref={ref}
      role="slider"
      tabIndex={0}
      aria-valuemin={0}
      aria-valuemax={Math.round(dur / 1000)}
      aria-valuenow={Math.round(shown / 1000)}
      aria-valuetext={formatClock(shown)}
      onPointerDown={(e) => {
        if (disabled || durationMs <= 0) return;
        e.preventDefault();
        setDrag(msAt(e.clientX).ms);
      }}
      onPointerMove={(e) => durationMs > 0 && setHover(msAt(e.clientX))}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
          e.preventDefault();
          e.stopPropagation();
          // Step from the last previewed target so repeated presses keep moving (TV remotes repeat fast).
          const from = keyMs ?? positionMs;
          const to = e.key === 'ArrowLeft' ? Math.max(0, from - 10000) : Math.min(dur, from + 10000);
          flashKey(to);
          onSeek(to);
        }
      }}
    >
      <div className="seek-track">
        <div className="seek-buffer" style={{ width: `${Math.min(100, (bufferedMs / dur) * 100)}%` }} />
        {markers?.map((m, i) => (
          <div key={i} className={`seek-marker seek-marker-${m.type}`} style={{ left: `${(m.startMs / dur) * 100}%`, width: `${((m.endMs - m.startMs) / dur) * 100}%` }} />
        ))}
        {durationMs > 0 && (chapters?.length ?? 0) > 1 && chapters!.slice(1).map((c, i) => (
          c.startMs > 0 && c.startMs < durationMs ? <div key={`c${i}`} className="seek-chapter-tick" style={{ left: `${(c.startMs / dur) * 100}%` }} aria-hidden="true" /> : null
        ))}
        <div className="seek-fill" style={{ width: `${Math.min(100, (shown / dur) * 100)}%` }} />
        <div className="seek-thumb" style={{ left: `${Math.min(100, (shown / dur) * 100)}%` }} />
      </div>
      {active && durationMs > 0 && (() => {
        const ms = drag ?? hover?.ms ?? keyPreview!;
        const width = ref.current?.getBoundingClientRect().width ?? 0;
        const x = (ms / dur) * width;
        const chapter = chapterAt(chapters, ms)?.title;
        if (!trickplay) {
          return <div className="seek-tooltip" style={{ left: x }}>{formatClock(ms)}{chapter && <small className="seek-chapter">{chapter}</small>}</div>;
        }
        // Keep the preview inside the bar so it never runs off-screen.
        const thumbW = Math.min(trickplay.width, width < 500 ? 150 : 240);
        const left = Math.max(thumbW / 2, Math.min(width - thumbW / 2, x));
        return (
          <div className="seek-tooltip seek-preview" style={{ left }}>
            <TrickplayThumb info={trickplay} ms={ms} displayWidth={thumbW} />
            <span>{formatClock(ms)}</span>
            {chapter && <small className="seek-chapter">{chapter}</small>}
          </div>
        );
      })()}
    </div>
  );
}

export function VolumeControl({ volume, muted, onVolume, onMute }: { volume: number; muted: boolean; onVolume: (v: number) => void; onMute: (m: boolean) => void }) {
  const icon = muted || volume === 0 ? 'mute' : volume < 0.5 ? 'volumeLow' : 'volume';
  return (
    <div className="volume">
      <button className="btn-icon" onClick={() => onMute(!muted)} aria-label={muted ? 'Unmute' : 'Mute'}>
        <Icon name={icon} />
      </button>
      <input
        className="volume-slider"
        type="range"
        min={0}
        max={1}
        step={0.02}
        value={muted ? 0 : volume}
        onChange={(e) => {
          onVolume(Number(e.target.value));
          if (muted) onMute(false);
        }}
        aria-label="Volume"
        style={{ ['--val' as string]: `${(muted ? 0 : volume) * 100}%` }}
      />
    </div>
  );
}

/** Popover panel anchored above a control button. */
export function Popover({ open, onClose, children, className }: { open: boolean; onClose: () => void; children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const t = window.setTimeout(() => document.addEventListener('mousedown', h), 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener('mousedown', h);
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className={`popover ${className ?? ''}`} ref={ref} onClick={(e) => e.stopPropagation()}>
      {children}
    </div>
  );
}

export function OptionList<T>({ options, value, onSelect, title }: { options: { label: ReactNode; value: T; sub?: ReactNode }[]; value: T; onSelect: (v: T) => void; title?: string }) {
  return (
    <div className="option-list">
      {title && <div className="option-title">{title}</div>}
      {options.map((o, i) => (
        <button key={i} className={`option ${Object.is(o.value, value) ? 'selected' : ''}`} onClick={() => onSelect(o.value)}>
          <span className="option-check">{Object.is(o.value, value) && <Icon name="check" size={16} />}</span>
          <span className="option-label">
            {o.label}
            {o.sub && <small>{o.sub}</small>}
          </span>
        </button>
      ))}
    </div>
  );
}
