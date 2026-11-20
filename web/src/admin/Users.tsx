import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CreateUserRequest, Library, User } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Avatar, AvatarEditor, Badge, Dropdown, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { CONTENT_RATINGS, isIptvLibrary, libraryIcon } from '../utils/items';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

type Form = CreateUserRequest & { disabled?: boolean };

function UserForm({ initial, libraries, onSaved, onCancel, onAvatarChanged }: { initial?: User; libraries: Library[]; onSaved: (u: User) => void; onCancel: () => void; onAvatarChanged?: (u: User) => void }) {
  const toast = useToast();
  const { user: me, setUser } = useApp();
  const [avatarUrl, setAvatarUrl] = useState(initial?.avatarUrl ?? null);
  const [f, setF] = useState<Form>({
    username: initial?.username ?? '',
    displayName: initial?.displayName ?? '',
    password: '',
    pin: '',
    isAdmin: initial?.isAdmin ?? false,
    maxContentRating: initial?.maxContentRating ?? null,
    libraryIds: initial?.libraryIds ?? null,
    allowLiveTv: initial?.allowLiveTv ?? true,
    allowDownloads: initial?.allowDownloads ?? true,
    allowTranscode: initial?.allowTranscode ?? true,
    allowDvr: initial?.allowDvr ?? false,
    allowRequest4k: initial?.allowRequest4k ?? false,
    allowRemote: initial?.allowRemote ?? true,
    maxStreams: initial?.maxStreams ?? null,
    disabled: initial?.disabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleLib = (id: string) => {
    const cur = f.libraryIds ?? libraries.map((l) => l.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set('libraryIds', next.length === libraries.length ? null : next);
  };

  const avatarDone = (u: User, msg: string) => {
    setAvatarUrl(u.avatarUrl);
    if (u.id === me?.id) setUser(u);
    onAvatarChanged?.(u);
    toast.success(msg);
  };
  const pinInvalid = !!f.pin && f.pin.length < 4;

  const submit = async () => {
    if (pinInvalid) return toast.show('PIN must be 4–8 digits', 'error');
    setBusy(true);
    try {
      const body: Form = { ...f, displayName: f.displayName || f.username };
      if (!body.password) delete body.password;
      if (!body.pin) delete body.pin;
      const u = initial ? await api.users.update(initial.id, body) : await api.users.create(body);
      toast.success(initial ? 'User updated' : 'User created');
      onSaved(u);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const isSelf = initial?.id === me?.id;
  return (
    <>
      <div className="form-grid">
        {initial && (
          <div className="field">
            <span className="field-label">Profile picture</span>
            <AvatarEditor
              name={f.displayName || f.username}
              url={avatarUrl}
              size={64}
              onUpload={async (file) => {
                try {
                  avatarDone(await api.users.uploadAvatar(initial.id, file), 'Profile picture updated');
                } catch (e) {
                  toast.error(e);
                }
              }}
              onRemove={async () => {
                try {
                  avatarDone(await api.users.deleteAvatar(initial.id), 'Profile picture removed');
                } catch (e) {
                  toast.error(e);
                }
              }}
            />
          </div>
        )}
        <div className="form-row">
          <Field label="Username"><input className="input" value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></Field>
          <Field label="Display name"><input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label={initial ? 'New password' : 'Password'} hint={initial ? 'Leave blank to keep' : 'Optional for PIN-only profiles'}>
            <input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="PIN" hint={pinInvalid ? 'PIN must be 4–8 digits' : initial?.hasPin ? `PIN set (${initial.pinLength ?? 4} digits) — enter a new one to replace` : '4–8 digits, optional'}>
            <input className="input" inputMode="numeric" value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••" maxLength={8} />
          </Field>
        </div>
        <div className="form-row">
          <Field label="Maximum content rating">
            <select className="select" value={f.maxContentRating ?? ''} onChange={(e) => set('maxContentRating', e.target.value || null)}>
              <option value="">Unrestricted</option>
              {CONTENT_RATINGS.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </Field>
          <Field label="Max simultaneous streams" hint="Leave empty for unlimited.">
            <input className="input" type="number" min={1} max={100} inputMode="numeric" value={f.maxStreams ?? ''} placeholder="Unlimited" onChange={(e) => set('maxStreams', e.target.value === '' ? null : Math.max(1, Math.floor(Number(e.target.value)) || 1))} />
          </Field>
        </div>
        <div className="field">
          <span className="field-label">Library access</span>
          <div className="lib-access">
            <label className="check-chip">
              <input type="checkbox" checked={f.libraryIds == null} onChange={(e) => set('libraryIds', e.target.checked ? null : [])} /> All libraries (including future ones)
            </label>
            {libraries.map((l) => (
              <label key={l.id} className="check-chip">
                <input type="checkbox" checked={f.libraryIds == null || f.libraryIds.includes(l.id)} disabled={f.libraryIds == null} onChange={() => toggleLib(l.id)} />
                <Icon name={libraryIcon(l.type)} size={14} /> {l.name} {isIptvLibrary(l.type) && <Badge tone="accent">IPTV</Badge>}
              </label>
            ))}
          </div>
        </div>
        <div className="switch-group">
          <Switch checked={!!f.isAdmin} onChange={(v) => set('isAdmin', v)} label="Administrator" hint="Full access to server settings, users and branding." disabled={isSelf} />
          <Switch checked={!!f.allowLiveTv} onChange={(v) => set('allowLiveTv', v)} label="Live TV" />
          <Switch checked={!!f.allowDvr} onChange={(v) => set('allowDvr', v)} label="DVR recording" />
          <Switch checked={!!f.allowRequest4k} onChange={(v) => set('allowRequest4k', v)} label="Request in 4K" hint="Offer “Also request in 4K” when a 4K Radarr/Sonarr is set up. Admins always can." />
          <Switch checked={!!f.allowTranscode} onChange={(v) => set('allowTranscode', v)} label="Allow transcoding" hint="When off, only direct play is allowed." />
          <Switch checked={!!f.allowDownloads} onChange={(v) => set('allowDownloads', v)} label="Downloads" />
          <Switch checked={!!f.allowRemote} onChange={(v) => set('allowRemote', v)} label="Allow streaming outside the home network" hint="When off, playback only works from the local network." />
          {initial && <Switch checked={!!f.disabled} onChange={(v) => set('disabled', v)} label="Disabled" hint="Blocks sign-in and revokes access." disabled={isSelf} />}
        </div>
      </div>
      <div className="modal-foot inline">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !f.username.trim() || pinInvalid}>{busy ? <Spinner size={18} /> : initial ? 'Save' : 'Create user'}</button>
      </div>
    </>
  );
}

export function UsersAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const { user: me } = useApp();
  const navigate = useNavigate();
  const users = useAsync(() => api.users.list(), []);
  const libs = useAsync(() => api.libraries.list().catch(() => [] as Library[]), []);
  const [edit, setEdit] = useState<User | 'new' | null>(null);

  const resetTotp = async (u: User) => {
    if (!(await confirm({ title: `Reset two-factor for ${u.displayName || u.username}?`, message: 'Two-factor authentication is turned off for this account. They can sign in with just their password and set it up again.', confirmLabel: 'Reset two-factor', danger: true }))) return;
    try {
      const updated = await api.users.resetTotp(u.id);
      users.setData((d) => (d ?? []).map((x) => (x.id === u.id ? updated : x)));
      toast.success('Two-factor authentication reset');
    } catch (e) {
      toast.error(e);
    }
  };

  const remove = async (u: User) => {
    if (!(await confirm({ title: `Delete ${u.displayName || u.username}?`, message: 'Their watch history and playlists will be removed.', confirmLabel: 'Delete user', danger: true }))) return;
    try {
      await api.users.remove(u.id);
      users.setData((d) => (d ?? []).filter((x) => x.id !== u.id));
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <div>
      <AdminHeader title="Users" subtitle="Accounts, Plex-Home-style profiles, parental controls and permissions." actions={<><Link className="btn" to="/admin/invites"><Icon name="link" size={16} /> Invites</Link><button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add user</button></>} />
      {users.loading && !users.data ? <Skeleton h={200} /> : users.error ? <ErrorState message={users.error} onRetry={users.reload} /> : !users.data?.length ? <EmptyState icon="users" title="No users" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>User</th><th>Access</th><th>Rating limit</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {users.data.map((u) => (
                <tr key={u.id} className={u.disabled ? 'dim' : ''}>
                  <td>
                    <div className="user-cell">
                      <Avatar name={u.displayName || u.username} url={u.avatarUrl} size={36} />
                      <div>
                        <strong>{u.displayName || u.username}</strong> {u.id === me?.id && <Badge tone="muted">You</Badge>}
                        <div className="muted">@{u.username}</div>
                      </div>
                    </div>
                  </td>
                  <td>
                    <div className="badge-row">
                      {u.isAdmin && <Badge tone="primary">Admin</Badge>}
                      {u.disabled && <Badge tone="danger">Disabled</Badge>}
                      {u.hasPin && <Badge tone="muted"><Icon name="lock" size={10} /> PIN</Badge>}
                      {u.totpEnabled && <Badge tone="success"><Icon name="shield" size={10} /> 2FA</Badge>}
                      {u.maxStreams != null && <Badge tone="muted">{u.maxStreams} stream{u.maxStreams === 1 ? '' : 's'}</Badge>}
                      {u.allowRemote === false && <Badge tone="warning">Home only</Badge>}
                      {!u.hasPassword && <Badge tone="muted">Profile</Badge>}
                      <Badge tone="muted">{u.libraryIds === null ? 'All libraries' : `${u.libraryIds.length} libraries`}</Badge>
                      {u.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
                      {u.allowDvr && <Badge tone="muted">DVR</Badge>}
                      {u.allowRequest4k && !u.isAdmin && <Badge tone="muted">4K requests</Badge>}
                    </div>
                  </td>
                  <td>{u.maxContentRating ?? <span className="muted">None</span>}</td>
                  <td className="muted">{relativeTime(u.lastSeenAt)}</td>
                  <td className="td-actions">
                    <Dropdown
                      trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label="Actions"><Icon name="more" /></button>}
                      items={[
                        { label: 'Edit', icon: 'edit', onClick: () => setEdit(u) },
                        { label: 'Year in review', icon: 'sparkles', onClick: () => navigate(`/admin/users/${u.id}/wrapped`) },
                        ...(u.totpEnabled ? [{ label: 'Reset two-factor', icon: 'shield' as const, onClick: () => resetTotp(u) }] : []),
                        ...(u.id !== me?.id ? [{ label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => remove(u) }] : []),
                      ]}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add user' : `Edit ${edit ? (edit as User).displayName || (edit as User).username : ''}`} size="lg">
        {edit && (
          <UserForm
            initial={edit === 'new' ? undefined : edit}
            libraries={libs.data ?? []}
            onCancel={() => setEdit(null)}
            onAvatarChanged={(u) => users.setData((d) => (d ?? []).map((x) => (x.id === u.id ? { ...x, avatarUrl: u.avatarUrl } : x)))}
            onSaved={(u) => {
              users.setData((d) => {
                const arr = d ?? [];
                return arr.some((x) => x.id === u.id) ? arr.map((x) => (x.id === u.id ? u : x)) : [...arr, u];
              });
              setEdit(null);
            }}
          />
        )}
      </Modal>
    </div>
  );
}
