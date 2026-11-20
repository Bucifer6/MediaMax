import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { Channel, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useAsync, useMediaQuery, useNow } from '../hooks';
import { EmptyState, ErrorState, Img, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { ProgramModal } from '../components/ProgramModal';
import { formatTime } from '../utils/format';

const HOURS = 12;
const PAGE = 60;
const HALF = 30 * 60000;

function floorHalfHour(t: number) {
  return Math.floor(t / HALF) * HALF;
}

export default function GuidePage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const mobile = useMediaQuery('(max-width: 700px)');
  const PX = mobile ? 4 : 6; // px per minute
  const CH_W = mobile ? 92 : 220;
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
  const [selected, setSelected] = useState<{ p: Program; c: Channel } | null>(null);
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
        const g = await api.livetv.guide({ start: new Date(start).toISOString(), end: new Date(end).toISOString(), categoryId: categoryId || undefined, favorite: fav || undefined, offset, limit: PAGE });
        if (id !== req.current) return;
        setChannels((c) => (offset ? [...c, ...g.channels] : g.channels));
        setPrograms((prev) => {
          const m = offset ? new Map(prev) : new Map<string, Program[]>();
          for (const p of g.programs) {
            const list = m.get(p.channelId) ?? [];
            list.push(p);
            m.set(p.channelId, list);
          }
          for (const list of m.values()) list.sort((a, b) => a.start.localeCompare(b.start));
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
  }, [start, PX]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el || loading || !hasMore) return;
    if (el.scrollTop + el.clientHeight > el.scrollHeight - ROW_H * 6) void load(channels.length);
  };

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

  const replaceProgram = (p: Program) => {
    setPrograms((m) => {
      const n = new Map(m);
      n.set(p.channelId, (n.get(p.channelId) ?? []).map((x) => (x.id === p.id ? p : x)));
      return n;
    });
    setSelected((s) => (s ? { ...s, p } : s));
  };

  return (
    <div className="page guide-page">
      <header className="page-head guide-head">
        <div className="page-title-wrap">
          <Icon name="guide" size={28} className="page-icon" />
          <h1>TV Guide</h1>
        </div>
        <div className="guide-controls">
          <select className="select" value={dayOf(start)} onChange={(e) => {
            const d = Number(e.target.value);
            setStart(d === dayOf(Date.now()) ? floorHalfHour(Date.now() - HALF) : d + 6 * 3600000);
          }} aria-label="Day">
            {days.map((d) => <option key={d.t} value={d.t}>{d.label}</option>)}
          </select>
          <div className="segmented">
            <button onClick={() => setStart((s) => s - 6 * 3600000)} aria-label="Earlier"><Icon name="chevronLeft" size={16} /></button>
            <button onClick={() => setStart(floorHalfHour(Date.now() - HALF))}>Now</button>
            <button onClick={() => setStart((s) => s + 6 * 3600000)} aria-label="Later"><Icon name="chevronRight" size={16} /></button>
          </div>
          <select className="select" value={categoryId} onChange={(e) => setCategoryId(e.target.value)} aria-label="Category">
            <option value="">All categories</option>
            {(cats.data ?? []).filter((c) => !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button className={`chip ${fav ? 'active' : ''}`} onClick={() => setFav((f) => !f)}><Icon name={fav ? 'starFill' : 'star'} size={14} /> Favourites</button>
        </div>
      </header>

      {error && !channels.length ? (
        <ErrorState message={error} onRetry={() => load(0)} />
      ) : !loading && !channels.length ? (
        <EmptyState icon="guide" title="No guide data" message={fav ? 'You have no favourite channels yet.' : 'Add a Live TV source with an EPG to fill the guide.'} action={<Link className="btn" to="/livetv">Browse channels</Link>} />
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
              {nowX >= 0 && nowX <= width && <div className="guide-now-line" style={{ left: CH_W + nowX }} />}
              {channels.map((c) => {
                const list = programs.get(c.id) ?? [];
                return (
                  <div className="guide-row" key={c.id}>
                    <button className="guide-channel" onClick={() => navigate(`/watch/live/${c.id}`)} title={`Watch ${c.name}`}>
                      <span className="gc-num">{c.number ?? ''}</span>
                      <span className="gc-logo"><Img src={c.logoUrl} width={120} alt={c.name} fallback={<span className="ch-logo-text">{c.name.slice(0, 4)}</span>} /></span>
                      <span className="gc-name">{c.name}</span>
                      {c.favorite && <Icon name="starFill" size={12} className="gc-fav" />}
                    </button>
                    <div className="guide-programs" style={{ width }}>
                      {list.length === 0 && <div className="guide-empty">No information</div>}
                      {list.map((p) => {
                        const s = new Date(p.start).getTime();
                        const e = new Date(p.end).getTime();
                        if (e <= start || s >= end) return null;
                        const left = ((Math.max(s, start) - start) / 60000) * PX;
                        const w = ((Math.min(e, end) - Math.max(s, start)) / 60000) * PX;
                        const live = s <= now && e > now;
                        const past = e <= now;
                        return (
                          <button
                            key={p.id}
                            className={`guide-prog ${live ? 'live' : ''} ${past ? 'past' : ''} ${p.recordingId ? 'rec' : ''} ${w < 60 ? 'tiny' : ''}`}
                            style={{ left, width: Math.max(2, w - 3) }}
                            onClick={() => setSelected({ p, c })}
                            title={`${p.title} · ${formatTime(p.start)}–${formatTime(p.end)}`}
                          >
                            <span className="gp-title">
                              {p.recordingId && <Icon name="record" size={10} className="text-danger" />} {p.isNew && <span className="gp-new">NEW</span>} {p.title}
                            </span>
                            <span className="gp-time">{formatTime(p.start)} – {formatTime(p.end)}</span>
                            {live && <span className="gp-progress" style={{ width: `${((now - s) / (e - s)) * 100}%` }} />}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
              {loading && <div className="guide-loading"><Spinner /></div>}
            </div>
          </div>
        </div>
      )}
      {selected && <ProgramModal program={selected.p} channel={selected.c} onClose={() => setSelected(null)} onChanged={replaceProgram} />}
    </div>
  );
}
