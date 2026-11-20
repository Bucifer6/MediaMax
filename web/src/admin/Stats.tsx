import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useAsync } from '../hooks';
import { EmptyState, ErrorState, Img, ProgressBar, Skeleton } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { BarChart, HBars, formatMinutes } from '../components/Charts';
import { AdminHeader } from './AdminRoutes';

const RANGES = [7, 30, 90, 365] as const;
type Range = (typeof RANGES)[number];

const METHODS: Record<string, { label: string; color: string }> = {
  direct: { label: 'Direct play', color: 'var(--c-success)' },
  remux: { label: 'Direct stream (remux)', color: 'var(--c-accent)' },
  transcode: { label: 'Transcode', color: 'var(--c-warning)' },
  live: { label: 'Live TV', color: 'var(--c-danger)' },
};

const PLATFORM_LABELS: Record<string, string> = {
  web: 'Web', ios: 'iOS', android: 'Android', androidtv: 'Android TV', tvos: 'Apple TV', roku: 'Roku', tizen: 'Samsung TV', webos: 'LG TV', dlna: 'DLNA', desktop: 'Desktop',
};

function Tile({ icon, label, value }: { icon: IconName; label: string; value: string }) {
  return (
    <div className="stat">
      <span className="stat-icon"><Icon name={icon} size={20} /></span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

function shortDate(iso: string, withYear = false) {
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return d.toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' });
}

export function StatsAdmin() {
  const [days, setDays] = useState<Range>(30);
  const res = useAsync((signal) => api.stats.server(days, signal), [days]);
  const s = res.data;

  const totalMethod = s ? s.byMethod.reduce((a, m) => a + m.plays, 0) : 0;
  const totalUserMinutes = s ? s.byUser.reduce((a, u) => a + u.minutes, 0) : 0;
  const perDay = s?.playsByDay ?? [];
  const axisEvery = perDay.length <= 7 ? 1 : perDay.length <= 31 ? 5 : perDay.length <= 90 ? 15 : 60;

  return (
    <div>
      <AdminHeader
        title="Statistics"
        subtitle="What your household has been playing."
        actions={<button className="btn" onClick={res.reload} disabled={res.loading}><Icon name="refresh" size={16} className={res.loading ? 'spin' : ''} /> Refresh</button>}
      />
      <div className="stats-toolbar">
        <div className="segmented" role="radiogroup" aria-label="Time range">
          {RANGES.map((r) => (
            <button key={r} role="radio" aria-checked={days === r} className={days === r ? 'active' : ''} onClick={() => setDays(r)}>
              {r === 365 ? '1 year' : `${r} days`}
            </button>
          ))}
        </div>
        <Link to="/wrapped" className="btn btn-ghost btn-sm"><Icon name="sparkles" size={14} /> Your year</Link>
      </div>

      {res.error ? <ErrorState message={res.error} onRetry={res.reload} /> : !s ? (
        <>
          <div className="stat-grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={104} />)}</div>
          <Skeleton h={260} style={{ marginTop: 16 }} />
        </>
      ) : (
        <div style={{ opacity: res.loading ? 0.6 : 1, transition: 'opacity 0.2s' }} aria-busy={res.loading}>
          <div className="stat-grid">
            <Tile icon="play" label="Plays" value={s.totalPlays.toLocaleString()} />
            <Tile icon="clock" label="Time played" value={formatMinutes(s.totalMinutes)} />
            <Tile icon="users" label="Active users" value={s.byUser.filter((u) => u.plays > 0).length.toLocaleString()} />
            <Tile icon="activity" label="Plays per day" value={(s.totalPlays / Math.max(1, s.days)).toFixed(1)} />
          </div>

          {s.totalPlays === 0 ? (
            <div className="stats-card" style={{ marginTop: 16 }}>
              <EmptyState icon="activity" title="No plays in this period" message="Statistics appear here as soon as someone watches or listens to something." />
            </div>
          ) : (
            <div className="stats-grid">
              <section className="stats-card stats-card-wide">
                <div className="stats-card-head">
                  <h2><Icon name="calendar" size={18} /> Plays per day</h2>
                  {perDay.length > 0 && <span className="muted">{shortDate(perDay[0].date, true)} – {shortDate(perDay[perDay.length - 1].date, true)}</span>}
                </div>
                <BarChart
                  title="Plays per day"
                  className={perDay.length > 45 ? 'dense' : ''}
                  height={200}
                  values={perDay.map((d) => d.plays)}
                  labels={perDay.map((d) => `${shortDate(d.date, true)} (${formatMinutes(d.minutes)})`)}
                  axisLabels={perDay.map((d, i) => (i % axisEvery === 0 ? shortDate(d.date) : null))}
                  format={(v) => `${v} play${v === 1 ? '' : 's'}`}
                />
              </section>

              <section className="stats-card stats-card-wide">
                <h2><Icon name="users" size={18} /> By user</h2>
                {s.byUser.length === 0 ? <p className="muted">No users played anything.</p> : (
                  <div className="table-wrap">
                    <table className="table">
                      <thead><tr><th>User</th><th className="td-num">Plays</th><th className="td-num">Time</th><th>Share of time</th><th /></tr></thead>
                      <tbody>
                        {s.byUser.map((u) => {
                          const share = totalUserMinutes ? (u.minutes / totalUserMinutes) * 100 : 0;
                          return (
                            <tr key={u.userId}>
                              <td><strong>{u.userName}</strong></td>
                              <td className="td-num">{u.plays.toLocaleString()}</td>
                              <td className="td-num">{formatMinutes(u.minutes)}</td>
                              <td><div className="stats-share"><ProgressBar value={share} /><span>{Math.round(share)}%</span></div></td>
                              <td className="td-actions">
                                <Link to={`/admin/users/${u.userId}/wrapped`} className="btn btn-ghost btn-sm" aria-label={`${u.userName}'s year in review`}>
                                  <Icon name="sparkles" size={14} /> Wrapped
                                </Link>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section className="stats-card">
                <h2><Icon name="gauge" size={18} /> Playback method</h2>
                {totalMethod === 0 ? <p className="muted">No data.</p> : (
                  <>
                    <div className="stats-method-bar" role="img" aria-label={s.byMethod.map((m) => `${METHODS[m.method]?.label ?? m.method}: ${m.plays}`).join(', ')}>
                      {s.byMethod.filter((m) => m.plays > 0).map((m) => (
                        <span key={m.method} style={{ flexGrow: m.plays, background: METHODS[m.method]?.color ?? 'var(--c-text-muted)' }} title={`${METHODS[m.method]?.label ?? m.method}: ${m.plays}`} />
                      ))}
                    </div>
                    <ul className="stats-legend">
                      {s.byMethod.map((m) => (
                        <li key={m.method}>
                          <i style={{ background: METHODS[m.method]?.color ?? 'var(--c-text-muted)' }} />
                          <span>{METHODS[m.method]?.label ?? m.method}</span>
                          <strong>{Math.round((m.plays / totalMethod) * 100)}%</strong>
                        </li>
                      ))}
                    </ul>
                  </>
                )}
              </section>

              <section className="stats-card">
                <h2><Icon name="device" size={18} /> Platforms</h2>
                {s.byPlatform.length === 0 ? <p className="muted">No data.</p> : (
                  <HBars
                    tone="accent"
                    rows={[...s.byPlatform].sort((a, b) => b.plays - a.plays).map((p) => ({ key: p.platform, label: PLATFORM_LABELS[p.platform] ?? p.platform, value: p.plays }))}
                    format={(v) => `${v.toLocaleString()} play${v === 1 ? '' : 's'}`}
                  />
                )}
              </section>

              {s.topItems.length > 0 && (
                <section className="stats-card stats-card-wide">
                  <h2><Icon name="flag" size={18} /> Most played</h2>
                  <ol className="stats-top">
                    {s.topItems.map((e, i) => {
                      const body = (
                        <>
                          <span className="wr-rank">{i + 1}</span>
                          <div className="wr-top-thumb"><Img src={e.posterUrl} width={80} alt="" fallback={<Icon name="film" size={16} />} /></div>
                          <div className="wr-top-text">
                            <strong>{e.title}</strong>
                            <span className="muted">{e.subtitle ? `${e.subtitle} · ` : ''}{e.plays.toLocaleString()} play{e.plays === 1 ? '' : 's'} · {formatMinutes(e.minutes)}</span>
                          </div>
                        </>
                      );
                      return <li key={`${e.itemId ?? e.title}-${i}`}>{e.itemId ? <Link to={`/item/${e.itemId}`}>{body}</Link> : <div>{body}</div>}</li>;
                    })}
                  </ol>
                </section>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
