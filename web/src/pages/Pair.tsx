import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import type { PairClaimResponse } from '@mediamax/shared';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';
import { useServerEvent } from '../hooks';
import { useApp } from '../state/app';
import { pairApi } from '../remote/api';
import '../remote/remote.css';

/**
 * Phone side of QR pairing. The TV's QR code opens `/pair?c=CODE&t=SECRET`; without them the user types the code.
 * Pairing waits for one tap (no drive-by pairing from a scanned code), and the TV's owner accepts other accounts.
 */
export default function PairPage() {
  const [sp] = useSearchParams();
  const navigate = useNavigate();
  const { user, branding } = useApp();
  // Keep the secret out of the address bar / history once read.
  const [secret] = useState(() => ({ code: sp.get('c') ?? '', token: sp.get('t') ?? '' }));
  useEffect(() => {
    if (secret.token) window.history.replaceState(window.history.state, '', '/pair');
  }, [secret.token]);
  const [code, setCode] = useState(secret.code);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<PairClaimResponse | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const claimed = useRef(false);

  const done = (deviceId: string) => navigate(`/remote/${encodeURIComponent(deviceId)}`, { replace: true });

  const submit = async (body: { code?: string; token?: string }) => {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await pairApi.claim(body);
      setClaim(r);
      setStatus(r.status);
      if (r.status === 'paired') done(r.targetDeviceId);
    } catch (e) {
      claimed.current = false;
      setError(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  };

  // Waiting for the TV's owner: socket event, with polling as a fallback.
  useServerEvent((ev) => {
    if (ev.type === 'pair.updated' && claim?.requestId && ev.requestId === claim.requestId) {
      setStatus(ev.status);
      if (ev.status === 'paired') done(claim.targetDeviceId);
    }
  });
  useEffect(() => {
    if (status !== 'pending' || !claim?.requestId) return;
    const t = window.setInterval(() => {
      pairApi.requestStatus(claim.requestId!).then((r) => {
        setStatus(r.status);
        if (r.status === 'paired') done(claim.targetDeviceId);
      }, () => undefined);
    }, 3000);
    return () => window.clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, claim?.requestId]);

  const deepLink = secret.token ? `kinora://pair?${new URLSearchParams({ c: secret.code, t: secret.token, s: location.origin }).toString()}` : null;

  return (
    <div className="phone-shell pair-page">
      <header className="phone-top">
        <Link to="/" className="btn-icon" aria-label="Home"><Icon name="arrowLeft" /></Link>
        <strong>Phone remote</strong>
        <span />
      </header>
      <main className="pair-main">
        <div className="pair-hero-icon"><Icon name="tv" size={40} /></div>
        {status === 'pending' && claim ? (
          <>
            <h1>Waiting for {claim.ownerName}</h1>
            <p className="muted">Accept the request on <strong>{claim.targetName}</strong>. This TV is signed in with another account, so you’ll get playback control and can browse what it’s allowed to show.</p>
            <Spinner size={36} />
          </>
        ) : status === 'declined' || status === 'expired' ? (
          <>
            <h1>{status === 'declined' ? 'Request declined' : 'Request expired'}</h1>
            <p className="muted">Show a new code on the TV (Use your phone as remote) and try again.</p>
            <button className="btn btn-primary" onClick={() => { setStatus(null); setClaim(null); setCode(''); }}>Enter a new code</button>
          </>
        ) : secret.token ? (
          <>
            <h1>Pair with this TV?</h1>
            <p className="muted">Signed in as <strong>{user?.displayName || user?.username}</strong> on {branding.serverName}. Your phone becomes a remote and a second screen for the TV that showed this code.</p>
            <button className="btn btn-primary btn-lg pair-cta" disabled={busy} onClick={() => void submit({ token: secret.token })}>
              {busy ? <Spinner size={18} /> : <Icon name="link" size={18} />} Pair in this browser
            </button>
            {deepLink && <a className="btn btn-ghost" href={deepLink}><Icon name="external" size={16} /> Open in the app instead</a>}
          </>
        ) : (
          <form className="pair-form" onSubmit={(e) => { e.preventDefault(); void submit({ code }); }}>
            <h1>Enter the code on your TV</h1>
            <p className="muted">On the TV, open your account menu (or the player’s Info panel) and choose “Use your phone as remote”.</p>
            <input
              className="input pair-code-input"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoComplete="one-time-code"
              autoFocus
              aria-label="Pairing code"
            />
            <button className="btn btn-primary btn-lg pair-cta" disabled={busy || code.length !== 6}>
              {busy ? <Spinner size={18} /> : <Icon name="link" size={18} />} Pair
            </button>
            <Link to="/remote" className="btn btn-ghost">Already paired? Open the remote</Link>
          </form>
        )}
        {error && <p className="pair-error" role="alert"><Icon name="alert" size={16} /> {error}</p>}
      </main>
    </div>
  );
}
