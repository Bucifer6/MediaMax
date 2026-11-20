import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActiveSession } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, EmptyState, Img, ProgressBar, Skeleton, useConfirm } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { formatBitrate, formatBytes, formatClock, formatUptime, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

function Stat({ icon, label, value, to }: { icon: IconName; label: string; value: React.ReactNode; to?: string }) {
  const body = (
    <>
      <span className="stat-icon"><Icon name={icon} size={20} /></span>
      <span className="stat-value">{value}</span>
      <span className="stat-label">{label}</span>
    </>
  );
  return to ? <Link to={to} className="stat">{body}</Link> : <div className="stat">{body}</div>;
}

function SessionCard({ s, onKill }: { s: ActiveSession; onKill: (s: ActiveSession) => void }) {
  const pct = s.durationMs ? (s.positionMs / s.durationMs) * 100 : 0;
  return (
    <div className="session-card">
      <div className="session-art"><Img src={s.posterUrl} width={160} fallback={<Icon name={s.channelId ? 'tv' : 'film'} size={24} />} /></div>
      <div className="session-body">
        <div className="session-title">{s.title}</div>
        {s.subtitle && <div className="muted session-sub">{s.subtitle}</div>}
        <div className="session-meta">
          <span><Icon name="user" size={13} /> {s.userName}</span>
          <span><Icon name={s.platform === 'web' ? 'monitor' : 'device'} size={13} /> {s.deviceName}</span>
          {s.remoteAddress && <span><Icon name="globe" size={13} /> {s.remoteAddress}</span>}
        </div>
        <div className="session-badges">
          <Badge tone={s.state === 'playing' ? 'success' : s.state === 'paused' ? 'muted' : 'warning'}>{s.state}</Badge>
          <Badge tone={s.method === 'transcode' ? 'warning' : s.method === 'live' ? 'danger' : 'accent'}>{s.method}</Badge>
          {s.transcodeInfo && (
            <Badge tone="muted">
              {s.transcodeInfo.videoCodec}/{s.transcodeInfo.audioCodec} · {formatBitrate(s.transcodeInfo.bitrate)} · {s.transcodeInfo.hwAccel === 'none' ? 'CPU' : s.transcodeInfo.hwAccel.toUpperCase()}
              {s.transcodeInfo.toneMap ? ` · HDR→SDR (${s.transcodeInfo.toneMap})` : ''}
            </Badge>
          )}
          {s.transcodeInfo?.hwFallback && (
            <span title={s.transcodeInfo.hwFallback}><Badge tone="warning">Hardware transcoding failed, used {s.transcodeInfo.hwAccel === 'none' ? 'software' : 'CPU tone-mapping'}</Badge></span>
          )}
        </div>
        {s.durationMs ? (
          <div className="session-progress">
            <ProgressBar value={pct} />
            <small className="muted">{formatClock(s.positionMs)} / {formatClock(s.durationMs)}</small>
          </div>
        ) : (
          <small className="muted">Started {relativeTime(s.startedAt)}</small>
        )}
      </div>
      <button className="btn-icon session-kill" onClick={() => onKill(s)} title="Stop stream" aria-label="Stop stream"><Icon name="x" size={18} /></button>
    </div>
  );
}

export function Overview() {
  const toast = useToast();
  const confirm = useConfirm();
  const stats = useAsync(() => api.system.stats(), []);
  const [sessions, setSessions] = useState<ActiveSession[] | null>(null);
  const activity = useAsync(() => api.admin.activity(8, 0), []);

  useEffect(() => {
    api.playback.sessions().then(setSessions).catch(() => setSessions([]));
    const t = window.setInterval(() => stats.reload(), 60000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useServerEvent((ev) => {
    if (ev.type === 'sessions.updated') setSessions(ev.sessions);
  });

  const kill = async (s: ActiveSession) => {
    if (!(await confirm({ title: `Stop ${s.userName}'s stream?`, message: s.title, confirmLabel: 'Stop stream', danger: true }))) return;
    try {
      await api.playback.kill(s.id, 'Stopped by administrator');
      setSessions((l) => (l ?? []).filter((x) => x.id !== s.id));
      toast.success('Stream stopped');
    } catch (e) {
      toast.error(e);
    }
  };

  const st = stats.data;
  return (
    <div>
      <AdminHeader help="admin-setup" title="Overview" subtitle={st ? `MediaMax ${st.version} · up ${formatUptime(st.uptimeSeconds)}` : undefined} />
      <div className="stat-grid">
        {!st ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={104} />) : (
          <>
            <Stat icon="film" label="Movies" value={st.movies.toLocaleString()} to="/admin/libraries" />
            <Stat icon="shows" label="Shows" value={st.shows.toLocaleString()} to="/admin/libraries" />
            <Stat icon="layers" label="Episodes" value={st.episodes.toLocaleString()} />
            <Stat icon="music" label="Tracks" value={st.tracks.toLocaleString()} />
            <Stat icon="tv" label="Channels" value={st.channels.toLocaleString()} to="/admin/channels" />
            <Stat icon="users" label="Users" value={st.users} to="/admin/users" />
            <Stat icon="play" label="Streams / transcodes" value={`${sessions?.length ?? st.activeSessions} / ${sessions ? sessions.filter((s) => s.method === 'transcode').length : st.transcodes}`} />
            <Stat icon="recordOutline" label="Recordings scheduled" value={st.recordingsScheduled} />
            <Stat icon="database" label="Free disk" value={formatBytes(st.diskFreeBytes)} />
            <Stat icon="server" label="Libraries" value={st.libraries} to="/admin/libraries" />
          </>
        )}
      </div>
      {stats.error && <p className="form-error">{stats.error}</p>}

      <section className="admin-section">
        <h2 className="section-title">Now playing {sessions && sessions.length > 0 && <Badge tone="success">{sessions.length}</Badge>}</h2>
        {sessions === null ? <Skeleton h={120} /> : sessions.length === 0 ? (
          <EmptyState icon="play" title="Nobody is watching right now" message="Active streams appear here in real time." />
        ) : (
          <div className="session-grid">{sessions.map((s) => <SessionCard key={s.id} s={s} onKill={kill} />)}</div>
        )}
      </section>

      <section className="admin-section">
        <h2 className="section-title">Recent activity <Link to="/admin/activity" className="see-all">See all</Link></h2>
        {activity.data?.items.length ? (
          <ul className="activity-list compact">
            {activity.data.items.map((a) => (
              <li key={a.id} className={`sev-${a.severity}`}>
                <span className="activity-dot" />
                <span className="activity-msg">{a.message}</span>
                <span className="muted">{relativeTime(a.at)}</span>
              </li>
            ))}
          </ul>
        ) : <p className="muted">{activity.loading ? 'Loading…' : 'No activity yet.'}</p>}
      </section>
    </div>
  );
}
