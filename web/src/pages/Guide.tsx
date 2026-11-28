import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Channel, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { isTypingTarget, useAsync, useMediaQuery, useNow } from '../hooks';
import { Chip, EmptyState, ErrorState, Img, PageHeader, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { ProgramModal, ProgramPanel } from '../components/ProgramModal';
import { formatTime } from '../utils/format';
import { HelpLink } from '../components/HelpLink';
import '../styles/epg.css';

const HOURS = 12;
const PAGE = 60;
const HALF = 30 * 60000;

function floorHalfHour(t: number) {
  return Math.floor(t / HALF) * HALF;
}

const EMPTY: Program[] = [];

/**
 * One channel's row. Memoised: opening a programme, loading the next page of channels or any other page state change
 * no longer re-renders every row and programme of the grid (thousands of buttons with 500 channels loaded).
 */
const GuideRow = memo(function GuideRow({ channel: c, list, start, end, now, px: PX, width, selectedId, onSelect }: {
  channel: Channel; list: Program[]; start: number; end: number; now: number; px: number; width: number; selectedId: string | null; onSelect: (p: Program, c: Channel, el: HTMLElement) => void;
}) {
  const navigate = useNavigate();
  return (
    <div className="guide-row" data-channel-number={c.number ?? undefined}>
      <button className="guide-channel" onClick={() => navigate(`/watch/live/${c.id}`)} title={`Watch ${c.name}`} aria-label={`Watch ${c.number != null ? `${c.number} ` : ''}${c.name}`}>
        <span className="gc-num">{c.number ?? ''}</span>
        <span className="gc-logo"><Img src={c.logoUrl} width={120} alt="" fallback={<span className="ch-logo-text">{c.name.slice(0, 4)}</span>} /></span>
        <span className="gc-name">{c.name}</span>
        {c.favorite && <Icon name="starFill" size={12} className="gc-fav" title="Favourite" />}
      </button>
      <div className="guide-programs" style={{ width }}>
        {list.length === 0 && <div className="guide-empty">No information</div>}
        {list.map((p) => {
          const s = Date.parse(p.start);
          const e = Date.parse(p.end);
          if (e <= start || s >= end) return null;
          const left = ((Math.max(s, start) - start) / 60000) * PX;
          const w = ((Math.min(e, end) - Math.max(s, start)) / 60000) * PX;
          const live = s <= now && e > now;
          const past = e <= now;
          const minsLeft = live ? Math.max(1, Math.round((e - now) / 60000)) : 0;
          return (
            <button
              key={p.id}
              className={`guide-prog ${live ? 'live' : ''} ${past ? 'past' : ''} ${p.recordingId ? 'rec' : ''} ${w < 60 ? 'tiny' : ''} ${selectedId === p.id ? 'selected' : ''}`}
              style={{ left, width: Math.max(2, w - 4) }}
              onClick={(ev) => onSelect(p, c, ev.currentTarget)}
              aria-label={`${p.title}, ${formatTime(p.start)} to ${formatTime(p.end)}${live ? `, on now, ${minsLeft} minutes left` : ''}${p.recordingId ? ', recording' : ''}`}
              title={`${p.title} · ${formatTime(p.start)}–${formatTime(p.end)}`}
            >
              <span className="gp-inner">
                <span className="gp-title">
                  {p.recordingId && <Icon name="record" size={10} className="gp-rec" />}
                  {p.isNew && <span className="gp-new">NEW</span>}
                  <span className="gp-name">{p.title}</span>
                </span>
                <span className="gp-time">{formatTime(p.start)} – {formatTime(p.end)}{live && <span className="gp-left"> · {minsLeft} min left</span>}</span>
              </span>
              {live && <span className="gp-progress" style={{ width: `${((now - s) / (e - s)) * 100}%` }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
});

export default function GuidePage() {
  const [params] = useSearchParams();
  const mobile = useMediaQuery('(max-width: 700px)');
  const wide = useMediaQuery('(min-width: 1100px)');
  const PX = mobile ? 4 : 6; // px per minute
  const CH_W = mobile ? 96 : 232;
  const ROW_H = mobile ? 64 : 72;
  const at = params.get('at');
  const [start, setStart] = useState(() => floorHalfHour((at ? new Date(at).getTime() : Date.now()) - HALF));
  const end = start + HOURS * 3600000;
  const [categoryId, setCategoryId] = useState('');
  const [fav, setFav] = useState(false);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [programs, setPrograms] = useState<Map<string, Program[]>>(new Map());
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ p: Program; c: Channel; el?: HTMLElement | null } | null>(null);
  const [typed, setTyped] = useState('');
  const scroller = useRef<HTMLDivElement>(null);
  const req = useRef(0);
  const now = useNow(30000);
  const cats = useAsync(() => api.livetv.categories(), []);
  const wantedProgram = useRef(params.get('program'));

  const load = useCallback(
    async (offset: number) => {
      const id = ++req.current;
      setLoading(true);
      setError(null);
      try {
        const g = await api.livetv.guide({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), categoryId: categoryId || undefined, favorite: fav || undefined, offset, limit: PAGE, kind: 'tv' });
        if (id !== req.current) return;
        setChannels((c) => (offset ? [...c, ...g.channels] : g.channels));
        setPrograms((prev) => {
          const m = offset ? new Map(prev) : new Map<string, Program[]>();
          // Only the channels in this page get new lists (and are sorted); earlier rows keep theirs, so they don't re-render.
          const touched = new Set<string>();
          for (const p of g.programs) {
            if (!touched.has(p.channelId)) {
              touched.add(p.channelId);
              m.set(p.channelId, [...(m.get(p.channelId) ?? [])]);
            }
            m.get(p.channelId)!.push(p);
          }
          for (const id of touched) m.get(id)!.sort((a, b) => a.start.localeCompare(b.start));
          return m;
        });
        setHasMore(g.channels.length >= PAGE);
        if (wantedProgram.current) {
          const p = g.programs.find((x) => x.id === wantedProgram.current);
          const c = p && g.channels.find((x) => x.id === p.channelId);
          if (p && c) {
            setSelected({ p, c });
            wantedProgram.current = null;
          }
        }
      } catch (e) {
        if (id === req.current) setError((e as Error).message);
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [start, end, categoryId, fav],
  );

  useEffect(() => {
    void load(0);
  }, [load]);

  // Scroll so "now" is near the left edge whenever the window changes.
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const target = Math.max(0, ((Math.max(now, start) - start) / 60000 - 20) * PX);
    el.scrollLeft = now >= start && now <= end ? target : 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, PX, loading && !channels.length]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 6) void load(channels.length);
  };

  // Number keys jump to a channel (type "1", "2" → channel 12), like a remote.
  useEffect(() => {
    let timer = 0;
    let buf = '';
    const key = (e: KeyboardEvent) => {
      if (!/^[0-9]$/.test(e.key) || e.ctrlKey || e.metaKey || e.altKey || isTypingTarget(e.target) || document.querySelector('.modal')) return;
      buf = (buf + e.key).slice(-4);
      setTyped(buf);
      clearTimeout(timer);
      timer = window.setTimeout(() => {
        const row = scroller.current?.querySelector<HTMLElement>(`.guide-row[data-channel-number="${Number(buf)}"]`);
        if (row) {
          row.querySelector<HTMLElement>('.guide-channel')?.focus({ preventScroll: true });
          const el = scroller.current!;
          el.scrollTo({ top: row.offsetTop - ROW_H, behavior: 'auto' });
        }
        buf = '';
        setTyped('');
      }, 900);
    };
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('keydown', key);
      clearTimeout(timer);
    };
  }, [ROW_H]);

  const slots = useMemo(() => {
    const s: number[] = [];
    for (let t = start; t < end; t += HALF) s.push(t);
    return s;
  }, [start, end]);

  const days = useMemo(() => {
    const out: { label: string; t: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = -3; i <= 7; i++) {
      const d = new Date(today.getTime() + i * 86400000);
      out.push({ label: i === 0 ? 'Today' : i === -1 ? 'Yesterday' : i === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'short', day: 'numeric' }), t: d.getTime() });
    }
    return out;
  }, []);
  const dayOf = (t: number) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const width = HOURS * 60 * PX;
  const nowX = (now - start) / 60000 * PX;
  const atNow = now >= start && now < start + 2 * HALF;

  const onSelect = useCallback((p: Program, c: Channel, el: HTMLElement) => setSelected((s) => (s?.p.id === p.id ? null : { p, c, el })), []);
  const close = useCallback(() => setSelected(null), []);

  const replaceProgram = (p: Program) => {
    setPrograms((m) => {
      const n = new Map(m);
      n.set(p.channelId, (n.get(p.channelId) ?? []).map((x) => (x.id === p.id ? p : x)));
      return n;
    });
    setSelected((s) => (s ? { ...s, p } : s));
  };
  const replaceChannel = (c: Channel) => {
    setChannels((list) => (fav && !c.favorite ? list.filter((x) => x.id !== c.id) : list.map((x) => (x.id === c.id ? { ...x, favorite: c.favorite } : x))));
    setSelected((s) => (s ? { ...s, c } : s));
  };

  const visibleCats = (cats.data ?? []).filter((c) => !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const filter = (cat: string, f: boolean) => {
    setCategoryId(cat);
    setFav(f);
  };

  return (
    <div className={`page guide-page ${selected && wide ? 'has-panel' : ''}`}>
      <PageHeader
        className="guide-header"
        title={<>Guide <HelpLink slug="live-tv" label="TV guide" /></>}
        actions={(
          <>
            <select className="select" value={dayOf(start)} onChange={(e) => {
              const d = Number(e.target.value);
              setStart(d === dayOf(Date.now()) ? floorHalfHour(Date.now() - HALF) : d + 6 * 3600000);
            }} aria-label="Day">
              {days.map((d) => <option key={d.t} value={d.t}>{d.label}</option>)}
            </select>
            <div className="guide-nav" role="group" aria-label="Time">
              <button className="btn-icon btn-icon-sm" onClick={() => setStart((s) => s - 6 * 3600000)} aria-label="Earlier" title="Earlier"><Icon name="chevronLeft" size={18} /></button>
              <button className={`btn btn-sm ${atNow ? 'btn-ghost is-now' : ''}`} onClick={() => setStart(floorHalfHour(Date.now() - HALF))}>Now</button>
              <button className="btn-icon btn-icon-sm" onClick={() => setStart((s) => s + 6 * 3600000)} aria-label="Later" title="Later"><Icon name="chevronRight" size={18} /></button>
            </div>
            <Link to="/livetv" className="btn btn-sm btn-ghost"><Icon name="tv" size={16} /> Channels</Link>
          </>
        )}
      />
      <div className="chip-scroller guide-filters" role="group" aria-label="Filter channels">
        <Chip active={!categoryId && !fav} onClick={() => filter('', false)}>All channels</Chip>
        <Chip active={fav} icon={fav ? 'starFill' : 'star'} onClick={() => filter('', !fav)}>Favourites</Chip>
        <span className="chip-sep" aria-hidden="true" />
        {visibleCats.map((c) => (
          <Chip key={c.id} active={categoryId === c.id} onClick={() => filter(categoryId === c.id ? '' : c.id, false)}>{c.name}</Chip>
        ))}
      </div>

      <div className="guide-shell">
        {error && !channels.length ? (
          <ErrorState message={error} onRetry={() => load(0)} />
        ) : !loading && !channels.length ? (
          <EmptyState icon="guide" title={fav ? 'No favourite channels yet' : 'No guide data'} message={fav ? 'Open any programme and choose “Add channel to favourites”.' : 'Add a Live TV source with an EPG to fill the guide.'} action={<Link className="btn" to="/livetv">Browse channels</Link>} />
        ) : (
          <div className="guide-grid" ref={scroller} onScroll={onScroll} style={{ ['--px' as string]: `${PX}px`, ['--ch-w' as string]: `${CH_W}px`, ['--row-h' as string]: `${ROW_H}px` }}>
            <div className="guide-inner" style={{ width: width + CH_W }}>
              <div className="guide-ruler">
                <div className="guide-corner">{new Date(start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                <div className="guide-times" style={{ width }}>
                  {slots.map((t) => (
                    <span key={t} className="guide-time" style={{ left: ((t - start) / 60000) * PX }}>
                      {formatTime(new Date(t))}
                    </span>
                  ))}
                  {nowX >= 0 && nowX <= width && <span className="guide-now-head" style={{ left: nowX }}>{formatTime(new Date(now))}</span>}
                </div>
              </div>
              <div className="guide-body">
                {nowX >= 0 && nowX <= width && <div className="guide-now-line" style={{ left: CH_W + nowX }} aria-hidden="true" />}
                {channels.map((c) => (
                  <GuideRow key={c.id} channel={c} list={programs.get(c.id) ?? EMPTY} start={start} end={end} now={now} px={PX} width={width} selectedId={selected?.c.id === c.id ? selected.p.id : null} onSelect={onSelect} />
                ))}
                {loading && <div className="guide-loading"><Spinner /></div>}
              </div>
            </div>
          </div>
        )}
        {selected && wide && (
          <ProgramPanel program={selected.p} channel={selected.c} onClose={close} onChanged={replaceProgram} onChannelChanged={replaceChannel} returnFocus={selected.el} />
        )}
      </div>
      {typed && <div className="guide-typed" role="status" aria-live="polite">Channel {typed}</div>}
      {selected && !wide && <ProgramModal program={selected.p} channel={selected.c} onClose={close} onChanged={replaceProgram} onChannelChanged={replaceChannel} />}
    </div>
  );
}
