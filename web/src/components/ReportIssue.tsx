import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { IssueKind, Item } from '@mediamax/shared';
import { seerrApi } from '../api/seerr';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { Field, Modal, Spinner } from './ui';
import { Icon, type IconName } from './Icon';
import { notifyIssuesChanged } from '../utils/requests';
import '../styles/requests.css';

export const ISSUE_KINDS: { value: IssueKind; label: string; icon: IconName }[] = [
  { value: 'video', label: 'Video', icon: 'video' },
  { value: 'audio', label: 'Audio', icon: 'audio' },
  { value: 'subtitle', label: 'Subtitles', icon: 'subtitles' },
  { value: 'other', label: 'Other', icon: 'info' },
];
const REPORTABLE = new Set(['movie', 'show', 'season', 'episode', 'album', 'track', 'audiobook', 'book', 'video']);

/** Whether the signed-in viewer may report a problem with this item (permission + item type). */
export function useCanReportIssue(item: Pick<Item, 'type'>): boolean {
  const { user } = useApp();
  return !!user && (user.isAdmin || user.requestPermissions?.reportIssues !== false) && REPORTABLE.has(item.type);
}

/** "Report an issue" button + dialog for an item page (Overseerr-style). Hidden without the permission. */
export function ReportIssueButton({ item, className = 'btn', round }: { item: Pick<Item, 'id' | 'type' | 'title'>; className?: string; round?: boolean }) {
  const [open, setOpen] = useState(false);
  const allowed = useCanReportIssue(item);
  if (!allowed) return null;
  return (
    <>
      {round
        ? <button className="btn-round" onClick={() => setOpen(true)} title="Report an issue" aria-label="Report an issue" data-nav><Icon name="flag" /></button>
        : <button className={className} onClick={() => setOpen(true)} title="Report a problem with this title"><Icon name="flag" size={16} /> Report issue</button>}
      <ReportIssueDialog item={item} open={open} onClose={() => setOpen(false)} />
    </>
  );
}

/** The report dialog on its own, for pages that open it from a menu (the title page's More menu). */
export function ReportIssueDialog({ item, open, onClose }: { item: Pick<Item, 'id' | 'type' | 'title'>; open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [kind, setKind] = useState<IssueKind>('video');
  const [message, setMessage] = useState('');
  const [season, setSeason] = useState('');
  const [episode, setEpisode] = useState('');
  const [busy, setBusy] = useState(false);
  const isShow = item.type === 'show';
  const submit = async () => {
    setBusy(true);
    try {
      const issue = await seerrApi.createIssue({
        itemId: item.id, kind, message: message.trim(),
        ...(isShow && season ? { season: Number(season), ...(episode ? { episode: Number(episode) } : {}) } : {}),
      });
      toast.success('Thanks — the admins have been told');
      notifyIssuesChanged();
      onClose();
      setMessage('');
      navigate(`/issues/${issue.id}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} size="md" title={`Report a problem with “${item.title}”`}
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void submit()} disabled={busy || !message.trim()}>{busy ? <Spinner size={16} /> : <Icon name="flag" size={16} />} Report</button></>}>
      <div className="form-grid">
        <div className="field">
          <span className="field-label">What's wrong?</span>
          <div className="issue-kinds" role="group" aria-label="Problem type">
            {ISSUE_KINDS.map((k) => (
              <button key={k.value} type="button" className="issue-kind" aria-pressed={kind === k.value} onClick={() => setKind(k.value)}><Icon name={k.icon} size={20} /> {k.label}</button>
            ))}
          </div>
        </div>
        {isShow && (
          <div className="form-row">
            <Field label="Season" hint="Optional"><input className="input" inputMode="numeric" value={season} onChange={(e) => setSeason(e.target.value.replace(/\D/g, '').slice(0, 3))} placeholder="All" /></Field>
            <Field label="Episode" hint="Optional"><input className="input" inputMode="numeric" value={episode} disabled={!season} onChange={(e) => setEpisode(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="All" /></Field>
          </div>
        )}
        <Field label="Describe the problem">
          <textarea className="textarea" rows={4} maxLength={2000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="e.g. Audio is out of sync from 12:30 onwards" autoFocus />
        </Field>
      </div>
    </Modal>
  );
}
