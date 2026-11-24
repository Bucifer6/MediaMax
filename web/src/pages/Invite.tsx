import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api/endpoints';
import { errorMessage, mediaUrl } from '../api/client';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';
import { LightField } from '../components/LightField';

/** Public sign-up page for an invite link: /invite/:code. Works while signed out. */
export default function InvitePage() {
  const { code = '' } = useParams();
  const { branding, login, user } = useApp();
  const navigate = useNavigate();
  const preview = useAsync(() => api.invites.preview(code), [code]);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = !!username.trim() && password.length >= 8 && password === confirm && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await api.invites.accept(code, { username: username.trim(), password, displayName: displayName.trim() || undefined });
      login(auth);
      navigate('/', { replace: true });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const bg = branding.loginBackgroundUrl;
  const p = preview.data;
  const serverName = p?.serverName || branding.serverName;
  return (
    <div className="login vibe-auth">
      <LightField image={bg ? mediaUrl(bg, 1920) : null} />
      <div className="login-inner">
        <div className="login-brand">
          <BrandLogo height={52} wide={!branding.logoUrl || !!branding.logoWideUrl} />
          {branding.tagline && <p className="login-tagline">{branding.tagline}</p>}
        </div>
        {preview.loading && !p ? (
          <Spinner size={36} />
        ) : preview.error || !p ? (
          <div className="login-card glass fade-in">
            <span className="totp-icon"><Icon name="alert" size={30} /></span>
            <h2>Can’t open this invite</h2>
            <p className="muted">{preview.error ?? 'Something went wrong.'}</p>
            <button className="btn btn-primary btn-block" onClick={preview.reload}><Icon name="refresh" size={16} /> Try again</button>
          </div>
        ) : !p.valid ? (
          <div className="login-card glass fade-in">
            <span className="totp-icon"><Icon name="alert" size={30} /></span>
            <h2>Invite unavailable</h2>
            <p className="muted">{p.message ?? 'This invite link is not valid.'}</p>
            <p className="muted">Ask whoever sent it for a new link.</p>
            <Link className="btn btn-glass btn-block" to="/login">Go to sign in</Link>
          </div>
        ) : (
          <form className="login-card glass fade-in" onSubmit={submit}>
            <span className="totp-icon"><Icon name="sparkles" size={30} /></span>
            <h2>You’re invited to {serverName}</h2>
            <p className="muted">Create your account to start watching and listening.</p>
            {user && <p className="login-message">You’re signed in as {user.displayName || user.username}. Creating an account here signs you in as the new user on this device.</p>}
            <label className="field">
              <span className="field-label">Display name</span>
              <input className="input" value={displayName} onChange={(e) => setDisplayName(e.target.value)} autoComplete="name" placeholder="Optional" autoFocus />
            </label>
            <label className="field">
              <span className="field-label">Username</span>
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" spellCheck={false} required />
            </label>
            <label className="field">
              <span className="field-label">Password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required aria-invalid={tooShort} />
              <small className={`field-hint ${tooShort ? 'error' : ''}`}>At least 8 characters.</small>
            </label>
            <label className="field">
              <span className="field-label">Confirm password</span>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required aria-invalid={mismatch} />
              {mismatch && <small className="field-hint error">Passwords don’t match.</small>}
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={!canSubmit}>
              {busy ? <Spinner size={18} /> : 'Create account'}
            </button>
            <p className="muted invite-signin">Already have an account? <Link to="/login" className="link-strong">Sign in</Link></p>
          </form>
        )}
      </div>
      {branding.footerText && <footer className="login-footer">{branding.footerText}</footer>}
    </div>
  );
}
