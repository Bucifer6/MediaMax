import { useState, type FormEvent } from 'react';
import { api } from '../api/endpoints';
import { errorMessage } from '../api/client';
import { Icon } from '../components/Icon';
import { Spinner } from '../components/ui';

export function LinkDeviceForm() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await api.auth.approveLink(code.trim().toUpperCase());
      setDone(r.deviceName || 'Your device');
      setCode('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="link-done fade-in">
        <div className="link-done-icon">
          <Icon name="checkCircle" size={56} />
        </div>
        <h2>{done} is linked</h2>
        <p className="muted">It will sign in automatically in a few seconds.</p>
        <button className="btn" onClick={() => setDone(null)}>Link another device</button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="link-form">
      <p className="muted">Open Kinora on your TV, phone or streaming box and choose <strong>Link with code</strong>. Type the code it shows below.</p>
      <input
        className="input code-input"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
        placeholder="K7PQ"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        aria-label="Link code"
      />
      {error && <p className="form-error">{error}</p>}
      <button className="btn btn-primary btn-lg" disabled={busy || code.length < 4}>
        {busy ? <Spinner size={18} /> : <><Icon name="link" size={18} /> Link device</>}
      </button>
    </form>
  );
}

export function LinkDevicePage() {
  return (
    <div className="page page-narrow">
      <div className="link-page glass">
        <div className="link-hero">
          <Icon name="monitor" size={40} />
          <Icon name="link" size={22} />
          <Icon name="device" size={34} />
        </div>
        <h1>Link a device</h1>
        <LinkDeviceForm />
      </div>
    </div>
  );
}
