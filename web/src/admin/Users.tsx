import { Fragment, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { CreateUserRequest, Library, RequestPermissions, RequestQuotas, User } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Avatar, AvatarEditor, Badge, Dropdown, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { CONTENT_RATINGS, isIptvLibrary, libraryIcon } from '../utils/items';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';
import { DEFAULT_QUOTAS, DEFAULT_REQUEST_PERMISSIONS, permissionSummary, QuotaEditor, RequestPermissionsEditor } from './RequestPermissionsEditor';
import { seerrApi } from '../api/seerr';
import type { Profile, ProfileSettings } from '@mediamax/shared';
import { profilesApi, RATING_CHOICES } from '../api/profiles';
import { ProfileAvatar, ProfileEditor } from '../components/ProfileEditor';

type Form = CreateUserRequest & { disabled?: boolean; requestPermissions: RequestPermissions; requestQuotas: RequestQuotas | null };

/** Server defaults for new users' request permissions and quotas. */
function useRequestDefaults() {
  return useAsync(async () => {
    const s = await api.admin.settings();
    return {
      permissions: { ...DEFAULT_REQUEST_PERMISSIONS, ...(s.requests?.defaultPermissions ?? {}) },
      quotas: s.requests?.defaultQuotas ?? { movie: { limit: s.requests?.weeklyLimit ?? 0, days: 7 }, show: { limit: s.requests?.weeklyLimit ?? 0, days: 7 }, music: { limit: s.requests?.weeklyLimit ?? 0, days: 7 }, book: { limit: s.requests?.weeklyLimit ?? 0, days: 7 } },
    };
  }, []);
}

/** Request permissions + quota override, shared by the user form and bulk edit. */
function RequestAccessSection({ perms, onPerms, quotas, onQuotas, defaults, isAdmin }: {
  perms: RequestPermissions; onPerms: (p: RequestPermissions) => void; quotas: RequestQuotas | null; onQuotas: (q: RequestQuotas | null) => void; defaults: RequestQuotas | null; isAdmin?: boolean;
}) {
  return (
    <>
      <section className="perm-section">
        <header><h4><Icon name="inbox" size={16} /> Requests</h4></header>
        <RequestPermissionsEditor value={perms} onChange={onPerms} isAdmin={isAdmin} />
      </section>
      {!isAdmin && (
        <section className="perm-section">
          <header>
            <h4><Icon name="clock" size={16} /> Request quota</h4>
            <Switch checked={quotas !== null} onChange={(v) => onQuotas(v ? quotas ?? defaults ?? DEFAULT_QUOTAS : null)} label="Custom quota" />
          </header>
          {quotas ? <QuotaEditor value={quotas} onChange={onQuotas} /> : <small className="muted">Uses the server defaults{defaults ? ` (${defaults.movie.limit || '∞'} movies / ${defaults.movie.days} days, ${defaults.show.limit || '∞'} seasons / ${defaults.show.days} days)` : ''}.</small>}
        </section>
      )}
    </>
  );
}

function UserForm({ initial, libraries, onSaved, onCancel, onAvatarChanged, defaults }: { initial?: User; libraries: Library[]; onSaved: (u: User) => void; onCancel: () => void; onAvatarChanged?: (u: User) => void; defaults: { permissions: RequestPermissions; quotas: RequestQuotas } | null }) {
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
    requestPermissions: initial?.requestPermissions ?? defaults?.permissions ?? DEFAULT_REQUEST_PERMISSIONS,
    requestQuotas: initial?.requestQuotas ?? null,
    allowRemote: initial?.allowRemote ?? true,
    maxStreams: initial?.maxStreams ?? null,
    disabled: initial?.disabled ?? false,
    showOnSignIn: initial?.showOnSignIn ?? false,
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
            <input className="input" type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" minLength={8} placeholder="At least 8 characters" />
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
          <Switch checked={!!f.allowTranscode} onChange={(v) => set('allowTranscode', v)} label="Allow transcoding" hint="When off, only direct play is allowed." />
          <Switch checked={!!f.allowDownloads} onChange={(v) => set('allowDownloads', v)} label="Downloads" />
          <Switch checked={!!f.allowRemote} onChange={(v) => set('allowRemote', v)} label="Allow streaming outside the home network" hint="When off, playback only works from the local network." />
          <Switch checked={!!f.showOnSignIn} onChange={(v) => set('showOnSignIn', v)} label="Show on sign-in screen" hint="List this user on the “Who’s watching?” picker before anyone signs in (home network only by default, see Server settings). Off: they type their username." />
          {initial && <Switch checked={!!f.disabled} onChange={(v) => set('disabled', v)} label="Disabled" hint="Blocks sign-in and revokes access." disabled={isSelf} />}
        </div>
        <RequestAccessSection perms={f.requestPermissions} onPerms={(p) => set('requestPermissions', p)} quotas={f.requestQuotas} onQuotas={(q) => set('requestQuotas', q)} defaults={defaults?.quotas ?? null} isAdmin={!!f.isAdmin} />
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
  const defaults = useRequestDefaults();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkOpen, setBulkOpen] = useState(false);
  const [defaultsOpen, setDefaultsOpen] = useState(false);
  const toggleSel = (id: string) => setSelected((s0) => {
    const n = new Set(s0);
    if (n.has(id)) n.delete(id);
    else n.add(id);
    return n;
  });
  // Account profiles are listed under their owner (and are never bulk-edited on their own).
  const owners = (users.data ?? []).filter((u) => !u.parentUserId);
  const profilesOf = (id: string) => (users.data ?? []).filter((u) => u.parentUserId === id);
  const [profileEdit, setProfileEdit] = useState<{ ownerId: string; profile?: Profile } | null>(null);
  const [profileSettingsOpen, setProfileSettingsOpen] = useState(false);
  const openProfile = async (ownerId: string, id?: string) => {
    try {
      setProfileEdit({ ownerId, profile: id ? await profilesApi.get(id) : undefined });
    } catch (e) {
      toast.error(e);
    }
  };
  const selectable = owners.filter((u) => !u.isAdmin);
  const allSel = selectable.length > 0 && selectable.every((u) => selected.has(u.id));

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
      <AdminHeader help="admin-users" title="Users" subtitle="Accounts, Plex-Home-style profiles, parental controls and permissions." actions={<><button className="btn" onClick={() => setProfileSettingsOpen(true)}><Icon name="users" size={16} /> Profile settings</button><button className="btn" onClick={() => setDefaultsOpen(true)}><Icon name="settings" size={16} /> Default permissions</button><Link className="btn" to="/admin/invites"><Icon name="link" size={16} /> Invites</Link><button className="btn btn-primary" onClick={() => setEdit('new')}><Icon name="plus" size={16} /> Add user</button></>} />
      {users.loading && !users.data ? <Skeleton h={200} /> : users.error ? <ErrorState message={users.error} onRetry={users.reload} /> : !users.data?.length ? <EmptyState icon="users" title="No users" /> : (
        <>
        {selected.size > 0 && (
          <div className="users-bulkbar" role="region" aria-label="Bulk edit">
            <strong>{selected.size} selected</strong>
            <span className="grow" />
            <button className="btn btn-sm btn-primary" onClick={() => setBulkOpen(true)}><Icon name="edit" size={14} /> Edit permissions</button>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>Clear</button>
          </div>
        )}
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th className="td-check"><input type="checkbox" aria-label="Select all non-admin users" checked={allSel} onChange={(e) => setSelected(e.target.checked ? new Set(selectable.map((u) => u.id)) : new Set())} /></th><th>User</th><th>Access</th><th>Rating limit</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {owners.map((u) => (
                <Fragment key={u.id}>
                <tr className={u.disabled ? 'dim' : ''}>
                  <td className="td-check">{!u.isAdmin && <input type="checkbox" aria-label={`Select ${u.displayName || u.username}`} checked={selected.has(u.id)} onChange={() => toggleSel(u.id)} />}</td>
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
                      {u.showOnSignIn && <Badge tone="muted">On sign-in screen</Badge>}
                      {u.hasPin && <Badge tone="muted"><Icon name="lock" size={10} /> PIN</Badge>}
                      {u.totpEnabled && <Badge tone="success"><Icon name="shield" size={10} /> 2FA</Badge>}
                      {u.maxStreams != null && <Badge tone="muted">{u.maxStreams} stream{u.maxStreams === 1 ? '' : 's'}</Badge>}
                      {u.allowRemote === false && <Badge tone="warning">Home only</Badge>}
                      {u.showOnSignIn && <Badge tone="muted"><Icon name="users" size={10} /> On sign-in screen</Badge>}
                      {!u.hasPassword && <Badge tone="muted">Profile</Badge>}
                      <Badge tone="muted">{u.libraryIds === null ? 'All libraries' : `${u.libraryIds.length} libraries`}</Badge>
                      {u.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
                      {u.allowDvr && <Badge tone="muted">DVR</Badge>}
                      {!u.isAdmin && u.requestPermissions?.manageRequests && <Badge tone="accent">Request manager</Badge>}
                      {!u.isAdmin && u.requestQuotas && <Badge tone="muted">Custom quota</Badge>}
                    </div>
                    {!u.isAdmin && u.requestPermissions && <div className="muted user-perm-sum">{permissionSummary(u.requestPermissions)}</div>}
                  </td>
                  <td>{u.maxContentRating ?? <span className="muted">None</span>}</td>
                  <td className="muted">{relativeTime(u.lastSeenAt)}</td>
                  <td className="td-actions">
                    <Dropdown
                      trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label="Actions"><Icon name="more" /></button>}
                      items={[
                        { label: 'Edit', icon: 'edit', onClick: () => setEdit(u) },
                        { label: 'Add profile', icon: 'users', onClick: () => void openProfile(u.id) },
                        { label: 'Year in review', icon: 'sparkles', onClick: () => navigate(`/admin/users/${u.id}/wrapped`) },
                        ...(u.totpEnabled ? [{ label: 'Reset two-factor', icon: 'shield' as const, onClick: () => resetTotp(u) }] : []),
                        ...(u.id !== me?.id ? [{ label: 'Delete', icon: 'trash' as const, danger: true, onClick: () => remove(u) }] : []),
                      ]}
                    />
                  </td>
                </tr>
                {profilesOf(u.id).map((p) => (
                  <tr key={p.id} className={`user-profile-row ${p.disabled ? 'dim' : ''}`}>
                    <td className="td-check" />
                    <td>
                      <div className="user-cell">
                        <ProfileAvatar name={p.displayName} url={p.avatarUrl} color={p.profileColor} size={32} />
                        <div>
                          <strong>{p.displayName}</strong>
                          <div className="muted">Profile · {u.displayName || u.username} › {p.displayName}</div>
                        </div>
                      </div>
                    </td>
                    <td>
                      <div className="badge-row">
                        <Badge tone={p.isKids ? 'accent' : 'muted'}>{p.isKids ? 'Kids profile' : 'Profile'}</Badge>
                        {p.hasPin && <Badge tone="muted"><Icon name="lock" size={10} /> PIN</Badge>}
                        <Badge tone="muted">{p.libraryIds === null ? 'All libraries' : `${p.libraryIds.length} libraries`}</Badge>
                        {p.allowLiveTv && <Badge tone="muted">Live TV</Badge>}
                        {p.requestQuotas && <Badge tone="muted">Own quota</Badge>}
                      </div>
                      {p.requestPermissions && <div className="muted user-perm-sum">{permissionSummary(p.requestPermissions)}</div>}
                    </td>
                    <td>{p.maxContentRating ?? <span className="muted">None</span>}</td>
                    <td className="muted">{relativeTime(p.lastSeenAt)}</td>
                    <td className="td-actions">
                      <button className="btn-icon" onClick={() => void openProfile(u.id, p.id)} aria-label={`Edit profile ${p.displayName}`}><Icon name="edit" /></button>
                    </td>
                  </tr>
                ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
        </>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit === 'new' ? 'Add user' : `Edit ${edit ? (edit as User).displayName || (edit as User).username : ''}`} size="lg">
        {edit && (
          <UserForm
            initial={edit === 'new' ? undefined : edit}
            libraries={libs.data ?? []}
            defaults={defaults.data ?? null}
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
      <BulkEditModal
        open={bulkOpen}
        users={(users.data ?? []).filter((u) => selected.has(u.id))}
        defaults={defaults.data ?? null}
        onClose={() => setBulkOpen(false)}
        onDone={(list) => {
          users.setData((d) => (d ?? []).map((x) => list.find((y) => y.id === x.id) ?? x));
          setBulkOpen(false);
          setSelected(new Set());
        }}
      />
      <ProfileEditor
        open={!!profileEdit}
        admin
        ownerId={profileEdit?.ownerId}
        profile={profileEdit?.profile}
        libraries={libs.data ?? []}
        onClose={() => setProfileEdit(null)}
        onSaved={() => { setProfileEdit(null); users.reload(); }}
        onDeleted={() => { setProfileEdit(null); users.reload(); }}
      />
      <ProfileSettingsModal open={profileSettingsOpen} onClose={() => setProfileSettingsOpen(false)} />
      <DefaultsModal open={defaultsOpen} initial={defaults.data ?? null} onClose={() => setDefaultsOpen(false)} onSaved={() => { setDefaultsOpen(false); defaults.reload(); }} />
    </div>
  );
}

/** Apply the same request permissions (and optionally quota) to several users at once. */
function BulkEditModal({ open, users, defaults, onClose, onDone }: { open: boolean; users: User[]; defaults: { permissions: RequestPermissions; quotas: RequestQuotas } | null; onClose: () => void; onDone: (u: User[]) => void }) {
  const toast = useToast();
  const [perms, setPerms] = useState<RequestPermissions>(DEFAULT_REQUEST_PERMISSIONS);
  const [applyQuota, setApplyQuota] = useState(false);
  const [quotas, setQuotas] = useState<RequestQuotas | null>(null);
  const [busy, setBusy] = useState(false);
  const key = open ? users.map((u) => u.id).join() : '';
  const [lastKey, setLastKey] = useState('');
  if (open && key !== lastKey) {
    setLastKey(key);
    setPerms(users[0]?.requestPermissions ?? defaults?.permissions ?? DEFAULT_REQUEST_PERMISSIONS);
    setApplyQuota(false);
    setQuotas(null);
  }
  const save = async () => {
    setBusy(true);
    try {
      const out = await seerrApi.bulkUsers({ userIds: users.map((u) => u.id), requestPermissions: perms, ...(applyQuota ? { requestQuotas: quotas } : {}) });
      toast.success(`Updated ${out.length} user${out.length === 1 ? '' : 's'}`);
      onDone(out);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title={`Edit ${users.length} user${users.length === 1 ? '' : 's'}`} size="lg"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void save()} disabled={busy || !users.length}>{busy ? <Spinner size={16} /> : 'Apply to all'}</button></>}>
      <div className="form-grid">
        <p className="muted" style={{ margin: 0 }}>{users.map((u) => u.displayName || u.username).join(', ')}</p>
        <section className="perm-section">
          <header><h4><Icon name="inbox" size={16} /> Request permissions</h4></header>
          <RequestPermissionsEditor value={perms} onChange={setPerms} />
        </section>
        <section className="perm-section">
          <header>
            <h4><Icon name="clock" size={16} /> Request quota</h4>
            <Switch checked={applyQuota} onChange={setApplyQuota} label="Change quota too" />
          </header>
          {applyQuota && (
            <>
              <Switch checked={quotas !== null} onChange={(v) => setQuotas(v ? defaults?.quotas ?? DEFAULT_QUOTAS : null)} label="Custom quota" hint="Off = the server defaults." />
              {quotas && <QuotaEditor value={quotas} onChange={setQuotas} />}
            </>
          )}
        </section>
      </div>
    </Modal>
  );
}

/** Server-wide defaults for new users (admin-created, invites, SSO). */
function DefaultsModal({ open, initial, onClose, onSaved }: { open: boolean; initial: { permissions: RequestPermissions; quotas: RequestQuotas } | null; onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [perms, setPerms] = useState<RequestPermissions>(DEFAULT_REQUEST_PERMISSIONS);
  const [quotas, setQuotas] = useState<RequestQuotas>(DEFAULT_QUOTAS);
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  if (open && !loaded && initial) {
    setLoaded(true);
    setPerms(initial.permissions);
    setQuotas(initial.quotas);
  }
  if (!open && loaded) setLoaded(false);
  const save = async () => {
    setBusy(true);
    try {
      const cur = await api.admin.settings();
      await api.admin.saveSettingsPatch({ requests: { ...cur.requests, defaultPermissions: perms, defaultQuotas: quotas } });
      toast.success('Default permissions saved');
      onSaved();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Default permissions for new users" size="lg"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? <Spinner size={16} /> : 'Save defaults'}</button></>}>
      <div className="form-grid">
        <p className="muted" style={{ margin: 0 }}>Applied to users created from now on — by an admin, an invite link or single sign-on. Existing users keep their own permissions (use bulk edit to change them). Quotas apply to every user without a custom quota.</p>
        <section className="perm-section">
          <header><h4><Icon name="inbox" size={16} /> Request permissions</h4></header>
          <RequestPermissionsEditor value={perms} onChange={setPerms} />
        </section>
        <section className="perm-section">
          <header><h4><Icon name="clock" size={16} /> Default request quota</h4></header>
          <QuotaEditor value={quotas} onChange={setQuotas} />
        </section>
      </div>
    </Modal>
  );
}

const DEFAULT_PROFILE_SETTINGS: ProfileSettings = { enabled: true, maxPerAccount: 6, kidsLiveTv: false, kidsDefaultRating: 'PG', kidsHideUnrated: true };

/** Server-wide account profile settings (stored as ServerSettings.profiles). */
function ProfileSettingsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<ProfileSettings | null>(null);
  const [busy, setBusy] = useState(false);
  if (open && !s) {
    setS(DEFAULT_PROFILE_SETTINGS);
    void api.admin.settings().then((cur) => setS({ ...DEFAULT_PROFILE_SETTINGS, ...(cur.profiles ?? {}) })).catch(() => undefined);
  }
  if (!open && s) setS(null);
  const set = (p: Partial<ProfileSettings>) => setS((x) => ({ ...(x ?? DEFAULT_PROFILE_SETTINGS), ...p }));
  const save = async () => {
    if (!s) return;
    setBusy(true);
    try {
      await api.admin.saveSettingsPatch({ profiles: s });
      toast.success('Profile settings saved');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={onClose} title="Account profiles" size="md"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void save()} disabled={busy || !s}>{busy ? <Spinner size={16} /> : 'Save'}</button></>}>
      {s && (
        <div className="form-grid">
          <p className="muted" style={{ margin: 0 }}>Profiles let everyone in a household have their own history, My List and settings under one account, Plex Home style. They share the account's stream limit and never get more access than the account owner.</p>
          <Switch checked={s.enabled} onChange={(v) => set({ enabled: v })} label="Allow profiles" hint="Account owners can add profiles in Settings → Profiles." />
          <Field label="Profiles per account" hint="Including the owner's own profile.">
            <input className="input" type="number" min={1} max={20} value={s.maxPerAccount} onChange={(e) => set({ maxPerAccount: Math.max(1, Math.min(20, Math.floor(Number(e.target.value)) || 1)) })} />
          </Field>
          <Field label="Default rating limit for kids profiles">
            <select className="input" value={s.kidsDefaultRating} onChange={(e) => set({ kidsDefaultRating: e.target.value })}>
              {RATING_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <Switch checked={s.kidsHideUnrated} onChange={(v) => set({ kidsHideUnrated: v })} label="New kids profiles hide unrated titles" />
          <Switch checked={s.kidsLiveTv} onChange={(v) => set({ kidsLiveTv: v })} label="Kids profiles can watch Live TV" hint="Channels have no age ratings, so Live TV is off for kids profiles unless you allow it here." />
        </div>
      )}
    </Modal>
  );
}
