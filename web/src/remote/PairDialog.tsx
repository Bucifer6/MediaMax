import { useCallback, useEffect, useState } from 'react';
import type { Pairing, PairStartResponse } from '@mediamax/shared';
import { Modal, Spinner } from '../components/ui';
import { QrCode } from '../components/QrCode';
import { Icon } from '../components/Icon';
import { useServerEvent } from '../hooks';
import { useToast } from '../state/toast';
import { pairApi } from './api';
import './remote.css';

const fmtCode = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

/** TV side: QR code + short code to pair a phone as a remote, and the phones paired with this TV. */
export function PairDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const [start, setStart] = useState<PairStartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [left, setLeft] = useState(0);
  const [pairings, setPairings] = useState<Pairing[]>([]);

  const fresh = useCallback(async () => {
    setError(null);
    try {
      setStart(await pairApi.start());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a pairing code');
    }
  }, []);
  const loadPairings = useCallback(() => {
    pairApi.pairings().then((p) => setPairings(p.filter((x) => x.role === 'tv')), () => undefined);
  }, []);

  useEffect(() => {
    if (!open) {
      setStart(null);
      return;
    }
    void fresh();
    loadPairings();
  }, [open, fresh, loadPairings]);

  // Countdown; a new code when it runs out.
  useEffect(() => {
    if (!open || !start) return;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(start.expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) void fresh();
    };
    tick();
    const t = window.setInterval(tick, 1000);
    return () => window.clearInterval(t);
  }, [open, start, fresh]);

  useServerEvent((ev) => {
    if (!open || ev.type !== 'pair.updated') return;
    if (ev.status === 'paired') {
      toast.success('Phone paired — it can now control this TV');
      // The code was used up: show a new one for the next phone.
      void fresh();
    }
    loadPairings();
  });

  const url = start ? `${location.origin}${start.path}` : '';
  return (
    <Modal open={open} onClose={onClose} title="Use your phone as remote" size="lg" className="pair-dialog">
      <div className="pair-layout">
        <div className="pair-qr">
          {start ? <QrCode value={url} size={260} label="Pairing QR code" /> : error ? <Icon name="alert" size={48} /> : <Spinner size={48} />}
        </div>
        <div className="pair-steps">
          <ol>
            <li>Point your phone’s camera at the code.</li>
            <li>Open the link and sign in (any account on this server).</li>
            <li>Your phone becomes a touch-pad remote and a second screen.</li>
          </ol>
          <p className="muted">Or open <strong>{location.host}/pair</strong> on your phone and type:</p>
          <div className="pair-code" aria-live="polite">{start ? fmtCode(start.code) : '••• •••'}</div>
          {start && <p className="muted pair-expiry">New code in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</p>}
          {error && <p className="pair-error" role="alert">{error}</p>}
          <p className="muted small">Someone signed in with a different account needs your OK on this screen, and can only control playback and browse what you’re allowed to watch.</p>
        </div>
      </div>
      {pairings.length > 0 && (
        <section className="pair-list" aria-label="Paired phones">
          <h3>Paired phones</h3>
          <ul>
            {pairings.map((p) => (
              <li key={p.id}>
                <Icon name="device" size={18} />
                <span className="pair-list-name">
                  <strong>{p.controllerDeviceName}</strong>
                  <small className="muted">{p.crossUser ? `${p.otherUserName} · guest` : 'Your account'}{p.online ? ' · connected' : ''}</small>
                </span>
                <button className="btn btn-ghost btn-sm" onClick={() => void pairApi.revoke(p.id).then(loadPairings, (e) => toast.error(e))}>
                  <Icon name="x" size={14} /> Unpair
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </Modal>
  );
}
