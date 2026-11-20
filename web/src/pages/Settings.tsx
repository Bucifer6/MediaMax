import { useState, type FormEvent } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Device, Theme, UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Avatar, Badge, EmptyState, Field, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { themeStyle } from '../theme/applyTheme';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { QUALITY_OPTIONS } from '../player/deviceProfile';
import { relativeTime } from '../utils/format';
import { LinkDeviceForm } from './LinkDevice';

const LANGS = [
  ['', 'Default'], ['en', 'English'], ['es', 'Spanish'], ['fr', 'French'], ['de', 'German'], ['it', 'Italian'], ['pt', 'Portuguese'],
  ['nl', 'Dutch'], ['sv', 'Swedish'], ['no', 'Norwegian'], ['da', 'Danish'], ['fi', 'Finnish'], ['pl', 'Polish'], ['ru', 'Russian'],
  ['tr', 'Turkish'], ['ar', 'Arabic'], ['hi', 'Hindi'], ['ja', 'Japanese'], ['ko', 'Korean'], ['zh', 'Chinese'],
] as const;

function usePrefs() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const prefs: UserPreferences = { ...DEFAULT_PREFERENCES, ...(user?.preferences ?? {}) };
  const save = async (patch: Partial<UserPreferences>) => {
    if (!user) return;
    const optimistic = { ...user, preferences: { ...prefs, ...patch } };
    setUser(optimistic);
    try {
      setUser(await api.auth.updateMe({ preferences: patch }));
    } catch (e) {
      setUser(user);
      toast.error(e);
    }
  };
  return { prefs, save };
}

function Profile() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      setUser(await api.auth.updateMe({ displayName: name.trim() }));
      toast.success('Profile updated');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="settings-card" onSubmit={submit}>
      <div className="profile-head">
        <Avatar name={user.displayName || user.username} url={user.avatarUrl} size={80} />
        <div>
          <h2>{user.displayName || user.username}</h2>
          <p className="muted">@{user.username} {user.isAdmin && <Badge tone="primary">Admin</Badge>}</p>
        </div>
      </div>
      <Field label="Display name"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <div className="form-actions"><button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? <Spinner size={18} /> : 'Save'}</button></div>
    </form>
  );
}

function Security() {
  const { user, setUser } = useApp();
  const toast = useToast();
  const [cur, setCur] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  if (!user) return null;
  const savePw = async (e: FormEvent) => {
    e.preventDefault();
    if (pw !== pw2) return toast.show('Passwords don’t match', 'error');
    setBusy(true);
    try {
      setUser(await api.auth.updateMe({ currentPassword: cur || undefined, password: pw }));
      setCur(''); setPw(''); setPw2('');
      toast.success('Password changed');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const savePin = async (value: string) => {
    setBusy(true);
    try {
      setUser(await api.auth.updateMe({ pin: value }));
      setPin('');
      toast.success(value ? 'PIN saved' : 'PIN removed');
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <form className="settings-card" onSubmit={savePw}>
        <h2>Password</h2>
        {user.hasPassword && <Field label="Current password"><input className="input" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" /></Field>}
        <div className="form-row">
          <Field label="New password"><input className="input" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" /></Field>
          <Field label="Confirm"><input className="input" type="password" value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" /></Field>
        </div>
        <div className="form-actions"><button className="btn btn-primary" disabled={busy || !pw}>Change password</button></div>
      </form>
      <form className="settings-card" onSubmit={(e) => { e.preventDefault(); void savePin(pin); }}>
        <h2>Profile PIN</h2>
        <p className="muted">A 4-digit PIN protects your profile on the “Who’s watching?” screen. {user.hasPin ? <Badge tone="success">PIN set</Badge> : <Badge tone="muted">No PIN</Badge>}</p>
        <Field label="New PIN"><input className="input code-input small" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 4))} placeholder="••••" /></Field>
        <div className="form-actions">
          {user.hasPin && <button type="button" className="btn btn-ghost" onClick={() => savePin('')} disabled={busy}>Remove PIN</button>}
          <button className="btn btn-primary" disabled={busy || pin.length !== 4}>Save PIN</button>
        </div>
      </form>
    </>
  );
}

export function ThemeSwatch({ theme, active, onClick }: { theme: Theme; active?: boolean; onClick?: () => void }) {
  return (
    <button type="button" className={`theme-swatch ${active ? 'active' : ''}`} onClick={onClick} style={themeStyle(theme)}>
      <span className="ts-preview">
        <span className="ts-bar" />
        <span className="ts-cards"><i /><i /><i /></span>
        <span className="ts-btn" />
      </span>
      <span className="ts-name">{theme.name} {active && <Icon name="checkCircle" size={16} />}</span>
    </button>
  );
}

function Appearance() {
  const { branding } = useApp();
  const { prefs, save } = usePrefs();
  if (!branding.allowUserThemes) {
    return <div className="settings-card"><EmptyState icon="palette" title="Themes are managed by your admin" message="This server uses one look for everyone." /></div>;
  }
  return (
    <div className="settings-card">
      <h2>Theme</h2>
      <p className="muted">Pick how {branding.serverName} looks for you on this and every other device.</p>
      <div className="theme-grid">
        <button type="button" className={`theme-swatch theme-default ${!prefs.themeId ? 'active' : ''}`} onClick={() => save({ themeId: null })}>
          <span className="ts-preview ts-auto"><Icon name="sparkles" size={28} /></span>
          <span className="ts-name">Server default {!prefs.themeId && <Icon name="checkCircle" size={16} />}</span>
        </button>
        {branding.themes.map((t) => <ThemeSwatch key={t.id} theme={t} active={prefs.themeId === t.id} onClick={() => save({ themeId: t.id })} />)}
      </div>
    </div>
  );
}

function Playback() {
  const { prefs, save } = usePrefs();
  return (
    <div className="settings-card">
      <h2>Playback</h2>
      <div className="form-row">
        <Field label="Preferred audio language">
          <select className="select" value={prefs.audioLanguage ?? ''} onChange={(e) => save({ audioLanguage: e.target.value || null })}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <Field label="Preferred subtitle language">
          <select className="select" value={prefs.subtitleLanguage ?? ''} onChange={(e) => save({ subtitleLanguage: e.target.value || null })}>
            {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
      </div>
      <div className="form-row">
        <Field label="Subtitles">
          <select className="select" value={prefs.subtitleMode} onChange={(e) => save({ subtitleMode: e.target.value as UserPreferences['subtitleMode'] })}>
            <option value="off">Off</option>
            <option value="auto">Auto (when audio is foreign)</option>
            <option value="always">Always on</option>
            <option value="forced">Forced only</option>
          </select>
        </Field>
        <Field label="Streaming quality">
          <select className="select" value={prefs.maxBitrate ?? ''} onChange={(e) => save({ maxBitrate: e.target.value ? Number(e.target.value) : null })}>
            {QUALITY_OPTIONS.map((q) => <option key={q.label} value={q.kbps ?? ''}>{q.label}</option>)}
          </select>
        </Field>
      </div>
      <div className="switch-group">
        <Switch checked={prefs.autoplayNext} onChange={(v) => save({ autoplayNext: v })} label="Autoplay next episode" hint="Shows an Up Next card with a countdown." />
        <Switch checked={prefs.skipIntros} onChange={(v) => save({ skipIntros: v })} label="Automatically skip intros" hint="Uses intro markers when available." />
      </div>
    </div>
  );
}

function Devices() {
  const toast = useToast();
  const confirm = useConfirm();
  const devices = useAsync(() => api.auth.devices(), []);
  const revoke = async (d: Device) => {
    if (!(await confirm({ title: `Sign out ${d.deviceName}?`, message: 'That device will need to sign in again.', confirmLabel: 'Sign out device', danger: true }))) return;
    try {
      await api.auth.revokeDevice(d.id);
      devices.setData((l) => (l ?? []).filter((x) => x.id !== d.id));
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <div className="settings-card">
      <h2>Signed-in devices</h2>
      {devices.loading && !devices.data ? <Skeleton h={120} /> : !devices.data?.length ? <p className="muted">No devices.</p> : (
        <ul className="device-list">
          {devices.data.map((d) => (
            <li key={d.id}>
              <Icon name={d.platform === 'web' ? 'monitor' : d.platform === 'ios' || d.platform === 'android' ? 'device' : 'tv'} size={22} />
              <div>
                <strong>{d.deviceName}</strong> {d.current && <Badge tone="success">This device</Badge>}
                <div className="muted">{d.platform}{d.appVersion ? ` · v${d.appVersion}` : ''} · active {relativeTime(d.lastSeenAt)}</div>
              </div>
              {!d.current && <button className="btn btn-ghost btn-sm" onClick={() => revoke(d)}>Sign out</button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function LinkTab() {
  return (
    <div className="settings-card">
      <h2>Link a device</h2>
      <LinkDeviceForm />
    </div>
  );
}

export default function SettingsPage() {
  const { features } = useApp();
  const tabs: { to: string; label: string; icon: IconName }[] = [
    { to: 'profile', label: 'Profile', icon: 'user' },
    { to: 'security', label: 'Password & PIN', icon: 'lock' },
    { to: 'appearance', label: 'Appearance', icon: 'palette' },
    { to: 'playback', label: 'Playback', icon: 'play' },
    { to: 'devices', label: 'Devices', icon: 'device' },
    ...(features.linkCodes ? [{ to: 'link', label: 'Link device', icon: 'link' as IconName }] : []),
  ];
  return (
    <div className="page settings-page">
      <header className="page-head">
        <div className="page-title-wrap"><Icon name="settings" size={28} className="page-icon" /><h1>Settings</h1></div>
      </header>
      <div className="settings-layout">
        <nav className="settings-nav">
          {tabs.map((t) => (
            <NavLink key={t.to} to={t.to} className={({ isActive }) => `settings-link ${isActive ? 'active' : ''}`}>
              <Icon name={t.icon} size={18} /> {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="settings-content">
          <Routes>
            <Route index element={<Navigate to="profile" replace />} />
            <Route path="profile" element={<Profile />} />
            <Route path="security" element={<Security />} />
            <Route path="appearance" element={<Appearance />} />
            <Route path="playback" element={<Playback />} />
            <Route path="devices" element={<Devices />} />
            <Route path="link" element={<LinkTab />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
