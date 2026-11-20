import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CalendarEntry } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { Row } from '../components/Row';
import { dayLabel, epCode, UpcomingCard } from '../components/Cards';
import { Badge, EmptyState, ErrorState, Img, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { itemLink, posterFor } from '../utils/items';

const DAY = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
/** Local YYYY-MM-DD. */
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
function startOfWeek(d: Date): Date {
  const day = (d.getDay() + 6) % 7; // Monday first
  return addDays(new Date(d.getFullYear(), d.getMonth(), d.getDate()), -day);
}
const weekdayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const rangeFmt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });

/** Added episodes collapse to one entry per show and day ("3 new episodes"). */
function collapseAdded(entries: CalendarEntry[]): (CalendarEntry & { count: number })[] {
  const map = new Map<string, CalendarEntry & { count: number }>();
  for (const e of entries) {
    const k = e.kind === 'added' ? `a:${e.show.id}:${e.date}` : `u:${e.show.id}:${e.date}:${e.episodeNumber}`;
    const cur = map.get(k);
    if (cur) {
      cur.count++;
      // Keep the earliest episode as the representative.
      if ((e.seasonNumber ?? 0) * 1000 + (e.episodeNumber ?? 0) < (cur.seasonNumber ?? 0) * 1000 + (cur.episodeNumber ?? 0)) Object.assign(cur, { ...e, count: cur.count });
    } else map.set(k, { ...e, count: 1 });
  }
  return [...map.values()];
}

function EntryLine({ e, compact }: { e: CalendarEntry & { count?: number }; compact?: boolean }) {
  const code = epCode(e.seasonNumber, e.episodeNumber);
  return (
    <Link to={itemLink(e.episode ?? e.show)} className={`cal-entry ${e.kind} ${e.following ? 'following' : ''} ${compact ? 'compact' : ''}`} data-nav>
      <span className="cal-poster">
        <Img src={posterFor(e.show)} width={120} alt="" fallback={<Icon name="shows" size={18} />} />
      </span>
      <span className="cal-text">
        <span className="cal-show">{e.show.title}</span>
        <span className="cal-ep">
          {e.kind === 'added' ? <Badge tone="primary">{e.count && e.count > 1 ? `${e.count} new` : 'New'}</Badge> : null}
          {code}
        </span>
        {!(e.count && e.count > 1) && e.title && <span className="cal-eptitle">{e.title}</span>}
        {!compact && e.overview && <span className="cal-overview">{e.overview}</span>}
      </span>
      {e.following && <span className="follow-dot" title="You watch this show" />}
    </Link>
  );
}

function WeekView({ weekStart, entries, loading }: { weekStart: Date; entries: CalendarEntry[]; loading: boolean }) {
  const today = ymd(new Date());
  const days = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
  const byDay = useMemo(() => {
    const m = new Map<string, (CalendarEntry & { count: number })[]>();
    for (const e of collapseAdded(entries)) {
      if (!m.has(e.date)) m.set(e.date, []);
      m.get(e.date)!.push(e);
    }
    return m;
  }, [entries]);
  return (
    <div className="cal-week" role="list">
      {days.map((d) => {
        const key = ymd(d);
        const list = byDay.get(key) ?? [];
        return (
          <section key={key} className={`cal-day ${key === today ? 'today' : ''} ${list.length ? '' : 'empty'}`} role="listitem" aria-label={dayLabel(key)}>
            <header className="cal-day-head">
              <span className="cal-dow">{weekdayFmt.format(d)}</span>
              <span className="cal-date">{d.getDate()}</span>
              {key === today && <span className="cal-today">Today</span>}
            </header>
            <div className="cal-day-body">
              {loading && !list.length ? <Skeleton h={48} /> : list.length ? list.map((e, i) => <EntryLine key={i} e={e} compact />) : <span className="cal-none">—</span>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

export default function CalendarPage() {
  const { user } = useApp();
  const [weekStart, setWeekStart] = useState(() => startOfWeek(new Date()));
  const week = useAsync((signal) => api.discovery.calendar({ from: ymd(weekStart), to: ymd(addDays(weekStart, 6)) }, signal), [weekStart.getTime()]);
  const todayD = new Date();
  const agenda = useAsync((signal) => api.discovery.calendar({ from: ymd(addDays(todayD, -7)), to: ymd(addDays(todayD, 60)) }, signal), []);
  const thisWeek = startOfWeek(new Date()).getTime() === weekStart.getTime();
  const tmdb = (week.data ?? agenda.data)?.tmdbConfigured ?? true;
  const today = ymd(todayD);

  const newThisWeek = useMemo(() => {
    const added = (agenda.data?.entries ?? []).filter((e) => e.kind === 'added');
    const byShow = new Map<string, CalendarEntry & { count: number }>();
    for (const e of added) {
      const cur = byShow.get(e.show.id);
      if (cur) cur.count++;
      else byShow.set(e.show.id, { ...e, count: 1 });
    }
    return [...byShow.values()].sort((a, b) => Number(b.following) - Number(a.following) || b.date.localeCompare(a.date));
  }, [agenda.data]);

  const comingSoon = useMemo(() => {
    const up = (agenda.data?.entries ?? []).filter((e) => e.kind === 'upcoming' && e.date >= today);
    const groups = new Map<string, CalendarEntry[]>();
    for (const e of up) {
      if (!groups.has(e.date)) groups.set(e.date, []);
      groups.get(e.date)!.push(e);
    }
    return [...groups.entries()];
  }, [agenda.data, today]);

  const weekEnd = addDays(weekStart, 6);
  return (
    <div className="page calendar-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="calendar" size={28} className="page-icon" />
          <h1>Calendar</h1>
        </div>
        <div className="cal-nav">
          <button className="btn-icon" onClick={() => setWeekStart((w) => addDays(w, -7))} aria-label="Previous week"><Icon name="chevronLeft" /></button>
          <button className={`btn btn-sm ${thisWeek ? 'btn-primary' : ''}`} onClick={() => setWeekStart(startOfWeek(new Date()))}>This week</button>
          <button className="btn-icon" onClick={() => setWeekStart((w) => addDays(w, 7))} aria-label="Next week"><Icon name="chevronRight" /></button>
          <span className="cal-range muted">{rangeFmt.format(weekStart)} – {rangeFmt.format(weekEnd)}</span>
        </div>
      </header>

      {!tmdb && (
        <div className="cal-notice">
          <Icon name="info" size={20} />
          <div>
            <strong>Upcoming episodes need TV schedule data</strong>
            <p className="muted">
              The calendar can show newly added episodes, but air dates for upcoming episodes come from TMDB, which isn't set up on this server.
              {user?.isAdmin ? <> Add a TMDB API key in <Link to="/admin/settings">Server settings</Link>.</> : ' Ask your server admin to add a TMDB API key.'}
            </p>
          </div>
        </div>
      )}

      {week.error && !week.data ? <ErrorState message={week.error} onRetry={week.reload} /> : <WeekView weekStart={weekStart} entries={week.data?.entries ?? []} loading={week.loading} />}

      {newThisWeek.length > 0 && (
        <Row title="New episodes this week" className="row-wide cal-new">
          {newThisWeek.map((e) => (
            <UpcomingCard key={e.show.id} entry={{ ...e, title: e.count > 1 ? `${e.count} new episodes` : e.title }} />
          ))}
        </Row>
      )}

      <section className="cal-agenda">
        <h2 className="section-title">Coming soon</h2>
        {agenda.loading && !agenda.data ? (
          <Skeleton h={120} />
        ) : comingSoon.length ? (
          comingSoon.map(([date, list]) => (
            <div key={date} className="cal-agenda-day">
              <h3 className="cal-agenda-date">
                {dayLabel(date)}
                <small className="muted">{new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(`${date}T12:00:00`))}</small>
              </h3>
              <div className="cal-agenda-list">{list.map((e, i) => <EntryLine key={i} e={e} />)}</div>
            </div>
          ))
        ) : (
          <EmptyState
            icon="calendar"
            title={tmdb ? 'Nothing scheduled yet' : 'No schedule data'}
            message={tmdb ? 'When shows in your libraries announce new episodes, their air dates appear here.' : 'Upcoming air dates appear here once TMDB is configured.'}
          />
        )}
      </section>
    </div>
  );
}
