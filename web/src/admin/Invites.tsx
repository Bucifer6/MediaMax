import { useState } from 'react';
import type { CreateInviteRequest, Invite, InviteTemplate, Library } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { CONTENT_RATINGS, isIptvLibrary, libraryIcon } from '../utils/items';
import { formatDate, relativeTime } from '../utils/format';
import { copyText } from '../pages/SecuritySettings';
import { AdminHeader } from './AdminRoutes';

const DEFAULT_TEMPLATE: InviteTemplate = {
  libraryIds: null,
  maxContentRating: null,
  allowLiveTv: true,
  allowDownloads: true,
  allowTranscode: true,
  allowDvr: false,
  allowRemote: true,
  maxStreams: null,
};

const EXPIRY = [
  { value: '1', label: '1 day' },
  { value: '7', label: '7 days' },
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '', label: 'Never' },
];

function InviteForm({ libraries, onCreated, onCancel }: { libraries: Library[]; onCreated: (i: Invite) => void; onCancel: () => void }) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [expires, setExpires] = useState('7');
  const [maxUses, setMaxUses] = useState<string>('1');
  const [t, setT] = useState<InviteTemplate>(DEFAULT_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof InviteTemplate>(k: K, v: InviteTemplate[K]) => setT((x) => ({ ...x, [k]: v }));
  const toggleLib = (id: string) => {
    const cur = t.libraryIds ?? libraries.map((l) => l.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set('libraryIds', next.length === libraries.length ? null : next);
  };

  const submit = async () => {
    setBusy(true);
    try {
      const body: CreateInviteRequest = {
        note: note.trim() || undefined,
        expiresInDays: expires ? Number(expires) : null,
        maxUses: maxUses ? Math.max(1, Math.floor(Number(maxUses))) : null,
        template: t,
      };
      onCreated(await api.invites.create(body));
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="form-grid">
        <Field label="Note" hint="Only admins see this — e.g. who the invite is for.">
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="For Grandma" maxLength={200} autoFocus />
        </Field>
        <div className="form-row">
          <Field label="Expires after">
            <select className="select" value={expires} onChange={(e) => setExpires(e.target.value)}>
              {EXPIRY.map((x) => <option key={x.label} value={x.value}>{x.label}</option>)}
            </select>
          </Field>
          <Field label="Max uses" hint="Leave empty for unlimited.">
            <input className="input" type="number" min={1} inputMode="numeric" value={maxUses} onChange={(e) => setMaxUses(e.target.value)} placeholder="Unlimited" />
          </Field>
        </div>
        <h3 className="form-section-title">New users get</h3>
        <div className="form-row">
          <Field label="Maximum content rating">
            <select className="select" value={t.maxContentRating ?? ''} onChange={(e) => set('maxContentRating', e.target.value || null)}>
              <option value="">Unrestricted</option>
              {CONTENT_RATINGS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Max simultaneous streams" hint="Leave empty for unlimited.">
            <input className="input" type="number" min={1} inputMode="numeric" value={t.maxStreams ?? ''} placeholder="Unlimited" onChange={(e) => set('maxStreams', e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Library access</span>
          <div className="lib-access">
            <label className="check-chip">
              <input type="checkbox" checked={t.libraryIds == null} onChange={(e) => set('libraryIds', e.target.checked ? null : [])} /> All libraries (including future ones)
            </label>
            {libraries.map((l) => (
              <label key={l.id} className="check-chip">
                <input type="checkbox" checked={t.libraryIds == null || t.libraryIds.includes(l.id)} disabled={t.libraryIds == null} onChange={() => toggleLib(l.id)} />
                <Icon name={libraryIcon(l.type)} size={14} /> {l.name} {isIptvLibrary(l.type) && <Badge tone="accent">IPTV</Badge>}
              </label>
            ))}
          </div>
        </div>
        <div className="switch-group">
          <Switch checked={t.allowLiveTv} onChange={(v) => set('allowLiveTv', v)} label="Live TV" />
          <Switch checked={t.allowDvr} onChange={(v) => set('allowDvr', v)} label="DVR recording" />
          <Switch checked={t.allowTranscode} onChange={(v) => set('allowTranscode', v)} label="Allow transcoding" hint="When off, only direct play is allowed." />
          <Switch checked={t.allowDownloads} onChange={(v) => set('allowDownloads', v)} label="Downloads" />
          <Switch checked={t.allowRemote} onChange={(v) => set('allowRemote', v)} label="Allow streaming outside the home network" />
        </div>
      </div>
      <div className="modal-foot inline">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || (t.libraryIds != null && t.libraryIds.length === 0)}>{busy ? <Spinner size={18} /> : 'Create invite'}</button>
      </div>
    </>
  );
}

function templateChips(t: InviteTemplate, libraries: Library[]) {
  const libs = t.libraryIds === null ? 'All libraries' : t.libraryIds.length === 1 ? libraries.find((l) => l.id === t.libraryIds![0])?.name ?? '1 library' : `${t.libraryIds.length} libraries`;
  return (
    <div className="badge-row">
      <Badge tone="muted">{libs}</Badge>
      {t.maxContentRating && <Badge tone="muted">≤ {t.maxContentRating}</Badge>}
      {t.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
      {t.allowDvr && <Badge tone="muted">DVR</Badge>}
      {!t.allowTranscode && <Badge tone="muted">Direct play only</Badge>}
      {!t.allowDownloads && <Badge tone="muted">No downloads</Badge>}
      {!t.allowRemote && <Badge tone="warning">Home only</Badge>}
      {t.maxStreams != null && <Badge tone="muted">{t.maxStreams} stream{t.maxStreams === 1 ? '' : 's'}</Badge>}
    </div>
  );
}

function inviteState(i: Invite): { label: string; tone: 'success' | 'muted' | 'danger' } {
  if (i.expiresAt && Date.parse(i.expiresAt) < Date.now()) return { label: 'Expired', tone: 'danger' };
  if (i.maxUses != null && i.uses >= i.maxUses) return { label: 'Used up', tone: 'muted' };
  return { label: 'Active', tone: 'success' };
}

export function InvitesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const invites = useAsync(() => api.invites.list(), []);
  const libs = useAsync(() => api.libraries.list().catch(() => [] as Library[]), []);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);

  const copy = async (i: Invite) => {
    if (await copyText(i.url)) toast.success('Invite link copied');
    else toast.show('Copy failed — select the link and copy it manually', 'error');
  };
  const remove = async (i: Invite) => {
    if (!(await confirm({ title: 'Delete this invite?', message: 'The link stops working. Accounts already created with it are kept.', confirmLabel: 'Delete invite', danger: true }))) return;
    try {
      await api.invites.remove(i.code);
      invites.setData((d) => (d ?? []).filter((x) => x.code !== i.code));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader help="admin-users" title="Invites" subtitle="Share a link so friends and family can create their own account, with the permissions you choose." actions={<button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New invite</button>} />
      {invites.loading && !invites.data ? <Skeleton h={200} /> : invites.error ? <ErrorState message={invites.error} onRetry={invites.reload} /> : !invites.data?.length ? (
        <EmptyState icon="link" title="No invites yet" message="Create an invite link and send it to someone. They pick their own username and password." action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Icon name="plus" size={16} /> New invite</button>} />
      ) : (
        <div className="invite-list">
          {invites.data.map((i) => {
            const st = inviteState(i);
            return (
              <div key={i.code} className={`invite-card ${fresh === i.code ? 'fresh' : ''} ${st.tone !== 'success' ? 'dim' : ''}`}>
                <div className="invite-main">
                  <div className="invite-title">
                    <strong>{i.note || 'Invite'}</strong>
                    <Badge tone={st.tone}>{st.label}</Badge>
                  </div>
                  <div className="secret-row">
                    <code className="secret-code mono invite-url">{i.url}</code>
                  </div>
                  <div className="task-meta">
                    <span><Icon name="users" size={13} /> {i.uses}{i.maxUses != null ? ` / ${i.maxUses}` : ''} used</span>
                    <span><Icon name="clock" size={13} /> {i.expiresAt ? `${Date.parse(i.expiresAt) < Date.now() ? 'Expired' : 'Expires'} ${formatDate(i.expiresAt)}` : 'Never expires'}</span>
                    <span>Created {relativeTime(i.createdAt)}</span>
                  </div>
                  {templateChips(i.template, libs.data ?? [])}
                </div>
                <div className="invite-actions">
                  <button className="btn btn-sm" onClick={() => copy(i)}><Icon name="copy" size={14} /> Copy link</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => remove(i)} aria-label={`Delete invite ${i.note ?? i.code}`}><Icon name="trash" size={14} /> Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="New invite" size="lg">
        {creating && (
          <InviteForm
            libraries={libs.data ?? []}
            onCancel={() => setCreating(false)}
            onCreated={(i) => {
              invites.setData((d) => [i, ...(d ?? [])]);
              setCreating(false);
              setFresh(i.code);
              void copyText(i.url).then((ok) => toast.success(ok ? 'Invite created — link copied' : 'Invite created'));
            }}
          />
        )}
      </Modal>
    </div>
  );
}
