import { useState } from 'react';
import type { CreateUserRequest, Library, User } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Avatar, Badge, Dropdown, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { CONTENT_RATINGS, isIptvLibrary, libraryIcon } from '../utils/items';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

type Form = CreateUserRequest & { disabled?: boolean };

function UserForm({ initial, libraries, onSaved, onCancel }: { initial?: User; libraries: Library[]; onSaved: (u: User) => void; onCancel: () => void }) {
  const toast = useToast();
  const { user: me } = useApp();
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
    disabled: initial?.disabled ?? false,
  });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const toggleLib = (id: string) => {
    const cur = f.libraryIds ?? libraries.map((l) => l.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set('libraryIds', next.length === libraries.length ? null : next);
  };

  const submit = async () => {
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
        <div className="form-row">
          <Field label="Username"><input className="input" value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" /></Field>
          <Field label="Display name"><input className="input" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} /></Field>
        </div>
        <div className="form-row">
          <Field label={initial ? 'New password' : 'Password'} hint={initial ? 'Leave blank to keep' : 'Optional for PIN-only profiles'}>
            <input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="PIN" hint={initial?.hasPin ? 'PIN set — enter a new one to replace' : '4 digits, optional'}>
            <input className="input" inputMode="numeric" value={f.pin} onChange={(e) => set('pin', e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" />
          </Field>
        </div>
        <Field label="Maximum content rating">
          <select className="select" value={f.maxContentRating ?? ''} onChange={(e) => set('maxContentRating', e.target.value || null)}>
            <option value="">Unrestricted</option>
            {CONTENT_RATINGS.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </Field>
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
          <Switch checked={!!f.allowTranscode} onChange={(v) => set('allowTranscode', v)} label="Allow transcoding" hint="When off, only direct play is allowed." />
          <Switch checked={!!f.allowDownloads} onChange={(v) => set('allowDownloads', v)} label="Downloads" />
          {initial && <Switch checked={!!f.disabled} onChange={(v) => set('disabled', v)} label="Disabled" hint="Blocks sign-in and revokes access." disabled={isSelf} />}
        </div>
      </div>
      <div className="modal-foot inline">
        <button className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy || !f.username.trim()}>{busy ? <Spinner size={18} /> : initial ? 'Save' : 'Create user'}</button>
      </div>
    </>
  );
}

export function UsersAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const { user: me } = useApp();
  const users = useAsync(() => api.users.list(), []);
  const libs = useAsync(() => api.libraries.list().catch(() => [] as Library[]), []);
  const [edit, setEdit] = useState<User | 'new' | null>(null);

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
      <AdminHeader title="Users" subtitle="Accounts, Plex-Home-style profiles, parental controls and permissions." actions={<button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add user</button>} />
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
                      {!u.hasPassword && <Badge tone="muted">Profile</Badge>}
                      <Badge tone="muted">{u.libraryIds === null ? 'All libraries' : `${u.libraryIds.length} libraries`}</Badge>
                      {u.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
                      {u.allowDvr && <Badge tone="muted">DVR</Badge>}
                    </div>
                  </td>
                  <td>{u.maxContentRating ?? <span className="muted">None</span>}</td>
                  <td className="muted">{relativeTime(u.lastSeenAt)}</td>
                  <td className="td-actions">
                    <Dropdown
                      trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label="Actions"><Icon name="more" /></button>}
                      items={[
                        { label: 'Edit', icon: 'edit', onClick: () => setEdit(u) },
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
