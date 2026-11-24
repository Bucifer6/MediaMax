import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Channel, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Badge, Img, Modal, ProgressBar } from './ui';
import { Icon } from './Icon';
import { programProgress } from './Cards';
import { formatTime } from '../utils/format';
import { hasReminder, reminders, subscribeReminders, toggleReminder } from '../livetv/reminders';
import '../styles/epg.css';

export function catchupLink(channelId: string, p: Program) {
  const dur = Math.ceil((new Date(p.end).getTime() - new Date(p.start).getTime()) / 60000);
  return `/watch/live/${encodeURIComponent(channelId)}?catchup=${encodeURIComponent(p.start)}&dur=${dur}&title=${encodeURIComponent(p.title)}`;
}

interface DetailsProps {
  program: Program;
  channel: Channel | null;
  onClose: () => void;
  onChanged?: (p: Program) => void;
  /** The channel's favourite flag changed (the star in the panel). */
  onChannelChanged?: (c: Channel) => void;
  headingId?: string;
}

/** Programme details with the quick actions: watch, watch from start / catch-up, record, record series, remind, favourite. */
export function ProgramDetails({ program, channel, onClose, onChanged, onChannelChanged, headingId }: DetailsProps) {
  const navigate = useNavigate();
  const { features, user } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  useSyncExternalStore(subscribeReminders, reminders);
  const now = Date.now();
  const start = new Date(program.start).getTime();
  const end = new Date(program.end).getTime();
  const live = start <= now && end > now;
  const past = end <= now;
  const archive = !!channel?.hasArchive && start > now - (channel.archiveDays || 0) * 86400000;
  const canDvr = features.dvr && (user?.allowDvr ?? true);
  const reminded = hasReminder(program.id);
  const minsLeft = Math.max(1, Math.round((end - now) / 60000));
  const startsIn = Math.round((start - now) / 60000);

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
  const remind = () => {
    const on = toggleReminder(program, channel);
    toast.show(on ? `We'll remind you when ${program.title} starts` : 'Reminder removed', on ? 'success' : 'info');
  };
  const fav = async () => {
    if (!channel) return;
    try {
      const r = await api.livetv.setFavorite(channel.id, !channel.favorite);
      onChannelChanged?.({ ...channel, favorite: r.favorite });
      toast.show(r.favorite ? `${channel.name} added to favourites` : `${channel.name} removed from favourites`);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div className="program-details">
      <div className={`program-hero ${program.iconUrl ? 'has-art' : ''}`}>
        {program.iconUrl && <Img src={program.iconUrl} width={800} className="program-hero-img" />}
        <div className="program-hero-shade" />
        <div className="program-hero-text">
          {channel && (
            <div className="program-channel">
              <span className="program-channel-logo"><Img src={channel.logoUrl} width={96} alt="" fallback={<Icon name="tv" size={16} />} /></span>
              {channel.number != null && <span className="program-channel-num">{channel.number}</span>}
              <span>{channel.name}</span>
            </div>
          )}
          <h2 id={headingId} tabIndex={-1}>{program.title}</h2>
          {program.subtitle && <p className="program-sub">{program.subtitle}</p>}
        </div>
      </div>
      <div className="program-body">
        <div className="program-meta">
          {live && <span className="live-pill"><span className="live-dot" /> LIVE</span>}
          <span>{new Date(program.start).toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' })}</span>
          <span className="tabular">{formatTime(program.start)} – {formatTime(program.end)}</span>
          <span>{Math.round((end - start) / 60000)} min</span>
          {program.episodeNum && <Badge tone="muted">{program.episodeNum}</Badge>}
          {program.category && <Badge tone="muted">{program.category}</Badge>}
          {program.isNew && <Badge tone="new">NEW</Badge>}
          {program.recordingId && <Badge tone="danger"><Icon name="record" size={10} /> {live ? 'Recording' : 'Will record'}</Badge>}
          {reminded && <Badge tone="accent"><Icon name="bell" size={11} /> Reminder set</Badge>}
        </div>
        {live && (
          <div className="program-progress">
            <ProgressBar value={programProgress(program.start, program.end, now)} label="Programme progress" />
            <span className="tabular">{minsLeft} min left</span>
          </div>
        )}
        {!live && !past && startsIn > 0 && <p className="program-when">Starts {startsIn < 60 ? `in ${startsIn} min` : `at ${formatTime(program.start)}`}</p>}
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
          {!live && !past && (
            <button className={`btn ${reminded ? 'is-on' : ''}`} onClick={remind} aria-pressed={reminded}>
              <Icon name="bell" size={16} /> {reminded ? 'Reminder set' : 'Remind me'}
            </button>
          )}
          {channel && onChannelChanged && (
            <button className={`btn btn-ghost ${channel.favorite ? 'is-on' : ''}`} onClick={() => void fav()} aria-pressed={!!channel.favorite}>
              <Icon name={channel.favorite ? 'starFill' : 'star'} size={16} /> {channel.favorite ? 'Favourite channel' : 'Add channel to favourites'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Programme details in a sheet (docked right; a bottom sheet on phones). */
export function ProgramModal({ program, channel, onClose, onChanged, onChannelChanged }: { program: Program | null; channel: Channel | null; onClose: () => void; onChanged?: (p: Program) => void; onChannelChanged?: (c: Channel) => void }) {
  if (!program) return <Modal open={false} onClose={onClose}>{null}</Modal>;
  return (
    <Modal open onClose={onClose} size="md" variant="sheet" className="program-modal" ariaLabel={program.title}>
      <button className="btn-icon modal-close program-close" onClick={onClose} aria-label="Close"><Icon name="x" /></button>
      <ProgramDetails program={program} channel={channel} onClose={onClose} onChanged={onChanged} onChannelChanged={onChannelChanged} />
    </Modal>
  );
}

/**
 * Non-blocking side panel for the guide (desktop): the grid stays usable next to it. Focus moves to the panel when a
 * programme opens; Esc closes it and returns focus to `returnFocus`.
 */
export function ProgramPanel({ program, channel, onClose, onChanged, onChannelChanged, returnFocus }: DetailsProps & { returnFocus?: HTMLElement | null }) {
  const ref = useRef<HTMLElement>(null);
  const back = useRef(returnFocus);
  back.current = returnFocus;
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('h2')?.focus({ preventScroll: true });
  }, [program.id]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || document.querySelector('.modal')) return;
      e.preventDefault();
      onClose();
      back.current?.focus();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <aside className="program-panel" ref={ref} aria-labelledby="program-panel-title">
      <button className="btn-icon program-close" onClick={() => { onClose(); back.current?.focus(); }} aria-label="Close programme details"><Icon name="x" /></button>
      <ProgramDetails program={program} channel={channel} onClose={onClose} onChanged={onChanged} onChannelChanged={onChannelChanged} headingId="program-panel-title" />
    </aside>
  );
}
