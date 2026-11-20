import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Profile, ProfileSettings } from '@mediamax/shared';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { api } from '../api/endpoints';
import { profilesApi } from '../api/profiles';
import { Badge, EmptyState, ErrorState, Field, Modal, Skeleton, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { PROFILE_COLORS, ProfileAvatar, ProfileEditor, useBuiltinAvatars } from '../components/ProfileEditor';
import '../styles/profiles.css';

/** The account owner's own entry: name, built-in avatar and colour (stored on the account itself). */
function OwnerEditor({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user, setUser } = useApp();
  const toast = useToast();
  const avatars = useBuiltinAvatars();
  const [name, setName] = useState(user?.displayName ?? '');
  const [avatarId, setAvatarId] = useState<string | null>(user?.avatarId ?? null);
  const [color, setColor] = useState<string | null>(user?.profileColor ?? null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const save = async () => {
    setBusy(true);
    try {
      setUser(await api.auth.updateMe({ displayName: name, profileColor: color, ...(avatarId !== (user.avatarId ?? null) ? { avatarId } : {}) }));
      toast.success('Saved');
      onClose();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const url = avatarId ? avatars.find((a) => a.id === avatarId)?.url ?? null : user.avatarUrl;
  return (
    <Modal open={open} onClose={onClose} title="Your profile" size="md"
      footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? <Spinner size={16} /> : 'Save'}</button></>}>
      <div className="profile-editor">
        <div className="pe-head">
          <ProfileAvatar name={name || user.username} url={url} color={color} size={96} />
          <div className="pe-head-fields">
            <Field label="Name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} /></Field>
            <small className="muted">Upload your own picture under Settings → Profile.</small>
          </div>
        </div>
        <div className="pe-avatars">
          {avatars.map((a) => (
            <button key={a.id} type="button" className={`pe-avatar ${avatarId === a.id ? 'active' : ''}`} onClick={() => { setAvatarId(a.id); setColor(a.color); }} title={a.name}>
              <img src={a.url} alt={a.name} width={56} height={56} />
            </button>
          ))}
        </div>
        <div className="pe-colors">
          {PROFILE_COLORS.map((c) => <button key={c} type="button" aria-label={c} className={`pe-color ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
      </div>
    </Modal>
  );
}

/** Settings → Profiles: add, edit and delete the account's profiles. */
export default function ProfilesSettings() {
  const { user, libraries } = useApp();
  const navigate = useNavigate();
  const list = useAsync(() => (user?.parentUserId ? Promise.resolve([] as Profile[]) : profilesApi.list()), [user?.id]);
  const limits = useAsync<ProfileSettings | null>(() => profilesApi.settings().catch(() => null), []);
  const [edit, setEdit] = useState<Profile | 'new' | null>(null);
  const [ownerOpen, setOwnerOpen] = useState(false);
  if (!user) return null;
  if (user.parentUserId) {
    return (
      <section className="settings-card">
        <EmptyState icon="users" title="Profiles are managed by the account owner" message={`Switch to ${user.ownerName ?? 'the owner'}'s profile to add or change profiles.`}
          action={<button className="btn btn-primary" onClick={() => navigate('/profiles')}><Icon name="users" size={16} /> Switch profile</button>} />
      </section>
    );
  }
  const max = limits.data?.maxPerAccount ?? 6;
  const count = (list.data?.length ?? 0) + 1;
  const enabled = limits.data?.enabled !== false;
  return (
    <section className="settings-card profiles-settings">
      <header>
        <div>
          <h2>Profiles</h2>
          <p className="muted ps-intro">Everyone in your household gets their own watch history, My List, recommendations and settings. Profiles sign in through your account and share its stream limit.</p>
        </div>
      </header>
      {list.loading && !list.data ? <Skeleton h={160} /> : list.error ? <ErrorState message={list.error} onRetry={list.reload} /> : (
        <>
          <div className="ps-grid">
            <div className="ps-card">
              <button className="ps-card-main" onClick={() => setOwnerOpen(true)} data-nav>
                <ProfileAvatar name={user.displayName || user.username} url={user.avatarUrl} color={user.profileColor} size={88} />
                <strong>{user.displayName || user.username}</strong>
                <Badge tone="primary">Owner</Badge>
              </button>
            </div>
            {(list.data ?? []).map((p) => (
              <div className="ps-card" key={p.id}>
                <button className="ps-card-main" onClick={() => setEdit(p)} data-nav aria-label={`Edit ${p.displayName}`}>
                  <ProfileAvatar name={p.displayName} url={p.avatarUrl} color={p.color} size={88} kids={p.isKids} />
                  <strong>{p.displayName}</strong>
                  <span className="ps-meta">
                    {p.hasPin && <Badge tone="muted"><Icon name="lock" size={10} /> PIN</Badge>}
                    {p.maxContentRating && <Badge tone="muted">{p.maxContentRating}</Badge>}
                  </span>
                </button>
              </div>
            ))}
            {enabled && count < max && (
              <div className="ps-card">
                <button className="ps-card-main ps-add" onClick={() => setEdit('new')} data-nav>
                  <span className="ps-add-icon"><Icon name="plus" size={36} /></span>
                  <strong>Add profile</strong>
                </button>
              </div>
            )}
          </div>
          <p className="muted ps-foot">
            {enabled ? `${count} of ${max} profiles.` : 'Profiles are turned off on this server.'} {count > 1 && <>You'll be asked who's watching when you sign in. <button className="ps-link" onClick={() => navigate('/profiles')}>Open the profile picker</button></>}
          </p>
        </>
      )}
      <ProfileEditor
        open={!!edit}
        profile={edit && edit !== 'new' ? edit : undefined}
        libraries={libraries}
        kidsDefaultRating={limits.data?.kidsDefaultRating}
        onClose={() => setEdit(null)}
        onSaved={(p) => {
          list.setData((d) => {
            const arr = d ?? [];
            return arr.some((x) => x.id === p.id) ? arr.map((x) => (x.id === p.id ? p : x)) : [...arr, p];
          });
          setEdit(null);
        }}
        onDeleted={(id) => {
          list.setData((d) => (d ?? []).filter((x) => x.id !== id));
          setEdit(null);
        }}
      />
      {ownerOpen && <OwnerEditor open onClose={() => setOwnerOpen(false)} />}
    </section>
  );
}
