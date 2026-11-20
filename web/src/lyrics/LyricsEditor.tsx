/**
 * Lyrics editor (administrators): edit the text, tap-to-sync lines while the song plays, nudge timing, import /
 * export .lrc, save to the server (optionally also writing Song.lrc next to the file when the admin setting allows).
 * Keys outside the text box: Space / Enter = stamp the cursor line, Backspace = undo, ↑ / ↓ = move the cursor.
 * Idea and model adapted from OpenDJ (MIT, github.com/Bucifer6/OpenDJ) — public/js/lyrics/editor.js.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Item, Lyrics } from '@mediamax/shared';
import { karaokeApi } from '../api/karaoke';
import { useMusic } from '../player/music';
import { useToast } from '../state/toast';
import { Icon } from '../components/Icon';
import { Modal, Switch, Tabs } from '../components/ui';
import { formatLrcTime, lineIndexAt, type LrcLine } from './lrc';
import { firstUntimed, linesFromText, linesToLrc, shiftAll, tapLine } from './editorModel';

export function LyricsEditor({ track, lyrics, onClose, onSaved }: { track: Item; lyrics: Lyrics | null | undefined; onClose: () => void; onSaved: (l: Lyrics | null) => void }) {
  const m = useMusic();
  const toast = useToast();
  const [tab, setTab] = useState<'sync' | 'text'>(lyrics?.lines.length ? 'sync' : 'text');
  const [lines, setLines] = useState<LrcLine[]>(() => (lyrics?.lrc ? linesFromText(lyrics.lrc) : (lyrics?.lines as LrcLine[] | undefined) ?? []));
  const [text, setText] = useState(() => lyrics?.lrc ?? '');
  const [cursor, setCursor] = useState(() => firstUntimed(lines));
  const [history, setHistory] = useState<{ lines: LrcLine[]; cursor: number }[]>([]);
  const [writeSidecar, setWriteSidecar] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(0);
  const list = useRef<HTMLOListElement>(null);
  const fileIn = useRef<HTMLInputElement>(null);
  const meta = useMemo(() => ({ ti: track.title, ...(track.grandparentTitle ? { ar: track.grandparentTitle } : {}), ...(track.parentTitle ? { al: track.parentTitle } : {}) }), [track]);

  useEffect(() => {
    const iv = window.setInterval(() => setNow(m.output.timeMs()), 100);
    return () => clearInterval(iv);
  }, [m.output]);
  const playing = lineIndexAt(lines.filter((l) => l.startMs != null), now);
  const timed = lines.filter((l) => l.startMs != null).length;

  const commit = (next: LrcLine[], nextCursor = cursor) => {
    setHistory((h) => [...h.slice(-200), { lines, cursor }]);
    setLines(next);
    setCursor(Math.max(0, Math.min(next.length - 1, nextCursor)));
  };
  const tap = () => {
    if (!lines.length) return;
    commit(tapLine(lines, cursor, m.output.timeMs() - m.output.latencyMs()), cursor + 1);
  };
  const undo = () => {
    const h = history.at(-1);
    if (!h) return;
    setHistory((x) => x.slice(0, -1));
    setLines(h.lines);
    setCursor(h.cursor);
  };
  const useText = () => {
    const ls = linesFromText(text);
    setHistory((h) => [...h, { lines, cursor }]);
    setLines(ls);
    setCursor(firstUntimed(ls));
    setTab('sync');
  };
  const toText = () => {
    setText(lines.length ? linesToLrc(lines, meta) : text);
    setTab('text');
  };

  useEffect(() => {
    if (tab !== 'sync') return;
    const key = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('textarea, input, select')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        if (t.closest('button') && e.key === 'Enter') return;
        e.preventDefault();
        tap();
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        undo();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setCursor((c) => Math.max(0, Math.min(lines.length - 1, c + (e.key === 'ArrowDown' ? 1 : -1))));
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  });
  useEffect(() => {
    list.current?.querySelector('.cursor')?.scrollIntoView?.({ block: 'nearest' });
  }, [cursor]);

  const exportLrc = () => {
    const body = tab === 'text' ? text : linesToLrc(lines, meta);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
    a.download = `${(track.grandparentTitle ? `${track.grandparentTitle} - ` : '') + track.title}.lrc`.replace(/[\\/:*?"<>|]/g, '_');
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importFile = async (f: File | undefined) => {
    if (!f) return;
    const t = await f.text();
    setText(t);
    const ls = linesFromText(t);
    commit(ls, firstUntimed(ls));
    setTab('sync');
  };
  const save = async () => {
    setBusy(true);
    try {
      const lrc = tab === 'text' ? text : linesToLrc(lines, meta);
      const r = await karaokeApi.saveLyrics(track.id, { lrc, writeSidecar });
      if (r.sidecarError) toast.show(`Saved. ${r.sidecarError}`);
      else toast.show(r.wroteSidecar ? 'Lyrics saved (and written next to the file)' : 'Lyrics saved');
      onSaved(r);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const revert = async () => {
    setBusy(true);
    try {
      await karaokeApi.deleteLyrics(track.id);
      toast.show('Edits removed: the original lyrics are used again');
      onSaved(null);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      size="lg"
      className="lyrics-editor"
      title={<>Edit lyrics <small className="muted">· {track.title}</small></>}
      footer={
        <>
          {lyrics?.source === 'user' && <button className="btn btn-ghost" onClick={revert} disabled={busy}>Revert to original</button>}
          <span className="spacer" />
          <Switch checked={writeSidecar} onChange={setWriteSidecar} label="Also write .lrc next to the file" />
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={save} disabled={busy || (tab === 'sync' ? !lines.length : !text.trim())}>Save</button>
        </>
      }
    >
      <div className="lyr-ed-bar">
        <Tabs value={tab} onChange={(v) => (v === 'text' ? toText() : useText())} tabs={[{ value: 'sync', label: 'Sync' }, { value: 'text', label: 'Text / LRC' }]} />
        <span className="spacer" />
        <button className="btn btn-sm" onClick={() => fileIn.current?.click()}><Icon name="upload" size={14} /> Import .lrc</button>
        <button className="btn btn-sm" onClick={exportLrc}><Icon name="download" size={14} /> Export .lrc</button>
        <input ref={fileIn} type="file" accept=".lrc,.txt,text/plain" hidden onChange={(e) => void importFile(e.target.files?.[0])} />
      </div>
      {tab === 'text' ? (
        <textarea className="input lyr-ed-text" rows={16} spellCheck={false} value={text} onChange={(e) => setText(e.target.value)}
          placeholder={'Paste plain lyrics or a whole .lrc file.\nThen switch to "Sync" and tap along while the song plays.'} />
      ) : (
        <>
          <div className="lyr-ed-controls">
            <button className="btn btn-icon-text" onClick={m.toggle}><Icon name={m.playing ? 'pause' : 'play'} size={16} /> {m.playing ? 'Pause' : 'Play'}</button>
            <span className="lyr-ed-time" aria-label="Playback position">{formatLrcTime(now)}</span>
            <button className="btn btn-primary lyr-ed-tap" onClick={tap} disabled={!lines.length} title="Space / Enter">Tap: line {Math.min(cursor + 1, lines.length)}</button>
            <button className="btn" onClick={undo} disabled={!history.length} title="Backspace">Undo</button>
            <span className="spacer" />
            <span className="muted">Shift all</span>
            {[-500, -100, 100, 500].map((d) => (
              <button key={d} className="btn btn-sm" onClick={() => commit(shiftAll(lines, d))}>{d > 0 ? '+' : '−'}{Math.abs(d) / 1000}s</button>
            ))}
          </div>
          <p className="muted lyr-ed-hint">{timed}/{lines.length} lines synced. Play the song and press <kbd>Space</kbd> as each line starts; <kbd>Backspace</kbd> undoes, <kbd>↑</kbd>/<kbd>↓</kbd> move the cursor. Untimed lines are spread between their neighbours when you save.</p>
          {!lines.length ? (
            <div className="lyrics-empty muted"><p>No lines yet: paste the lyrics in "Text / LRC".</p></div>
          ) : (
            <ol className="lyr-ed-list" ref={list}>
              {lines.map((l, i) => (
                <li key={i} className={`${i === cursor ? 'cursor' : ''} ${l.startMs == null ? 'untimed' : ''} ${l.startMs != null && lines.filter((x) => x.startMs != null).indexOf(l) === playing ? 'playing' : ''}`}>
                  <button className="lyr-ed-t" title={l.startMs == null ? 'Not synced yet' : 'Play from here'} onClick={() => l.startMs != null && m.seek(Math.max(0, l.startMs - 1000))}>
                    {l.startMs == null ? '--:--.--' : formatLrcTime(l.startMs)}
                  </button>
                  <span className="lyr-ed-nudge">
                    <button className="btn-icon" aria-label="Earlier" disabled={l.startMs == null} onClick={() => commit(lines.map((x, j) => (j === i && x.startMs != null ? tapLine([x], 0, x.startMs - 100)[0] : x)))}>−</button>
                    <button className="btn-icon" aria-label="Later" disabled={l.startMs == null} onClick={() => commit(lines.map((x, j) => (j === i && x.startMs != null ? tapLine([x], 0, x.startMs + 100)[0] : x)))}>+</button>
                  </span>
                  <button className="lyr-ed-line" onClick={() => setCursor(i)}>{l.text || '♪'}{l.words?.length ? <small className="muted"> · word timing</small> : null}</button>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </Modal>
  );
}
