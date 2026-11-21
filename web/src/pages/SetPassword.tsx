import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { passwordLinkApi } from '../api/embyImport';
import { errorMessage, mediaUrl } from '../api/client';
import { useApp } from '../state/app';
import { useAsync } from '../hooks';
import { Spinner } from '../components/ui';
import { Icon } from '../components/Icon';
import { BrandLogo } from '../components/BrandLogo';

/** Public page for a one-time set-password link: /set-password/:token (accounts moved over from Emby). Works while signed out. */
export default function SetPasswordPage() {
  const { token = '' } = useParams();
  const { branding, login } = useApp();
  const navigate = useNavigate();
  const preview = useAsync(() => passwordLinkApi.preview(token), [token]);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 8 && password === confirm && !busy;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      login(await passwordLinkApi.use(token, password));
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
        {preview.loading && !p ? (
          <Spinner size={36} />
        ) : preview.error || !p ? (
          <div className="login-card glass fade-in">
            <span className="totp-icon"><Icon name="alert" size={30} /></span>
            <h2>Can’t open this link</h2>
            <p className="muted">{preview.error ?? 'Something went wrong.'}</p>
            <button className="btn btn-primary btn-block" onClick={preview.reload}><Icon name="refresh" size={16} /> Try again</button>
          </div>
        ) : !p.valid ? (
          <div className="login-card glass fade-in">
            <span className="totp-icon"><Icon name="alert" size={30} /></span>
            <h2>Link unavailable</h2>
            <p className="muted">{p.message ?? 'This link is not valid.'}</p>
            <p className="muted">Ask your server administrator for a new link.</p>
            <Link className="btn btn-glass btn-block" to="/login">Go to sign in</Link>
          </div>
        ) : (
          <form className="login-card glass fade-in" onSubmit={submit}>
            <span className="totp-icon"><Icon name="key" size={30} /></span>
            <h2>Welcome to {serverName}</h2>
            <p className="muted">Your account <strong>{p.username}</strong> is ready. Choose a password to finish setting it up.</p>
            <input type="text" name="username" value={p.username ?? ''} autoComplete="username" readOnly hidden />
            <label className="field">
              <span className="field-label">New password</span>
              <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={8} required aria-invalid={tooShort} autoFocus />
              <small className={`field-hint ${tooShort ? 'error' : ''}`}>At least 8 characters.</small>
            </label>
            <label className="field">
              <span className="field-label">Confirm password</span>
              <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required aria-invalid={mismatch} />
              {mismatch && <small className="field-hint error">Passwords don’t match.</small>}
            </label>
            {error && <p className="form-error" role="alert">{error}</p>}
            <button className="btn btn-primary btn-lg btn-block" disabled={!canSubmit}>
              {busy ? <Spinner size={18} /> : 'Set password and sign in'}
            </button>
          </form>
        )}
      </div>
      {branding.footerText && <footer className="login-footer">{branding.footerText}</footer>}
    </div>
  );
}
