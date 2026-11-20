/**
 * Lyrics display with karaoke highlighting.
 *
 * - `list`: every line, the current one highlighted word by word (A2 / SYLT word timing) or with a wipe across the
 *   line when only line times exist; smooth auto-scroll that pauses for a few seconds after the user scrolls.
 * - `karaoke`: big type, current line + next line only (10-foot / TV friendly).
 * Highlighting is written straight to the DOM every animation frame (CSS `--fill` per word), so React only re-renders
 * when the current line changes. Display logic adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) —
 * public/js/lyrics/karaoke-overlay.js.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Lyrics } from '@mediamax/shared';
import { useMusic } from '../player/music';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { lyricStateAt, wordFills, type LrcLine } from './lrc';
import { asLrcLines, useLyricsClock } from './useLyrics';

/** Word spans of a line (the text the fills apply to). */
function lineWords(line: LrcLine): string[] {
  return line.words?.length ? line.words.map((w) => w.text) : line.text.split(/(\s+)/).filter((p) => p.length);
}

function Words({ line }: { line: LrcLine }) {
  return (
    <>
      {lineWords(line).map((w, i) => (
        <span key={i} className="kw">{w}</span>
      ))}
    </>
  );
}

/** Write the fills of `line` at state `st` into the word spans of `el`. */
function paint(el: HTMLElement | null, line: LrcLine | null, st: ReturnType<typeof lyricStateAt> | null) {
  if (!el) return;
  const spans = el.querySelectorAll<HTMLElement>('.kw');
  const fills = line && st ? wordFills(line, st) : [];
  spans.forEach((s, i) => s.style.setProperty('--fill', `${Math.round((fills[i]?.fill ?? 0) * 1000) / 10}%`));
}

export function KaraokeLyrics({ lyrics, offsetMs, mode = 'list', onSeek, className }: { lyrics: Lyrics | null | undefined; offsetMs: number; mode?: 'list' | 'karaoke'; onSeek?: (ms: number) => void; className?: string }) {
  const m = useMusic();
  const lines = useMemo(() => asLrcLines(lyrics), [lyrics]);
  const synced = !!lyrics?.synced;
  const [cur, setCur] = useState(-1);
  const curRef = useRef(-1);
  const box = useRef<HTMLDivElement>(null);
  const userScrolledAt = useRef(0);

  const onFrame = useCallback((ms: number) => {
    if (!synced) return;
    const st = lyricStateAt(lines, ms);
    if (st.index !== curRef.current) {
      curRef.current = st.index;
      setCur(st.index);
    }
    const el = box.current?.querySelector<HTMLElement>('.lyric-line.current') ?? null;
    paint(el, st.line, st);
  }, [lines, synced]);
  useLyricsClock(m.output.timeMs, m.output.latencyMs, offsetMs, m.playing, onFrame);

  // Smooth auto-scroll to the current line (list mode).
  useEffect(() => {
    if (mode !== 'list' || cur < 0 || Date.now() - userScrolledAt.current < 4000) return;
    const c = box.current;
    const el = c?.querySelector<HTMLElement>('.lyric-line.current');
    if (!el || !c) return;
    c.scrollTo({ top: el.offsetTop - c.clientHeight * 0.4 + el.clientHeight / 2, behavior: 'smooth' });
  }, [cur, mode]);

  if (lyrics === undefined) return <div className="lyrics-empty"><Spinner size={24} /></div>;
  if (!lyrics || !lines.length) return <div className="lyrics-empty muted"><Icon name="lyrics" size={28} /><p>No lyrics for this track.</p></div>;

  if (mode === 'karaoke') {
    if (!synced) {
      return <div className={`karaoke-view unsynced ${className ?? ''}`} ref={box}>{lines.slice(0, 12).map((l, i) => <p key={i} className="karaoke-plain">{l.text}</p>)}</div>;
    }
    const line = cur >= 0 ? lines[cur] : null;
    const next = lines[cur + 1] ?? null;
    const after = lines[cur + 2] ?? null;
    return (
      <div className={`karaoke-view ${className ?? ''}`} ref={box} aria-live="off">
        <div className="karaoke-prev">{cur > 0 ? lines[cur - 1].text : ' '}</div>
        <div key={cur} className={`lyric-line current karaoke-current ${line && !line.text ? 'gap' : ''}`}>
          {line && line.text ? <Words line={line} /> : <span className="karaoke-dots">● ● ●</span>}
        </div>
        <div className="karaoke-next">{next ? next.text || '♪' : ' '}</div>
        <div className="karaoke-after">{after ? after.text || '♪' : ' '}</div>
      </div>
    );
  }

  return (
    <div
      className={`lyrics karaoke-list ${synced ? 'synced' : ''} ${className ?? ''}`}
      ref={box}
      onWheel={() => (userScrolledAt.current = Date.now())}
      onTouchMove={() => (userScrolledAt.current = Date.now())}
    >
      {lines.map((l, i) =>
        synced && l.startMs != null ? (
          <button key={i} className={`lyric-line ${i === cur ? 'current' : i < cur ? 'past' : ''}`} onClick={() => onSeek?.(Math.max(0, l.startMs! - offsetMs))}>
            {i === cur && l.text ? <Words line={l} /> : l.text || '♪'}
          </button>
        ) : (
          <p key={i} className="lyric-line">{l.text || ' '}</p>
        ),
      )}
    </div>
  );
}
