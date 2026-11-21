import { useState, type FormEvent } from 'react';
import type { AuthResponse } from '@mediamax/shared';
import { useApp } from '../state/app';
import { api } from '../api/endpoints';
import { errorMessage, setToken } from '../api/client';
import { Icon, type IconName } from '../components/Icon';
import { BrandMark } from '../components/BrandLogo';
import { LightField } from '../components/LightField';
import { Field, Spinner } from '../components/ui';
import { LibraryForm } from '../components/LibraryForm';
import { SourceForm } from '../components/SourceForm';

const STEPS: { label: string; icon: IconName }[] = [
  { label: 'Welcome', icon: 'sparkles' },
  { label: 'Admin account', icon: 'user' },
  { label: 'Library', icon: 'film' },
  { label: 'Live TV', icon: 'tv' },
  { label: 'Done', icon: 'check' },
];

export function SetupWizard() {
  const { system, login, refreshSystem, refreshBranding, refreshLibraries } = useApp();
  const [step, setStep] = useState(0);
  const [serverName, setServerName] = useState(system?.name && system.name !== 'MediaMax' ? system.name : 'MediaMax');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [auth, setAuth] = useState<AuthResponse | null>(null);
  const [added, setAdded] = useState<string[]>([]);

  const createAdmin = async (e: FormEvent) => {
    e.preventDefault();
    if (password.length < 8) return setError('Use at least 8 characters for the password.');
    if (password !== confirm) return setError('Passwords don’t match.');
    setBusy(true);
    setError(null);
    try {
      const res = await api.system.setup({ serverName: serverName.trim() || 'MediaMax', username: username.trim(), password });
      // Keep the wizard on screen: store the token now, sign in for real at the end.
      setToken(res.token);
      setAuth(res);
      setStep(2);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (auth) login(auth);
    await Promise.all([refreshSystem(), refreshBranding(), refreshLibraries()]);
  };

  return (
    <div className="setup">
      <LightField />
      <div className="setup-card glass">
        <ol className="setup-steps">
          {STEPS.map((s, i) => (
            <li key={s.label} className={i === step ? 'active' : i < step ? 'done' : ''}>
              <span className="step-dot">{i < step ? <Icon name="check" size={14} /> : <Icon name={s.icon} size={14} />}</span>
              <span className="step-label">{s.label}</span>
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="setup-body fade-in">
            <BrandMark size={60} />
            <h1>Welcome to MediaMax</h1>
            <p className="muted">Movies, shows, music, photos, live TV, IPTV and DVR — all on your own server, styled your way. Let's get you set up in under a minute.</p>
            <Field label="Server name" hint="Shown on every device and the login screen. You can change it any time in Branding.">
              <input className="input input-lg" value={serverName} onChange={(e) => setServerName(e.target.value)} autoFocus />
            </Field>
            <div className="form-actions">
              <button className="btn btn-primary btn-lg" onClick={() => setStep(1)} disabled={!serverName.trim()}>
                Get started <Icon name="chevronRight" size={18} />
              </button>
            </div>
          </div>
        )}

        {step === 1 && (
          <form className="setup-body fade-in" onSubmit={createAdmin}>
            <h1>Create your admin account</h1>
            <p className="muted">This account manages the server, users and branding.</p>
            <Field label="Username">
              <input className="input" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" required autoFocus />
            </Field>
            <div className="form-row">
              <Field label="Password">
                <input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required />
              </Field>
              <Field label="Confirm password">
                <input className="input" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
              </Field>
            </div>
            {error && <p className="form-error">{error}</p>}
            <div className="form-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setStep(0)}>Back</button>
              <button className="btn btn-primary btn-lg" disabled={busy}>{busy ? <Spinner size={18} /> : 'Create account'}</button>
            </div>
          </form>
        )}

        {step === 2 && (
          <div className="setup-body fade-in">
            <h1>Add your first library</h1>
            <p className="muted">Point MediaMax at a folder of movies, shows, music or photos. You can add more later.</p>
            {added.length > 0 && (
              <div className="added-list">
                {added.map((a) => (
                  <span key={a} className="badge badge-success"><Icon name="check" size={12} /> {a}</span>
                ))}
              </div>
            )}
            <LibraryForm key={added.length} onSaved={(l) => setAdded((a) => [...a, l.name])} submitLabel={added.length ? 'Add another' : 'Add library'} />
            <div className="form-actions setup-skip">
              <button className="btn btn-ghost" onClick={() => setStep(3)}>{added.length ? 'Continue' : 'Skip for now'} <Icon name="chevronRight" size={16} /></button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div className="setup-body fade-in">
            <h1>Live TV & IPTV</h1>
            <p className="muted">Connect an Xtream Codes account, an M3U playlist or an HDHomeRun tuner to get live channels, a full TV guide, catch-up and DVR.</p>
            <SourceForm compact onSaved={() => setStep(4)} />
            <div className="form-actions setup-skip">
              <button className="btn btn-ghost" onClick={() => setStep(4)}>Skip for now <Icon name="chevronRight" size={16} /></button>
            </div>
          </div>
        )}

        {step === 4 && (
          <div className="setup-body fade-in center">
            <div className="link-done-icon"><Icon name="checkCircle" size={64} /></div>
            <h1>You're all set</h1>
            <p className="muted">Libraries are scanning in the background. Head to <strong>Admin → Branding</strong> to make {serverName} truly yours — logos, colours, fonts, home rows and more.</p>
            <div className="form-actions" style={{ justifyContent: 'center' }}>
              <button className="btn btn-primary btn-lg" onClick={finish}>
                Enter {serverName} <Icon name="chevronRight" size={18} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
