import type React from 'react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ActiveSession, SessionDetails, StreamAction } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, EmptyState, Field, Img, Modal, ProgressBar, Skeleton, useConfirm } from '../components/ui';
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

const ACTION_LABEL: Record<StreamAction, string> = {
  direct: 'Direct Play', copy: 'Direct Stream', transcode: 'Transcode', 'burn-in': 'Burn-in', external: 'External file', embedded: 'Extracted from file', live: 'Live',
};

function Outcome({ children }: { children: React.ReactNode }) {
  return <div className="session-outcome"><Icon name="chevronRight" size={13} /> <span>{children}</span></div>;
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="session-row">
      <span className="session-row-label">{label}</span>
      <div className="session-row-body">{children}</div>
    </div>
  );
}

function SessionDetailsView({ s, d }: { s: ActiveSession; d: SessionDetails }) {
  const st = d.stream;
  return (
    <>
      <div className="session-client">
        <Icon name={s.platform === 'web' ? 'monitor' : s.platform === 'androidtv' || s.platform === 'tvos' || s.platform === 'roku' ? 'tv' : 'device'} size={22} />
        <div>
          <div>{d.client.app}{d.client.version ? ` ${d.client.version}` : ''}{d.client.browser ? <span className="muted"> · {d.client.browser}</span> : null}</div>
          <div className="muted">{s.deviceName}</div>
          <div className="muted">
            {s.remoteAddress ?? 'unknown address'}
            {d.client.protocol ? ` ${d.client.protocol.toLowerCase()}` : ''}
            {d.client.secure && <> <Icon name="lock" size={11} /></>}
            <Badge tone={d.client.local ? 'muted' : 'accent'} className="session-net">{d.client.local ? 'LAN' : 'Remote'}</Badge>
          </div>
        </div>
      </div>
      <div className="session-rows">
        <DetailRow label="Stream">
          <div>{st.container ?? 'Unknown'}{st.bitrate ? ` (${formatBitrate(st.bitrate)})` : ''}</div>
          <Outcome>{st.delivery}{st.outputBitrate ? ` (${formatBitrate(st.outputBitrate)})` : ''}</Outcome>
          {st.reasons.map((r) => <div key={r} className="session-reason">{r}</div>)}
        </DetailRow>
        {d.video && (
          <DetailRow label="Video">
            <div>{d.video.label}{d.video.range ? ` ${d.video.range}` : ''}{d.video.frameRate ? <span className="muted"> · {Math.round(d.video.frameRate * 100) / 100} fps</span> : null}</div>
            <Outcome>{ACTION_LABEL[d.video.action]}{d.video.action === 'transcode' && d.video.notes[0] ? ` (${d.video.notes[0]})` : ''}</Outcome>
            {(d.video.action === 'transcode' ? d.video.notes.slice(1) : d.video.notes).map((n) => <Outcome key={n}>{n}</Outcome>)}
          </DetailRow>
        )}
        {d.audio && (
          <DetailRow label="Audio">
            <div>{d.audio.label}</div>
            <Outcome>{ACTION_LABEL[d.audio.action]}{d.audio.output ? ` (${d.audio.output})` : ''}</Outcome>
          </DetailRow>
        )}
        {d.subtitle && (
          <DetailRow label="Subtitles">
            <div>{d.subtitle.label}</div>
            <Outcome>{ACTION_LABEL[d.subtitle.action]}</Outcome>
          </DetailRow>
        )}
      </div>
    </>
  );
}

function SessionCard({ s, onKill, onCommand, onMessage }: {
  s: ActiveSession; onKill: (s: ActiveSession) => void; onCommand: (s: ActiveSession, action: 'pause' | 'play') => void; onMessage: (s: ActiveSession) => void;
}) {
  const pct = s.durationMs ? (s.positionMs / s.durationMs) * 100 : 0;
  return (
    <div className="session-card">
      <div className="session-head">
        <div className={`session-art${s.channelId ? ' is-logo' : ''}`}><Img src={s.posterUrl} width={160} fallback={<Icon name={s.channelId ? 'tv' : 'film'} size={24} />} /></div>
        <div className="session-body">
          <div className="session-title">{s.title}</div>
          {s.subtitle && <div className="muted session-sub">{s.subtitle}</div>}
          {s.durationMs ? (
            <small className="muted session-time">{formatClock(s.positionMs)} / {formatClock(s.durationMs)}</small>
          ) : (
            <small className="muted session-time">Started {relativeTime(s.startedAt)}</small>
          )}
          <div className="session-badges">
            <Badge tone={s.state === 'playing' ? 'success' : s.state === 'paused' ? 'muted' : 'warning'}>{s.state}</Badge>
            <Badge tone={s.method === 'transcode' ? 'warning' : s.method === 'live' ? 'danger' : 'accent'}>{s.method}</Badge>
            {!s.details && s.transcodeInfo && (
              <Badge tone="muted">
                {s.transcodeInfo.videoCodec}/{s.transcodeInfo.audioCodec} · {formatBitrate(s.transcodeInfo.bitrate)} · {s.transcodeInfo.hwAccel === 'none' ? 'CPU' : s.transcodeInfo.hwAccel.toUpperCase()}
              </Badge>
            )}
          </div>
        </div>
      </div>
      {s.durationMs ? <ProgressBar value={pct} className="session-bar" /> : null}
      {s.details ? <SessionDetailsView s={s} d={s.details} /> : (
        <div className="session-meta">
          <span><Icon name={s.platform === 'web' ? 'monitor' : 'device'} size={13} /> {s.deviceName}</span>
          {s.remoteAddress && <span><Icon name="globe" size={13} /> {s.remoteAddress}</span>}
        </div>
      )}
      <div className="session-user"><Icon name="user" size={14} /> {s.userName}</div>
      <div className="session-controls">
        {s.state === 'paused'
          ? <button className="btn-icon" onClick={() => onCommand(s, 'play')} title="Resume" aria-label="Resume"><Icon name="play" size={18} /></button>
          : <button className="btn-icon" onClick={() => onCommand(s, 'pause')} title="Pause" aria-label="Pause"><Icon name="pause" size={18} /></button>}
        <button className="btn-icon session-kill" onClick={() => onKill(s)} title="Stop stream" aria-label="Stop stream"><Icon name="stop" size={18} /></button>
        <button className="btn-icon" onClick={() => onMessage(s)} title="Send message" aria-label="Send message"><Icon name="message" size={18} /></button>
      </div>
    </div>
  );
}

function MessageDialog({ s, onClose }: { s: ActiveSession | null; onClose: () => void }) {
  const toast = useToast();
  const [header, setHeader] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (s) {
      setHeader('');
      setText('');
    }
  }, [s]);
  const send = async () => {
    if (!s || !text.trim()) return;
    setBusy(true);
    try {
      await api.playback.command(s.id, { action: 'message', text: text.trim(), header: header.trim() || undefined });
      toast.success(`Message sent to ${s.userName}`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={!!s} onClose={onClose} title={s ? `Message ${s.userName} on ${s.deviceName}` : ''} size="sm"
      footer={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !text.trim()} onClick={send}>Send</button></>}>
      <Field label="Header (optional)"><input className="input" value={header} maxLength={100} onChange={(e) => setHeader(e.target.value)} placeholder="Message from the server" /></Field>
      <Field label="Message"><textarea className="input" rows={3} value={text} maxLength={500} autoFocus onChange={(e) => setText(e.target.value)} /></Field>
    </Modal>
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

  const [messageTo, setMessageTo] = useState<ActiveSession | null>(null);
  const command = async (s: ActiveSession, action: 'pause' | 'play') => {
    try {
      await api.playback.command(s.id, { action });
      setSessions((l) => (l ?? []).map((x) => (x.id === s.id ? { ...x, state: action === 'pause' ? 'paused' : 'playing' } : x)));
    } catch (e) {
      toast.error(e);
    }
  };
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
      <AdminHeader help="admin-setup" title="Overview" subtitle={st ? `Vibe ${st.version} · up ${formatUptime(st.uptimeSeconds)}` : undefined} />
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
          <div className="session-grid">{sessions.map((s) => <SessionCard key={s.id} s={s} onKill={kill} onCommand={command} onMessage={setMessageTo} />)}</div>
        )}
      </section>

      <MessageDialog s={messageTo} onClose={() => setMessageTo(null)} />

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
