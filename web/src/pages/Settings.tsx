import { useEffect, useState, type FormEvent } from 'react';
import { Link, NavLink, Navigate, Route, Routes } from 'react-router-dom';
import type { Device, SubtitleStyle, Theme, TraktDeviceCode, UserPreferences } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { AvatarEditor, Badge, EmptyState, Field, Skeleton, Spinner, Switch, useConfirm } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import { themeStyle } from '../theme/applyTheme';
import { DEFAULT_PREFERENCES } from '../theme/defaults';
import { QUALITY_OPTIONS } from '../player/deviceProfile';
import { DEFAULT_SUBTITLE_STYLE, SUBTITLE_FIELD_LABELS, SUBTITLE_OPTIONS, subtitlePreviewStyle, subtitleStyleOf } from '../player/subtitleStyle';
import { relativeTime } from '../utils/format';
import { LinkDeviceForm } from './LinkDevice';
import { ApiKeysCard, SubsonicCard, TwoFactorCard } from './SecuritySettings';
import { BrowsingSettings } from './BrowsingSettings';

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
        <AvatarEditor
          name={user.displayName || user.username}
          url={user.avatarUrl}
          size={80}
          onUpload={async (file) => {
            try {
              setUser(await api.auth.uploadAvatar(file));
              toast.success('Profile picture updated');
            } catch (err) {
              toast.error(err);
            }
          }}
          onRemove={async () => {
            try {
              setUser(await api.auth.deleteAvatar());
              toast.success('Profile picture removed');
            } catch (err) {
              toast.error(err);
            }
          }}
        />
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
        <p className="muted">A 4–8 digit PIN protects your profile on the “Who’s watching?” screen. {user.hasPin ? <Badge tone="success">PIN set</Badge> : <Badge tone="muted">No PIN</Badge>}</p>
        <Field label="New PIN"><input className="input code-input small" inputMode="numeric" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 8))} placeholder="••••" maxLength={8} /></Field>
        <div className="form-actions">
          {user.hasPin && <button type="button" className="btn btn-ghost" onClick={() => savePin('')} disabled={busy}>Remove PIN</button>}
          <button className="btn btn-primary" disabled={busy || pin.length < 4}>Save PIN</button>
        </div>
      </form>
      <TwoFactorCard />
      <ApiKeysCard />
      <SubsonicCard />
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

/** Subtitle appearance with a live preview (applies to the video and live TV players). */
function SubtitleSettings() {
  const { prefs, save } = usePrefs();
  const style = subtitleStyleOf(prefs.subtitleStyle);
  const set = (patch: Partial<SubtitleStyle>) => save({ subtitleStyle: { ...style, ...patch } });
  const isDefault = (Object.keys(DEFAULT_SUBTITLE_STYLE) as (keyof SubtitleStyle)[]).every((k) => style[k] === DEFAULT_SUBTITLE_STYLE[k]);
  return (
    <div className="settings-card" id="subtitles">
      <h2>Subtitles</h2>
      <div className={`subtitle-preview ${style.position === 'raised' ? 'raised' : ''}`} aria-label="Subtitle preview" role="img">
        <span className="subtitle-preview-label">Preview</span>
        <span className="subtitle-preview-text" style={subtitlePreviewStyle(style, 22)}>{'I never said she stole my money.\nSomeone else did.'}</span>
      </div>
      <div className="subtitle-fields">
        {(Object.keys(SUBTITLE_OPTIONS) as (keyof SubtitleStyle)[]).map((field) => (
          <Field key={field} label={SUBTITLE_FIELD_LABELS[field]}>
            <select className="select" value={style[field]} onChange={(e) => set({ [field]: e.target.value } as Partial<SubtitleStyle>)}>
              {SUBTITLE_OPTIONS[field].map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </Field>
        ))}
      </div>
      <p className="muted small">
        Applies to text subtitles and live TV captions. While watching, the subtitle menu has the same options, and <kbd>G</kbd> / <kbd>H</kbd> shift subtitle timing by 0.1 s.
        {!isDefault && <> <button type="button" className="btn btn-ghost btn-sm" onClick={() => save({ subtitleStyle: DEFAULT_SUBTITLE_STYLE })}>Reset to default</button></>}
      </p>
    </div>
  );
}

/** Music playback: crossfade and loudness levelling. */
function MusicSettings() {
  const { prefs, save } = usePrefs();
  const xf = prefs.musicCrossfadeSec ?? 0;
  const [draft, setDraft] = useState(xf);
  useEffect(() => setDraft(xf), [xf]);
  return (
    <div className="settings-card" id="music">
      <h2>Music</h2>
      <div className="form-row">
        <Field label={`Crossfade · ${draft ? `${draft} s` : 'off (gapless)'}`} hint="Blend the end of one song into the next. Albums played in order stay gapless.">
          <input
            className="range"
            type="range"
            min={0}
            max={12}
            step={1}
            value={draft}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => draft !== xf && save({ musicCrossfadeSec: draft })}
            onKeyUp={() => draft !== xf && save({ musicCrossfadeSec: draft })}
            onBlur={() => draft !== xf && save({ musicCrossfadeSec: draft })}
            aria-label="Crossfade seconds"
          />
        </Field>
        <Field label="Volume levelling (ReplayGain)">
          <select className="select" value={prefs.replayGain ?? 'auto'} onChange={(e) => save({ replayGain: e.target.value as NonNullable<UserPreferences['replayGain']> })}>
            <option value="auto">Automatic (album gain for albums in order)</option>
            <option value="track">Track gain</option>
            <option value="album">Album gain</option>
            <option value="off">Off</option>
          </select>
        </Field>
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

function TraktCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useAsync(() => api.trakt.status(), []);
  const [code, setCode] = useState<TraktDeviceCode | null>(null);
  const [expired, setExpired] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = status.data;

  // Poll while a device code is waiting for approval.
  useEffect(() => {
    if (!code) return;
    const expiresAt = new Date(code.expiresAt).getTime();
    const every = Math.max(5, code.intervalSeconds || 5) * 1000;
    let stopped = false;
    const t = window.setInterval(async () => {
      if (Date.now() >= expiresAt) {
        window.clearInterval(t);
        setCode(null);
        setExpired(true);
        return;
      }
      try {
        const s = await api.trakt.status();
        if (stopped) return;
        if (s.connected) {
          window.clearInterval(t);
          setCode(null);
          status.setData(s);
          toast.success(`Connected to Trakt${s.username ? ` as ${s.username}` : ''}`);
        }
      } catch {
        /* keep polling */
      }
    }, every);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  const connect = async () => {
    setBusy(true);
    setExpired(false);
    try {
      setCode(await api.trakt.connect());
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const setScrobble = async (scrobble: boolean) => {
    if (!st) return;
    status.setData({ ...st, scrobble });
    try {
      status.setData(await api.trakt.update({ scrobble }));
    } catch (e) {
      status.setData(st);
      toast.error(e);
    }
  };
  const disconnect = async () => {
    if (!(await confirm({ title: 'Disconnect Trakt?', message: 'MediaMax will stop scrobbling to your Trakt account.', confirmLabel: 'Disconnect', danger: true }))) return;
    setBusy(true);
    try {
      status.setData(await api.trakt.disconnect());
      toast.success('Trakt disconnected');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card service-card">
      <div className="service-head">
        <span className="service-logo trakt-logo" aria-hidden="true">t</span>
        <div className="service-title">
          <h2>Trakt</h2>
          <p className="muted">Keep your watch history, ratings and progress in sync across apps.</p>
        </div>
        {st?.connected && <Badge tone="success"><Icon name="check" size={12} /> Connected</Badge>}
      </div>
      {status.loading && !st ? <Skeleton h={60} /> : status.error ? (
        <p className="form-error">{status.error} <button className="btn btn-ghost btn-sm" onClick={status.reload}>Retry</button></p>
      ) : !st ? null : !st.available ? (
        <div className="service-note"><Icon name="info" size={18} /> <span>Ask your server admin to set up Trakt.</span></div>
      ) : st.connected ? (
        <>
          <p>Signed in as <strong>{st.username ?? 'your Trakt account'}</strong>.</p>
          <Switch checked={st.scrobble} onChange={setScrobble} label="Scrobble what I watch" hint="Starting, pausing and finishing movies and episodes is sent to Trakt, and marking something watched adds it to your history." />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={disconnect} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon name="logout" size={16} />} Disconnect</button>
          </div>
        </>
      ) : code ? (
        <div className="device-code">
          <p>Go to <a href={code.verificationUrl} target="_blank" rel="noreferrer" className="link-strong">{code.verificationUrl.replace(/^https?:\/\//, '')} <Icon name="external" size={14} /></a> on any device and enter this code:</p>
          <div className="device-code-value" aria-live="polite">
            {code.userCode}
            <button className="btn-icon" onClick={() => { void navigator.clipboard?.writeText(code.userCode); toast.success('Code copied'); }} aria-label="Copy code"><Icon name="copy" size={18} /></button>
          </div>
          <p className="muted device-code-wait"><Spinner size={14} /> Waiting for you to approve MediaMax on Trakt…</p>
          <div className="form-actions"><button className="btn btn-ghost" onClick={() => setCode(null)}>Cancel</button></div>
        </div>
      ) : (
        <>
          {expired && <p className="form-error">That code expired before it was approved. Start again to get a new one.</p>}
          <div className="form-actions">
            <button className="btn btn-primary" onClick={connect} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon name="link" size={16} />} Connect Trakt</button>
          </div>
        </>
      )}
    </div>
  );
}

function LastfmCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const status = useAsync(() => api.lastfm.status(), []);
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState(false);
  const st = status.data;

  // After opening Last.fm's approval page, poll until the connection completes (gives up after 10 minutes).
  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let stopped = false;
    const t = window.setInterval(async () => {
      if (Date.now() - started > 10 * 60_000) {
        window.clearInterval(t);
        setWaiting(false);
        return;
      }
      try {
        const s = await api.lastfm.status();
        if (stopped) return;
        if (s.connected) {
          window.clearInterval(t);
          setWaiting(false);
          status.setData(s);
          toast.success(`Connected to Last.fm${s.username ? ` as ${s.username}` : ''}`);
        }
      } catch {
        /* keep polling */
      }
    }, 3000);
    return () => {
      stopped = true;
      window.clearInterval(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const connect = async () => {
    // Open the tab synchronously so pop-up blockers allow it, then point it at Last.fm.
    const tab = window.open('about:blank', '_blank');
    setBusy(true);
    try {
      const { authUrl } = await api.lastfm.connect();
      if (tab) tab.location.href = authUrl;
      else window.open(authUrl, '_blank', 'noopener');
      setWaiting(true);
    } catch (e) {
      tab?.close();
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const setScrobble = async (scrobble: boolean) => {
    if (!st) return;
    status.setData({ ...st, scrobble });
    try {
      status.setData(await api.lastfm.update({ scrobble }));
    } catch (e) {
      status.setData(st);
      toast.error(e);
    }
  };
  const disconnect = async () => {
    if (!(await confirm({ title: 'Disconnect Last.fm?', message: 'MediaMax will stop scrobbling your music to Last.fm.', confirmLabel: 'Disconnect', danger: true }))) return;
    setBusy(true);
    try {
      status.setData(await api.lastfm.disconnect());
      toast.success('Last.fm disconnected');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="settings-card service-card">
      <div className="service-head">
        <span className="service-logo lastfm-logo" aria-hidden="true">fm</span>
        <div className="service-title">
          <h2>Last.fm</h2>
          <p className="muted">Scrobble the music you play and build your listening profile.</p>
        </div>
        {st?.connected && <Badge tone="success"><Icon name="check" size={12} /> Connected</Badge>}
      </div>
      {status.loading && !st ? <Skeleton h={60} /> : status.error ? (
        <p className="form-error">{status.error} <button className="btn btn-ghost btn-sm" onClick={status.reload}>Retry</button></p>
      ) : !st ? null : !st.available ? (
        <div className="service-note"><Icon name="info" size={18} /> <span>Ask your server admin to set up Last.fm.</span></div>
      ) : st.connected ? (
        <>
          <p>Signed in as <strong>{st.username ?? 'your Last.fm account'}</strong>.</p>
          <Switch checked={st.scrobble} onChange={setScrobble} label="Scrobble music I play" hint="Tracks show as “now playing” and are scrobbled once you’ve listened to most of them." />
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={disconnect} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon name="logout" size={16} />} Disconnect</button>
          </div>
        </>
      ) : waiting ? (
        <div className="device-code">
          <p>Approve MediaMax in the Last.fm tab that just opened. This page updates by itself once you’re done.</p>
          <p className="muted device-code-wait" aria-live="polite"><Spinner size={14} /> Waiting for Last.fm…</p>
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => setWaiting(false)}>Cancel</button>
            <button className="btn" onClick={connect} disabled={busy}><Icon name="external" size={16} /> Open Last.fm again</button>
          </div>
        </div>
      ) : (
        <div className="form-actions">
          <button className="btn btn-primary" onClick={connect} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon name="link" size={16} />} Connect Last.fm</button>
        </div>
      )}
    </div>
  );
}

function Services() {
  return (
    <>
      <TraktCard />
      <LastfmCard />
      <Link to="/wrapped" className="settings-card wrapped-promo">
        <span className="wrapped-promo-icon"><Icon name="sparkles" size={22} /></span>
        <div>
          <h2>Your year in review</h2>
          <p className="muted">Hours watched, top shows, favourite genres and more.</p>
        </div>
        <Icon name="chevronRight" size={20} />
      </Link>
    </>
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
    { to: 'security', label: 'Security', icon: 'lock' },
    { to: 'appearance', label: 'Appearance', icon: 'palette' },
    { to: 'playback', label: 'Playback', icon: 'play' },
    { to: 'browsing', label: 'Browsing', icon: 'compass' },
    { to: 'devices', label: 'Devices', icon: 'device' },
    { to: 'services', label: 'Connected services', icon: 'globe' },
    { to: '/wrapped', label: 'Your year', icon: 'sparkles' },
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
            <Route path="browsing" element={<BrowsingSettings />} />
            <Route path="playback" element={<><Playback /><SubtitleSettings /><MusicSettings /></>} />
            <Route path="devices" element={<Devices />} />
            <Route path="services" element={<Services />} />
            <Route path="link" element={<LinkTab />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}
