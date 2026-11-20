import { useEffect, useRef, useState } from 'react';
import type { BuiltinAvatar, CreateProfileRequest, Library, Profile, RequestPermissions, RequestQuotas } from '@mediamax/shared';
import { profilesApi, RATING_CHOICES } from '../api/profiles';
import { useToast } from '../state/toast';
import { Field, Modal, Spinner, Switch, useConfirm } from './ui';
import { Icon } from './Icon';
import { DEFAULT_QUOTAS, DEFAULT_REQUEST_PERMISSIONS, QuotaEditor, RequestPermissionsEditor } from '../admin/RequestPermissionsEditor';
import { ProfileAvatar } from './ProfileAvatar';
import '../styles/profiles.css';

export { ProfileAvatar };

export const PROFILE_COLORS = ['#e50914', '#f5b700', '#2a9d8f', '#4361ee', '#7b2cbf', '#ef476f', '#06d6a0', '#ff7a59', '#8d6e63', '#48cae4'];

const LANGUAGES: [string, string][] = [
  ['', 'Server default'], ['en', 'English'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano'], ['nl', 'Nederlands'],
  ['pt', 'Português'], ['sv', 'Svenska'], ['da', 'Dansk'], ['no', 'Norsk'], ['fi', 'Suomi'], ['pl', 'Polski'], ['tr', 'Türkçe'], ['ja', '日本語'], ['ko', '한국어'], ['zh', '中文'],
];

let avatarCache: BuiltinAvatar[] | null = null;
/** Built-in avatar set (cached for the session). */
export function useBuiltinAvatars(): BuiltinAvatar[] {
  const [list, setList] = useState<BuiltinAvatar[]>(avatarCache ?? []);
  useEffect(() => {
    if (avatarCache) return;
    profilesApi.avatars().then((a) => { avatarCache = a; setList(a); }).catch(() => undefined);
  }, []);
  return list;
}

type Draft = Required<Pick<CreateProfileRequest, 'displayName' | 'isKids' | 'hideUnrated' | 'allowLiveTv' | 'allowDownloads'>> & {
  avatarId: string | null; color: string | null; language: string; maxContentRating: string | null; libraryIds: string[] | null;
  kidsTheme: boolean; requestPermissions: RequestPermissions | null; requestQuotas: RequestQuotas | null;
};

const fromProfile = (p?: Profile): Draft => ({
  displayName: p?.displayName ?? '',
  avatarId: p ? p.avatarId : 'sunny',
  color: p?.color ?? null,
  isKids: p?.isKids ?? false,
  hideUnrated: p?.hideUnrated ?? false,
  allowLiveTv: p?.allowLiveTv ?? true,
  allowDownloads: p?.allowDownloads ?? true,
  language: p?.language ?? '',
  maxContentRating: p?.maxContentRating ?? null,
  libraryIds: p?.libraryIds ?? null,
  kidsTheme: p ? p.themeId === 'kids' : false,
  requestPermissions: p?.requestPermissions ?? null,
  requestQuotas: p?.requestQuotas ?? null,
});

/**
 * Add / edit a profile. Used by Settings → Profiles (the owner) and Admin → Users (any account; `admin` unlocks
 * full request permissions and the quota override).
 */
export function ProfileEditor({ open, profile, ownerId, libraries, admin, kidsDefaultRating = 'PG', onClose, onSaved, onDeleted }: {
  open: boolean; profile?: Profile; ownerId?: string; libraries: Library[]; admin?: boolean; kidsDefaultRating?: string;
  onClose: () => void; onSaved: (p: Profile) => void; onDeleted?: (id: string) => void;
}) {
  const toast = useToast();
  const confirm = useConfirm();
  const avatars = useBuiltinAvatars();
  const [d, setD] = useState<Draft>(() => fromProfile(profile));
  const [pin, setPin] = useState('');
  const [clearPin, setClearPin] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const key = open ? profile?.id ?? 'new' : '';
  const [lastKey, setLastKey] = useState('');
  if (key !== lastKey) {
    setLastKey(key);
    setD(fromProfile(profile));
    setPin('');
    setClearPin(false);
    setFile(null);
    setPreview(null);
  }
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const avatarUrl = preview ?? (d.avatarId ? avatars.find((a) => a.id === d.avatarId)?.url ?? null : profile?.avatarUrl ?? null);
  const toggleLib = (id: string) => {
    const cur = d.libraryIds ?? libraries.map((l) => l.id);
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    set('libraryIds', next.length === libraries.length ? null : next);
  };
  const setKids = (v: boolean) => setD((x) => ({
    ...x, isKids: v, kidsTheme: v, hideUnrated: v ? true : x.hideUnrated,
    maxContentRating: v && !x.maxContentRating ? kidsDefaultRating : x.maxContentRating,
    requestPermissions: v ? { ...DEFAULT_REQUEST_PERMISSIONS, movie: 'none', show: 'none', music: 'none', book: 'none', reportIssues: false } : x.requestPermissions,
  }));
  const pinBad = !!pin && !/^\d{4,8}$/.test(pin);

  const save = async () => {
    if (!d.displayName.trim()) return toast.show('Give the profile a name', 'error');
    if (pinBad) return toast.show('PIN must be 4–8 digits', 'error');
    setBusy(true);
    try {
      const body: CreateProfileRequest = {
        displayName: d.displayName.trim(), color: d.color, isKids: d.isKids, hideUnrated: d.hideUnrated, allowLiveTv: d.allowLiveTv,
        allowDownloads: d.allowDownloads, language: d.language || null, maxContentRating: d.maxContentRating, libraryIds: d.libraryIds,
        kidsTheme: d.kidsTheme, requestPermissions: d.requestPermissions,
        ...(file ? {} : { avatarId: d.avatarId }),
        ...(admin ? { requestQuotas: d.requestQuotas } : {}),
        ...(pin ? { pin } : clearPin ? { pin: '' } : {}),
      };
      let p = profile ? await profilesApi.update(profile.id, body) : await profilesApi.create(body, ownerId);
      if (file) p = await profilesApi.uploadAvatar(p.id, file);
      toast.success(profile ? 'Profile saved' : `${p.displayName} added`);
      onSaved(p);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!profile) return;
    if (!(await confirm({ title: `Delete ${profile.displayName}?`, message: 'Their watch history, My List, ratings and settings are deleted. This cannot be undone.', confirmLabel: 'Delete profile', danger: true }))) return;
    try {
      await profilesApi.remove(profile.id);
      toast.success('Profile deleted');
      onDeleted?.(profile.id);
    } catch (e) {
      toast.error(e);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={profile ? `Edit ${profile.displayName}` : 'Add profile'}
      size="lg"
      className="profile-editor-modal"
      footer={
        <>
          {profile && onDeleted && <button className="btn btn-ghost btn-danger-text" onClick={() => void remove()}><Icon name="trash" size={16} /> Delete</button>}
          <span className="pe-grow" />
          <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={() => void save()} disabled={busy}>{busy ? <Spinner size={16} /> : profile ? 'Save' : 'Add profile'}</button>
        </>
      }
    >
      <div className="profile-editor">
        <div className="pe-head">
          <ProfileAvatar name={d.displayName || '?'} url={avatarUrl} color={d.color} size={104} kids={d.isKids} />
          <div className="pe-head-fields">
            <Field label="Name">
              <input className="input" value={d.displayName} maxLength={40} onChange={(e) => set('displayName', e.target.value)} placeholder="e.g. Sam" autoFocus />
            </Field>
            <Switch checked={d.isKids} onChange={setKids} label="Kids profile" hint="Only titles up to the rating limit, a simpler kids theme, no requests." />
          </div>
        </div>

        <section className="pe-section">
          <h4>Avatar</h4>
          <div className="pe-avatars" role="radiogroup" aria-label="Avatar">
            {avatars.map((a) => (
              <button key={a.id} type="button" role="radio" aria-checked={!file && d.avatarId === a.id} className={`pe-avatar ${!file && d.avatarId === a.id ? 'active' : ''}`} title={a.name} data-nav
                onClick={() => { setFile(null); setPreview(null); setD((x) => ({ ...x, avatarId: a.id, color: a.color })); }}>
                <img src={a.url} alt={a.name} width={56} height={56} />
              </button>
            ))}
            <button type="button" className={`pe-avatar pe-upload ${file ? 'active' : ''}`} onClick={() => fileInput.current?.click()} title="Upload a picture" data-nav>
              <Icon name="upload" size={20} />
              <span>Upload</span>
            </button>
            <input ref={fileInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              setFile(f);
              setPreview(URL.createObjectURL(f));
              set('avatarId', null);
            }} />
          </div>
          <div className="pe-colors" role="radiogroup" aria-label="Colour">
            {PROFILE_COLORS.map((c) => (
              <button key={c} type="button" role="radio" aria-checked={d.color === c} aria-label={c} className={`pe-color ${d.color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => set('color', c)} />
            ))}
          </div>
        </section>

        <div className="pe-grid">
          <Field label="Profile PIN" hint={profile?.hasPin && !clearPin ? 'Has a PIN. Type a new one to change it.' : '4–8 digits, asked for when switching to this profile.'}>
            <div className="row-gap">
              <input className="input" inputMode="numeric" pattern="[0-9]*" maxLength={8} value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setClearPin(false); }} placeholder={profile?.hasPin && !clearPin ? '••••' : 'No PIN'} aria-invalid={pinBad} autoComplete="off" />
              {profile?.hasPin && !clearPin && <button type="button" className="btn btn-sm btn-ghost" onClick={() => { setClearPin(true); setPin(''); }}>Remove</button>}
            </div>
          </Field>
          <Field label="Audio & subtitle language">
            <select className="input" value={d.language} onChange={(e) => set('language', e.target.value)}>
              {LANGUAGES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
          <Field label="Maturity rating limit" hint="Titles rated above this are hidden. The account's own limit still applies.">
            <select className="input" value={d.maxContentRating ?? ''} onChange={(e) => set('maxContentRating', e.target.value || null)}>
              <option value="">No limit</option>
              {RATING_CHOICES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </Field>
          <div className="field pe-switches">
            <Switch checked={d.hideUnrated} onChange={(v) => set('hideUnrated', v)} label="Hide unrated titles" disabled={!d.maxContentRating} />
            {d.isKids && <Switch checked={d.kidsTheme} onChange={(v) => set('kidsTheme', v)} label="Kids theme" />}
            <Switch checked={d.allowLiveTv} onChange={(v) => set('allowLiveTv', v)} label="Live TV" hint={d.isKids ? 'Only if the server allows Live TV for kids profiles.' : undefined} />
            <Switch checked={d.allowDownloads} onChange={(v) => set('allowDownloads', v)} label="Downloads" />
          </div>
        </div>

        {libraries.length > 0 && (
          <section className="pe-section">
            <h4>Libraries</h4>
            <div className="lib-access">
              {libraries.map((l) => (
                <label key={l.id} className="check-chip">
                  <input type="checkbox" checked={d.libraryIds === null || d.libraryIds.includes(l.id)} onChange={() => toggleLib(l.id)} /> {l.name}
                </label>
              ))}
            </div>
          </section>
        )}

        <section className="pe-section">
          <header className="pe-section-head">
            <h4>Requests</h4>
            <Switch checked={d.requestPermissions === null} onChange={(v) => set('requestPermissions', v ? null : { ...DEFAULT_REQUEST_PERMISSIONS, movie: 'none', show: 'none', music: 'none', book: 'none', movie4k: 'none', show4k: 'none' })} label="Same as the account" />
          </header>
          {d.requestPermissions === null ? (
            <small className="muted">This profile can request what the account owner can.</small>
          ) : (
            <>
              <RequestPermissionsEditor value={d.requestPermissions} onChange={(v) => set('requestPermissions', v)} />
              {!admin && <small className="muted">A profile can never request more than the account owner.</small>}
            </>
          )}
          {admin && (
            <div className="pe-quota">
              <Switch checked={d.requestQuotas !== null} onChange={(v) => set('requestQuotas', v ? DEFAULT_QUOTAS : null)} label="Own request quota" hint="Off: requests count toward the account owner's quota." />
              {d.requestQuotas && <QuotaEditor value={d.requestQuotas} onChange={(v) => set('requestQuotas', v)} />}
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
}
