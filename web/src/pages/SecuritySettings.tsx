import { useState, type FormEvent } from 'react';
import type { ApiKey, CreatedApiKey, TotpSetup } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { ApiRequestError, errorMessage } from '../api/client';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, Field, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { QrCode } from '../components/QrCode';
import { relativeTime } from '../utils/format';

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure origins (plain http on the LAN).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CopyButton({ text, label = 'Copy', what = 'Copied', className = 'btn btn-sm' }: { text: string; label?: string; what?: string; className?: string }) {
  const toast = useToast();
  return (
    <button type="button" className={className} onClick={async () => (await copyText(text)) ? toast.success(what) : toast.show('Copy failed — select the text and copy it manually', 'error')}>
      <Icon name="copy" size={14} /> {label}
    </button>
  );
}

/** Groups a base32 secret in fours for easier typing. */
const groupSecret = (s: string) => s.replace(/(.{4})/g, '$1 ').trim();

/* ---------------- Two-factor ---------------- */
export function TwoFactorCard() {
  const { user, setUser, branding } = useApp();
  const toast = useToast();
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!user) return null;

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setSetup(await api.auth.totpSetup());
      setCode('');
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  const enable = async (e: FormEvent) => {
    e.preventDefault();
    if (code.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.totpEnable(code);
      setCodes(r.recoveryCodes);
      setSetup(null);
      setCode('');
      setUser({ ...user, totpEnabled: true });
    } catch (err) {
      setError(errorMessage(err));
      setCode('');
    } finally {
      setBusy(false);
    }
  };
  const disable = async (e: FormEvent) => {
    e.preventDefault();
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setUser(await api.auth.totpDisable(code.trim()));
      setDisabling(false);
      setCode('');
      toast.success('Two-factor authentication turned off');
    } catch (err) {
      setError(err instanceof ApiRequestError && /totp_invalid|bad_request/.test(err.code) ? err.message || 'That code is not valid.' : errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const codesText = codes ? `${branding.serverName || 'Vibe'} recovery codes for ${user.username}\nEach code works once.\n\n${codes.join('\n')}\n` : '';

  return (
    <div className="settings-card">
      <div className="card-head-row">
        <h2>Two-factor authentication</h2>
        {user.totpEnabled ? <Badge tone="success"><Icon name="check" size={12} /> On</Badge> : <Badge tone="muted">Off</Badge>}
      </div>
      <p className="muted">Ask for a code from an authenticator app (1Password, Google Authenticator, Authy, Aegis…) whenever you sign in with your password.</p>

      {codes ? (
        <div className="recovery-box" role="region" aria-label="Recovery codes">
          <p><strong>Save your recovery codes.</strong> If you lose your phone, each of these lets you sign in once. They won’t be shown again.</p>
          <ol className="recovery-codes">
            {codes.map((c) => <li key={c}><code>{c}</code></li>)}
          </ol>
          <div className="form-actions">
            <CopyButton text={codes.join('\n')} what="Recovery codes copied" />
            <button type="button" className="btn btn-sm" onClick={() => downloadText('vibe-recovery-codes.txt', codesText)}><Icon name="download" size={14} /> Download .txt</button>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => setCodes(null)}>I’ve saved them</button>
          </div>
        </div>
      ) : setup ? (
        <form className="totp-setup" onSubmit={enable}>
          <div className="totp-qr">
            <QrCode value={setup.otpauthUrl} size={188} label="Scan with your authenticator app" />
          </div>
          <div className="totp-steps">
            <ol>
              <li>Scan the QR code with your authenticator app.</li>
              <li>
                Can’t scan it? Enter this key manually:
                <div className="secret-row">
                  <code className="secret-code">{groupSecret(setup.secret)}</code>
                  <CopyButton text={setup.secret} what="Key copied" className="btn-icon" label="" />
                </div>
              </li>
              <li>Enter the 6-digit code the app shows.</li>
            </ol>
            <Field label="Code from the app">
              <input
                className="input code-input small"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                inputMode="numeric"
                pattern="[0-9]*"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                aria-invalid={!!error}
                autoFocus
              />
            </Field>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setSetup(null); setError(null); }}>Cancel</button>
              <button className="btn btn-primary" disabled={busy || code.length !== 6}>{busy ? <Spinner size={16} /> : 'Turn on'}</button>
            </div>
          </div>
        </form>
      ) : user.totpEnabled ? (
        disabling ? (
          <form onSubmit={disable} className="form-grid">
            <Field label="Authenticator or recovery code" hint="Confirm it’s you before turning two-factor off.">
              <input className="input code-input small" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" spellCheck={false} placeholder="123456" aria-invalid={!!error} autoFocus />
            </Field>
            {error && <p className="form-error" role="alert">{error}</p>}
            <div className="form-actions">
              <button type="button" className="btn btn-ghost" onClick={() => { setDisabling(false); setError(null); setCode(''); }}>Cancel</button>
              <button className="btn btn-danger" disabled={busy || !code.trim()}>{busy ? <Spinner size={16} /> : 'Turn off two-factor'}</button>
            </div>
          </form>
        ) : (
          <div className="form-actions">
            <button className="btn btn-ghost" onClick={() => { setDisabling(true); setCode(''); setError(null); }}>Turn off…</button>
          </div>
        )
      ) : (
        <div className="form-actions">
          <button className="btn btn-primary" onClick={start} disabled={busy}>{busy ? <Spinner size={16} /> : <Icon name="shield" size={16} />} Set up two-factor</button>
        </div>
      )}
    </div>
  );
}

/* ---------------- API keys ---------------- */
export function ApiKeysCard() {
  const toast = useToast();
  const confirm = useConfirm();
  const keys = useAsync(() => api.auth.apiKeys(), []);
  const [name, setName] = useState('');
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [busy, setBusy] = useState(false);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const k = await api.auth.createApiKey(name.trim());
      setCreated(k);
      setName('');
      const { key: _secret, ...meta } = k;
      void _secret;
      keys.setData((l) => [meta as ApiKey, ...(l ?? [])]);
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (k: ApiKey) => {
    if (!(await confirm({ title: `Delete “${k.name}”?`, message: 'Anything using this key stops working straight away.', confirmLabel: 'Delete key', danger: true }))) return;
    try {
      await api.auth.deleteApiKey(k.id);
      keys.setData((l) => (l ?? []).filter((x) => x.id !== k.id));
      if (created?.id === k.id) setCreated(null);
    } catch (err) {
      toast.error(err);
    }
  };

  return (
    <div className="settings-card">
      <h2>API keys</h2>
      <p className="muted">For Home Assistant, scripts and music apps. A key acts as you: send it as <code>X-Api-Key</code> (or <code>?api_key=</code>).</p>
      {created && (
        <div className="key-reveal" role="status">
          <p><Icon name="alert" size={16} /> <strong>Copy this key now.</strong> For your security it won’t be shown again.</p>
          <div className="secret-row">
            <code className="secret-code mono">{created.key}</code>
            <CopyButton text={created.key} what="API key copied" />
          </div>
          <button className="btn btn-ghost btn-sm" onClick={() => setCreated(null)}>Done</button>
        </div>
      )}
      <form className="inline-form" onSubmit={create}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Key name, e.g. Home Assistant" aria-label="Key name" maxLength={80} />
        <button className="btn btn-primary" disabled={busy || !name.trim()}>{busy ? <Spinner size={16} /> : <Icon name="plus" size={16} />} Create key</button>
      </form>
      {keys.loading && !keys.data ? <Skeleton h={80} /> : keys.error ? (
        <p className="form-error">{keys.error} <button className="btn btn-ghost btn-sm" onClick={keys.reload}>Retry</button></p>
      ) : !keys.data?.length ? <p className="muted">No API keys yet.</p> : (
        <ul className="device-list">
          {keys.data.map((k) => (
            <li key={k.id}>
              <Icon name="key" size={22} />
              <div>
                <strong>{k.name}</strong> <code className="muted">{k.prefix}…</code>
                <div className="muted">Created {relativeTime(k.createdAt)} · {k.lastUsedAt ? `last used ${relativeTime(k.lastUsedAt)}` : 'never used'}</div>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={() => remove(k)} aria-label={`Delete ${k.name}`}><Icon name="trash" size={14} /> Delete</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ---------------- Subsonic ---------------- */
export function SubsonicCard() {
  const { user, system } = useApp();
  if (!user) return null;
  const base = (system?.publicUrl || window.location.origin).replace(/\/+$/, '');
  return (
    <div className="settings-card">
      <h2>Use Vibe with Subsonic music apps</h2>
      <p className="muted">Apps such as Symfonium, DSub, Substreamer, Feishin and play:Sub can play your music library over the Subsonic / OpenSubsonic API.</p>
      <dl className="kv-list">
        <dt>Server address</dt>
        <dd><code>{base}</code> <CopyButton text={base} label="" className="btn-icon" what="Address copied" /></dd>
        <dt>API path</dt>
        <dd><code>{base}/rest</code> <span className="muted">(most apps add <code>/rest</code> themselves)</span></dd>
        <dt>Username</dt>
        <dd><code>{user.username}</code></dd>
        <dt>Password</dt>
        <dd>{user.totpEnabled ? <span>Your account uses two-factor, so create an <strong>API key</strong> above and use it in apps that support OpenSubsonic API keys.</span> : <span>Your Vibe password, or an API key in apps that support OpenSubsonic API keys.</span>}</dd>
      </dl>
      <p className="muted small">If the app offers “legacy” or plain-password authentication, turn it on: salted-token sign-in isn’t supported.</p>
    </div>
  );
}
