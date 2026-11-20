import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useSearchParams } from 'react-router-dom';
import type { PublicProfile } from '@mediamax/shared';
import { useApp } from '../state/app';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Avatar, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { mediaUrl } from '../api/client';

export function PinPad({ length = 4, onComplete, error, busy }: { length?: number; onComplete: (pin: string) => void; error?: string | null; busy?: boolean }) {
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (error) setPin('');
  }, [error]);
  useEffect(() => {
    if (pin.length === length) onComplete(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < length ? p + e.key : p));
      else if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [length]);
  const press = (d: string) => setPin((p) => (p.length < length ? p + d : p));
  return (
    <div className={`pinpad ${error ? 'shake' : ''}`}>
      <div className="pin-dots">
        {Array.from({ length }).map((_, i) => (
          <span key={i} className={`pin-dot ${i < pin.length ? 'filled' : ''}`} />
        ))}
      </div>
      <div className="pin-error">{busy ? <Spinner size={18} /> : error}</div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} className="pin-key" onClick={() => press(d)} disabled={busy}>
            {d}
          </button>
        ))}
        <span />
        <button className="pin-key" onClick={() => press('0')} disabled={busy}>0</button>
        <button className="pin-key pin-del" onClick={() => setPin((p) => p.slice(0, -1))} aria-label="Delete" disabled={busy}>
          <Icon name="arrowLeft" />
        </button>
      </div>
    </div>
  );
}

type Mode = 'profiles' | 'pin' | 'password';

export function Login() {
  const { user, branding, features, login } = useApp();
  const [params] = useSearchParams();
  const next = params.get('next') || '/';
  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [mode, setMode] = useState<Mode>('password');
  const [selected, setSelected] = useState<PublicProfile | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!features.profilePicker) {
      setProfiles([]);
      return;
    }
    api.auth
      .profiles()
      .then((p) => {
        setProfiles(p);
        if (p.length) setMode('profiles');
      })
      .catch(() => setProfiles([]));
  }, [features.profilePicker]);

  if (user) return <Navigate to={next} replace />;

  const pickProfile = async (p: PublicProfile) => {
    setSelected(p);
    setError(null);
    if (p.requiresPassword) {
      setUsername(p.displayName);
      setPassword('');
      setMode('password');
      return;
    }
    if (p.hasPin) {
      setMode('pin');
      return;
    }
    setBusy(true);
    try {
      login(await api.auth.profileLogin(p.id));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const submitPin = async (pin: string) => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      login(await api.auth.profileLogin(selected.id, pin));
    } catch (e) {
      setError(errorMessage(e) || 'Incorrect PIN');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      login(await api.auth.login(username.trim(), password));
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bg = branding.loginBackgroundUrl;
  return (
    <div className="login">
      <div className="login-bg" style={bg ? { backgroundImage: `url("${mediaUrl(bg, 1920)}")` } : undefined}>
        {!bg && <div className="login-aurora" />}
      </div>
      <div className="login-shade" />
      <div className="login-inner">
        <div className="login-brand">
          <BrandLogo height={52} wide={!branding.logoUrl || !!branding.logoWideUrl} />
          {branding.tagline && <p className="login-tagline">{branding.tagline}</p>}
        </div>

        {profiles === null ? (
          <Spinner size={36} />
        ) : mode === 'profiles' ? (
          <div className="profiles fade-in">
            <h1>Who's watching?</h1>
            <div className="profile-grid">
              {profiles.map((p) => (
                <button key={p.id} className="profile" onClick={() => pickProfile(p)} disabled={busy}>
                  <Avatar name={p.displayName} url={p.avatarUrl} size={112} />
                  <span className="profile-name">{p.displayName}</span>
                  {(p.hasPin || p.requiresPassword) && (
                    <span className="profile-lock">
                      <Icon name="lock" size={12} />
                    </span>
                  )}
                </button>
              ))}
            </div>
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-ghost" onClick={() => { setSelected(null); setUsername(''); setMode('password'); }}>
              <Icon name="user" size={16} /> Sign in with a username
            </button>
          </div>
        ) : mode === 'pin' && selected ? (
          <div className="login-card glass fade-in">
            <button className="btn-icon login-back" onClick={() => setMode('profiles')} aria-label="Back">
              <Icon name="arrowLeft" />
            </button>
            <Avatar name={selected.displayName} url={selected.avatarUrl} size={84} />
            <h2>{selected.displayName}</h2>
            <p className="muted">Enter your PIN</p>
            <PinPad onComplete={submitPin} error={error} busy={busy} />
          </div>
        ) : (
          <form className="login-card glass fade-in" onSubmit={submitPassword}>
            {profiles.length > 0 && (
              <button type="button" className="btn-icon login-back" onClick={() => setMode('profiles')} aria-label="Back to profiles">
                <Icon name="arrowLeft" />
              </button>
            )}
            {selected ? <Avatar name={selected.displayName} url={selected.avatarUrl} size={72} /> : null}
            <h2>{selected ? `Welcome back, ${selected.displayName}` : 'Sign in'}</h2>
            {branding.loginMessage && <p className="login-message">{branding.loginMessage}</p>}
            <label className="field">
              <span className="field-label">Username</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus={!selected} required />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus={!!selected} />
            </label>
            {error && <p className="form-error">{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username}>
              {busy ? <Spinner size={18} /> : 'Sign in'}
            </button>
          </form>
        )}
        {mode !== 'profiles' && !selected && branding.loginMessage && mode !== 'password' && <p className="login-message">{branding.loginMessage}</p>}
      </div>
      {branding.footerText && <footer className="login-footer">{branding.footerText}</footer>}
    </div>
  );
}
