import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Badge, Img, Modal, ProgressBar } from './ui';
import { Icon } from './Icon';
import { programProgress } from './Cards';
import { formatTime } from '../utils/format';

export function catchupLink(channelId: string, p: Program) {
  const dur = Math.ceil((new Date(p.end).getTime() - new Date(p.start).getTime()) / 60000);
  return `/watch/live/${encodeURIComponent(channelId)}?catchup=${encodeURIComponent(p.start)}&dur=${dur}&title=${encodeURIComponent(p.title)}`;
}

export function ProgramModal({ program, channel, onClose, onChanged }: { program: Program | null; channel: Channel | null; onClose: () => void; onChanged?: (p: Program) => void }) {
  const navigate = useNavigate();
  const { features, user } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!program) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  const now = Date.now();
  const start = new Date(program.start).getTime();
  const end = new Date(program.end).getTime();
  const live = start <= now && end > now;
  const past = end <= now;
  const archive = !!channel?.hasArchive && start > now - (channel.archiveDays || 0) * 86400000;
  const canDvr = features.dvr && (user?.allowDvr ?? true);

  const record = async () => {
    setBusy(true);
    try {
      const r = await api.dvr.record({ channelId: program.channelId, programId: program.id });
      toast.success(`Recording scheduled: ${program.title}`);
      onChanged?.({ ...program, recordingId: r.id });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!program.recordingId) return;
    setBusy(true);
    try {
      await api.dvr.removeRecording(program.recordingId);
      toast.success('Recording cancelled');
      onChanged?.({ ...program, recordingId: null });
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const series = async () => {
    setBusy(true);
    try {
      const pad = await api.dvr.defaults().catch(() => ({ paddingBeforeMin: 1, paddingAfterMin: 5 }));
      await api.dvr.createRule({ titleMatch: program.title, channelId: program.channelId, newOnly: true, keepLatest: null, ...pad, enabled: true });
      toast.success(`Series recording set for "${program.title}"`);
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} size="md" className="program-modal">
      <div className="program-hero">
        {program.iconUrl && <Img src={program.iconUrl} width={800} className="program-hero-img" />}
        <div className="program-hero-shade" />
        <button className="btn-icon modal-close program-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
        <div className="program-hero-text">
          {channel && (
            <div className="program-channel">
              <span className="program-channel-logo"><Img src={channel.logoUrl} width={80} fallback={<Icon name="tv" size={16} />} /></span>
              {channel.number != null && <span>{channel.number}</span>}
              <span>{channel.name}</span>
            </div>
          )}
          <h2>{program.title}</h2>
          {program.subtitle && <p className="program-sub">{program.subtitle}</p>}
        </div>
      </div>
      <div className="program-body">
        <div className="program-meta">
          {live && <span className="live-pill"><span className="live-dot" /> LIVE</span>}
          <span>{new Date(program.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</span>
          <span>{formatTime(program.start)} – {formatTime(program.end)}</span>
          <span>{Math.round((end - start) / 60000)} min</span>
          {program.episodeNum && <Badge tone="muted">{program.episodeNum}</Badge>}
          {program.category && <Badge tone="muted">{program.category}</Badge>}
          {program.isNew && <Badge tone="success">NEW</Badge>}
          {program.recordingId && <Badge tone="danger"><Icon name="record" size={10} /> Recording</Badge>}
        </div>
        {live && <ProgressBar value={programProgress(program.start, program.end, now)} />}
        {program.description && <p className="program-desc">{program.description}</p>}
        <div className="program-actions">
          {live && (
            <button className="btn btn-primary" onClick={() => navigate(`/watch/live/${program.channelId}`)}>
              <Icon name="play" size={18} /> Watch live
            </button>
          )}
          {(live || past) && archive && (
            <button className={`btn ${live ? '' : 'btn-primary'}`} onClick={() => navigate(catchupLink(program.channelId, program))}>
              <Icon name="rewind10" size={18} /> {live ? 'Watch from start' : 'Watch catch-up'}
            </button>
          )}
          {canDvr && !past && (program.recordingId ? (
            <button className="btn btn-danger" onClick={cancel} disabled={busy}><Icon name="x" size={16} /> Cancel recording</button>
          ) : (
            <button className="btn" onClick={record} disabled={busy}><Icon name="record" size={14} className="text-danger" /> Record</button>
          ))}
          {canDvr && (
            <button className="btn" onClick={series} disabled={busy}><Icon name="layers" size={16} /> Record series</button>
          )}
        </div>
      </div>
    </Modal>
  );
}
