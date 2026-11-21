import { useEffect, useRef, useState, type FormEvent } from 'react';
import type React from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import type { AuthResponse, PublicProfile } from '@mediamax/shared';
import { useApp } from '../state/app';
import { api } from '../api/endpoints';
import { API_BASE, ApiRequestError, errorMessage, setToken } from '../api/client';
import { getDeviceId, getDeviceName, PLATFORM } from '../api/device';
import { Avatar, Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { LightField } from '../components/LightField';
import { isCalm } from '../theme/fx';
import { mediaUrl } from '../api/client';
import { safeNext } from '../utils/safeNext';

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

/** Second sign-in step for accounts with two-factor authentication. */
export function TotpStep({ onSubmit, onBack, initialError }: { onSubmit: (code: string) => Promise<void>; onBack: () => void; initialError?: string | null }) {
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ready = recovery ? code.trim().length >= 6 : code.length === 6;
  const submit = async (value = code) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(value.trim());
    } catch (e) {
      setError(e instanceof ApiRequestError && e.code === 'totp_invalid' ? (recovery ? 'That recovery code is not valid.' : 'That code is not valid. Check the time on your phone and try again.') : errorMessage(e));
      setCode('');
      window.setTimeout(() => input.current?.focus(), 0);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="login-card glass fade-in" onSubmit={(e) => { e.preventDefault(); if (ready) void submit(); }}>
      <button type="button" className="btn-icon login-back" onClick={onBack} aria-label="Back">
        <Icon name="arrowLeft" />
      </button>
      <span className="totp-icon"><Icon name="shield" size={30} /></span>
      <h2>Two-factor authentication</h2>
      <p className="muted">{recovery ? 'Enter one of the recovery codes you saved when you turned on two-factor.' : 'Enter the 6-digit code from your authenticator app.'}</p>
      <label className="field">
        <span className="field-label">{recovery ? 'Recovery code' : 'Authentication code'}</span>
        {recovery ? (
          <input key="rec" ref={input} className="input code-input" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="xxxxx-xxxxx" autoFocus />
        ) : (
          <input
            key="otp"
            ref={input}
            className="input code-input totp-input"
            value={code}
            onChange={(e) => {
              const v = e.target.value.replace(/\D/g, '').slice(0, 6);
              setCode(v);
              if (v.length === 6) void submit(v);
            }}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            maxLength={6}
            placeholder="123456"
            aria-invalid={!!error}
            autoFocus
          />
        )}
      </label>
      {error && <p className="form-error" role="alert">{error}</p>}
      <button className="btn btn-primary btn-lg btn-block" disabled={busy || !ready}>
        {busy ? <Spinner size={18} /> : 'Verify'}
      </button>
      <button type="button" className="btn btn-ghost btn-sm" onClick={() => { setRecovery((r) => !r); setCode(''); setError(null); }}>
        {recovery ? 'Use an authenticator code' : 'Use a recovery code'}
      </button>
    </form>
  );
}

const isTotpRequired = (e: unknown) => e instanceof ApiRequestError && e.status === 401 && e.code === 'totp_required';

type Mode = 'profiles' | 'pin' | 'password';

/** Where the browser goes to start single sign-on. */
function oidcStartUrl(): string {
  const q = new URLSearchParams({
    redirect: `${location.origin}/login`,
    deviceId: getDeviceId(),
    deviceName: getDeviceName(),
    platform: PLATFORM,
  });
  return `${API_BASE}/auth/oidc/start?${q.toString()}`;
}

function SsoButton({ label }: { label: string }) {
  return (
    <a className="btn btn-glass btn-lg btn-block sso-btn" href={oidcStartUrl()}>
      <Icon name="key" size={18} /> {label || 'Sign in with SSO'}
    </a>
  );
}

export function Login() {
  const { user, branding, features, login, system } = useApp();
  const navigate = useNavigate();
  const oidc = system?.oidc?.enabled ? system.oidc : null;
  const [params] = useSearchParams();
  const next = safeNext(params.get('next'));
  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [mode, setMode] = useState<Mode>('password');
  const [selected, setSelected] = useState<PublicProfile | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ssoPending, setSsoPending] = useState(() => /[#&]token=/.test(location.hash));
  /** Set when the server asks for a second factor: resends the same sign-in with the code. */
  const [totp, setTotp] = useState<{ retry: (code: string) => Promise<AuthResponse> } | null>(null);

  // Single sign-on returns here with #token=… or #error=… in the fragment.
  useEffect(() => {
    if (!location.hash) return;
    const h = new URLSearchParams(location.hash.slice(1));
    const token = h.get('token');
    const err = h.get('error');
    if (!token && !err) return;
    history.replaceState(history.state, '', location.pathname + location.search);
    if (err) {
      setError(err);
      setMode('password');
      return;
    }
    if (token) {
      setToken(token);
      api.auth
        .me()
        .then((me) => {
          login({ token, user: me });
          navigate(me.profileCount ? '/profiles' : '/', { replace: true });
        })
        .catch((e) => {
          setToken(null);
          setError(`Single sign-on failed: ${errorMessage(e)}`);
          setMode('password');
        })
        .finally(() => setSsoPending(false));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!features.profilePicker) {
      setProfiles([]);
      return;
    }
    api.auth
      .profiles()
      .then((p) => {
        setProfiles(p);
        if (p.length && !/[#&](token|error)=/.test(location.hash)) setMode((m) => (m === 'password' && error ? m : 'profiles'));
      })
      .catch(() => setProfiles([]));
  }, [features.profilePicker]);

  // Accounts with profiles continue to "Who's watching?".
  if (user) return <Navigate to={user.profileCount ? `/profiles?next=${encodeURIComponent(next)}` : next} replace />;

  const pickProfile = async (p: PublicProfile) => {
    // The chosen tile steps forward while the others fall away, then the sign-in continues.
    if (chosen) return;
    setChosen(p.id);
    if (!isCalm()) await new Promise((r) => window.setTimeout(r, 360));
    setChosen(null);
    setSelected(p);
    setError(null);
    if (p.requiresPassword) {
      setUsername(p.username || p.displayName);
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
      if (isTotpRequired(e)) setTotp({ retry: (code) => api.auth.profileLogin(p.id, undefined, code) });
      else setError(errorMessage(e));
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
      const id = selected.id;
      if (isTotpRequired(e)) setTotp({ retry: (code) => api.auth.profileLogin(id, pin, code) });
      else setError(errorMessage(e) || 'Incorrect PIN');
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const u = username.trim();
      login(await api.auth.login(u, password));
    } catch (err) {
      const u = username.trim();
      const pw = password;
      if (isTotpRequired(err)) setTotp({ retry: (code) => api.auth.login(u, pw, code) });
      else setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bg = branding.loginBackgroundUrl;
  return (
    <div className="login">
      <LightField image={bg ? mediaUrl(bg, 1920) : null} />
      <div className="login-inner">
        <div className="login-brand">
          <BrandLogo height={52} wide={!branding.logoUrl || !!branding.logoWideUrl} />
          {branding.tagline && <p className="login-tagline">{branding.tagline}</p>}
        </div>

        {profiles === null || ssoPending ? (
          <Spinner size={36} />
        ) : totp ? (
          <TotpStep onSubmit={async (code) => login(await totp.retry(code))} onBack={() => { setTotp(null); setPassword(''); }} />
        ) : mode === 'profiles' ? (
          <div className="profiles fade-in">
            <h1>Who's watching?</h1>
            <div className={`profile-grid ${chosen ? 'choosing' : ''}`}>
              {profiles.map((p, i) => (
                <button key={p.id} className={`profile ${chosen === p.id ? 'chosen' : ''}`} style={{ '--i': i } as React.CSSProperties} onClick={() => pickProfile(p)} disabled={busy} aria-disabled={!!chosen || undefined}>
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
            <div className="row-gap profile-alt">
              <button className="btn btn-ghost" onClick={() => { setSelected(null); setUsername(''); setMode('password'); }}>
                <Icon name="user" size={16} /> Sign in with a username
              </button>
              {oidc && <a className="btn btn-ghost" href={oidcStartUrl()}><Icon name="key" size={16} /> {oidc.buttonLabel || 'Sign in with SSO'}</a>}
            </div>
          </div>
        ) : mode === 'pin' && selected ? (
          <div className="login-card glass fade-in">
            <button className="btn-icon login-back" onClick={() => setMode('profiles')} aria-label="Back">
              <Icon name="arrowLeft" />
            </button>
            <Avatar name={selected.displayName} url={selected.avatarUrl} size={84} />
            <h2>{selected.displayName}</h2>
            <p className="muted">Enter your PIN</p>
            <PinPad length={selected.pinLength ?? 4} onComplete={submitPin} error={error} busy={busy} />
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
            {oidc && !selected && (
              <>
                <div className="login-or"><span>or</span></div>
                <SsoButton label={oidc.buttonLabel} />
              </>
            )}
          </form>
        )}
        {mode !== 'profiles' && !selected && branding.loginMessage && mode !== 'password' && <p className="login-message">{branding.loginMessage}</p>}
      </div>
      {branding.footerText && <footer className="login-footer">{branding.footerText}</footer>}
    </div>
  );
}
