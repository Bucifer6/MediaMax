import type { ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { StatsTopEntry, UserStats } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { Icon, type IconName } from '../components/Icon';
import { ErrorState, Img, Skeleton } from '../components/ui';
import { BarChart, CountUp, HBars, formatMinutes } from '../components/Charts';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function hourLabel(h: number, short = false) {
  const d = new Date(2000, 0, 1, h);
  return d.toLocaleTimeString(undefined, short ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' });
}

function TopList({ title, icon, entries, unit }: { title: string; icon: IconName; entries: StatsTopEntry[]; unit: 'time' | 'plays' }) {
  if (!entries.length) return null;
  const [first, ...rest] = entries;
  const metric = (e: StatsTopEntry) => (unit === 'plays' ? `${e.plays.toLocaleString()} play${e.plays === 1 ? '' : 's'}` : formatMinutes(e.minutes));
  const wrap = (e: StatsTopEntry, body: ReactNode, cls: string) =>
    e.itemId ? <Link to={`/item/${e.itemId}`} className={cls}>{body}</Link> : <div className={cls}>{body}</div>;
  return (
    <section className="wr-card wr-top">
      <h2 className="wr-card-title"><Icon name={icon} size={18} /> {title}</h2>
      {wrap(first, (
        <>
          <div className="wr-top-poster">
            <Img src={first.posterUrl} width={240} alt="" fallback={<Icon name={icon} size={32} />} />
            <span className="wr-rank wr-rank-1">1</span>
          </div>
          <div className="wr-top-hero-text">
            <strong>{first.title}</strong>
            {first.subtitle && <span className="muted">{first.subtitle}</span>}
            <span className="wr-top-metric">{metric(first)}</span>
          </div>
        </>
      ), 'wr-top-hero')}
      {rest.length > 0 && (
        <ol className="wr-top-list" start={2}>
          {rest.slice(0, 4).map((e, i) => (
            <li key={`${e.itemId ?? e.title}-${i}`}>
              {wrap(e, (
                <>
                  <span className="wr-rank">{i + 2}</span>
                  <div className="wr-top-thumb"><Img src={e.posterUrl} width={80} alt="" fallback={<Icon name={icon} size={16} />} /></div>
                  <div className="wr-top-text">
                    <strong>{e.title}</strong>
                    {e.subtitle && <span className="muted">{e.subtitle}</span>}
                  </div>
                  <span className="wr-top-metric">{metric(e)}</span>
                </>
              ), 'wr-top-row')}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BigStat({ value, decimals, unit, label, icon }: { value: number; decimals?: number; unit: string; label: string; icon: IconName }) {
  return (
    <div className="wr-big">
      <span className="wr-big-icon"><Icon name={icon} size={20} /></span>
      <span className="wr-big-value"><CountUp value={value} decimals={decimals} /><small>{unit}</small></span>
      <span className="wr-big-label">{label}</span>
    </div>
  );
}

function peakIndex(values: number[]) {
  const max = Math.max(0, ...values);
  return max > 0 ? values.indexOf(max) : -1;
}

function WrappedBody({ s, name, self }: { s: UserStats; name: string; self: boolean }) {
  const hours = s.totalMinutes / 60;
  const peakMonth = peakIndex(s.minutesByMonth);
  const peakDay = peakIndex(s.minutesByWeekday);
  const peakHour = peakIndex(s.minutesByHour);
  const minorStats: { icon: IconName; label: string; value: string }[] = [
    { icon: 'film', label: 'Movies', value: s.moviesWatched.toLocaleString() },
    { icon: 'shows', label: 'Episodes', value: s.episodesWatched.toLocaleString() },
    { icon: 'music', label: 'Tracks', value: s.tracksPlayed.toLocaleString() },
    { icon: 'tv', label: 'Live TV', value: formatMinutes(s.liveTvMinutes) },
  ];
  const who = self ? 'You' : name;
  return (
    <>
      <div className="wr-bigs">
        <BigStat icon="clock" value={hours} decimals={hours < 10 ? 1 : 0} unit="hrs" label={`${who} spent watching & listening`} />
        <BigStat icon="play" value={s.totalPlays} unit="plays" label="Things pressed play on" />
        <BigStat icon="zap" value={s.longestStreakDays} unit={s.longestStreakDays === 1 ? 'day' : 'days'} label="Longest streak in a row" />
      </div>

      <div className="wr-minor">
        {minorStats.map((m) => (
          <div key={m.label} className="wr-minor-stat">
            <Icon name={m.icon} size={18} />
            <strong>{m.value}</strong>
            <span>{m.label}</span>
          </div>
        ))}
      </div>

      {s.highlights.length > 0 && (
        <section className="wr-highlights" aria-label="Highlights">
          {s.highlights.map((h, i) => (
            <p key={i} className="wr-highlight" style={{ animationDelay: `${i * 90}ms` }}>
              <Icon name="sparkles" size={18} />
              <span>{h}</span>
            </p>
          ))}
        </section>
      )}

      <div className="wr-grid">
        <TopList title="Top shows" icon="shows" entries={s.topShows} unit="time" />
        <TopList title="Top movies" icon="film" entries={s.topMovies} unit="time" />
        <TopList title="Top artists" icon="music" entries={s.topArtists} unit="plays" />
        <TopList title="Top channels" icon="tv" entries={s.topChannels} unit="time" />
      </div>

      <div className="wr-grid">
        {s.topGenres.length > 0 && (
          <section className="wr-card">
            <h2 className="wr-card-title"><Icon name="layers" size={18} /> Top genres</h2>
            <HBars rows={s.topGenres.slice(0, 8).map((g) => ({ label: g.genre, value: g.minutes, key: g.genre }))} format={formatMinutes} />
          </section>
        )}
        {s.year != null && s.minutesByMonth.length === 12 && (
          <section className="wr-card">
            <h2 className="wr-card-title"><Icon name="calendar" size={18} /> Month by month</h2>
            {peakMonth >= 0 && <p className="wr-chart-note">{MONTHS_LONG[peakMonth]} was {self ? 'your' : 'their'} biggest month.</p>}
            <BarChart title="Minutes by month" values={s.minutesByMonth} labels={MONTHS_LONG} axisLabels={MONTHS.map((m) => m[0])} format={formatMinutes} />
          </section>
        )}
        {s.minutesByWeekday.length === 7 && (
          <section className="wr-card">
            <h2 className="wr-card-title"><Icon name="calendar" size={18} /> Favourite day</h2>
            {peakDay >= 0 && <p className="wr-chart-note">{DAYS_LONG[peakDay]}s were made for watching.</p>}
            <BarChart title="Minutes by weekday" values={s.minutesByWeekday} labels={DAYS_LONG} axisLabels={DAYS} format={formatMinutes} />
          </section>
        )}
        {s.minutesByHour.length === 24 && (
          <section className="wr-card">
            <h2 className="wr-card-title"><Icon name="clock" size={18} /> Time of day</h2>
            {peakHour >= 0 && <p className="wr-chart-note">Peak time: {hourLabel(peakHour)}{peakHour >= 22 || peakHour < 4 ? ' — a true night owl.' : peakHour < 9 ? ' — an early bird!' : '.'}</p>}
            <BarChart
              title="Minutes by hour"
              values={s.minutesByHour}
              labels={s.minutesByHour.map((_, h) => hourLabel(h))}
              axisLabels={s.minutesByHour.map((_, h) => (h % 6 === 0 ? hourLabel(h, true) : null))}
              format={formatMinutes}
            />
          </section>
        )}
      </div>
    </>
  );
}

/** "Your Year" page. With `userId` (admin route) it shows that user's stats. */
export default function WrappedPage() {
  const { userId } = useParams();
  const { user, branding } = useApp();
  const [sp, setSp] = useSearchParams();
  const now = new Date().getFullYear();
  const rawYear = sp.get('year');
  const year = rawYear === 'all' ? null : rawYear && /^\d{4}$/.test(rawYear) ? Number(rawYear) : now;
  const setYear = (y: number | null) => setSp({ year: y == null ? 'all' : String(y) }, { replace: true });
  const res = useAsync(
    (signal) => (userId ? api.stats.user(userId, year, signal) : api.stats.me(year, signal)),
    [userId, year],
  );
  const other = useAsync(async () => (userId ? (await api.users.list()).find((u) => u.id === userId) ?? null : null), [userId]);
  const self = !userId || userId === user?.id;
  const name = self ? user?.displayName || user?.username || 'You' : other.data?.displayName || other.data?.username || 'This user';

  const years = Array.from({ length: 6 }, (_, i) => now - i);
  const s = res.data;
  const empty = !!s && s.totalPlays === 0 && s.totalMinutes === 0;
  const period = year == null ? 'all time' : String(year);

  return (
    <div className={`${userId ? '' : 'page '}wrapped`}>
      <header className="wr-hero">
        <div className="wr-hero-glow" aria-hidden="true" />
        <div className="wr-hero-inner">
          <span className="wr-eyebrow"><Icon name="sparkles" size={14} /> {branding.serverName} Wrapped</span>
          <h1>
            {self ? 'Your' : `${name}’s`} {year == null ? <>story <em>so far</em></> : <><em>{year}</em> in review</>}
          </h1>
          {!self && userId && <p className="wr-sub">Viewing as an administrator · <Link to="/admin/stats">Back to statistics</Link></p>}
          <div className="wr-years" role="radiogroup" aria-label="Period">
            {years.map((y) => (
              <button key={y} role="radio" aria-checked={year === y} className={`wr-year ${year === y ? 'active' : ''}`} onClick={() => setYear(y)}>{y}</button>
            ))}
            <button role="radio" aria-checked={year == null} className={`wr-year ${year == null ? 'active' : ''}`} onClick={() => setYear(null)}>All time</button>
          </div>
        </div>
      </header>

      {res.error ? (
        <ErrorState message={res.error} onRetry={res.reload} />
      ) : !s ? (
        <div className="wr-bigs">
          {[0, 1, 2].map((i) => <Skeleton key={i} h={170} r={24} />)}
        </div>
      ) : empty ? (
        <div className="wr-empty">
          <div className="wr-empty-icon"><Icon name="play" size={36} /></div>
          <h2>Nothing played {year == null ? 'yet' : `in ${year}`}</h2>
          <p className="muted">
            {self
              ? year === now
                ? 'Your story starts with the first thing you watch or listen to. Come back once you’ve pressed play a few times.'
                : `There’s no watch history for ${period}. Try another year.`
              : `${name} hasn’t played anything in ${period}.`}
          </p>
          {self && <Link to="/" className="btn btn-primary"><Icon name="home" size={16} /> Find something to watch</Link>}
        </div>
      ) : (
        <div className={`wr-body ${res.loading ? 'is-loading' : ''}`} aria-busy={res.loading}>
          <WrappedBody s={s} name={name} self={self} />
        </div>
      )}
    </div>
  );
}
