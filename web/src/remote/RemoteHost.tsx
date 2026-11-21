import { lazy, Suspense, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { PairRequest } from '@mediamax/shared';
import { Modal } from '../components/ui';
import { Icon } from '../components/Icon';
import { useServerEvent } from '../hooks';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { handleRemoteKey } from '../tv/spatial';
import { pairApi } from './api';

const PairDialog = lazy(() => import('./PairDialog').then((m) => ({ default: m.PairDialog })));

/**
 * App-wide part of the phone remote (TV side), mounted once:
 *  - feeds `remote.key` from a paired phone into spatial navigation,
 *  - opens "Play on…" requests (`playItem` / `playChannel`) from your devices or a paired phone,
 *  - shows another user's pairing request for this TV (accept / decline),
 *  - hosts the "Use your phone as remote" dialog (opened with `openPairDialog()`).
 */
export function RemoteHost() {
  const { user, wsOpen } = useApp();
  const navigate = useNavigate();
  const toast = useToast();
  const [dialog, setDialog] = useState(false);
  const [requests, setRequests] = useState<PairRequest[]>([]);

  useEffect(() => {
    const open = () => setDialog(true);
    window.addEventListener('mm:pair-phone', open);
    return () => window.removeEventListener('mm:pair-phone', open);
  }, []);

  // Requests that arrived while the socket was down.
  useEffect(() => {
    if (!user || !wsOpen) return;
    pairApi.requests().then(setRequests, () => undefined);
  }, [user, wsOpen]);

  useServerEvent((ev) => {
    if (ev.type === 'remote.key') handleRemoteKey(ev.key, ev.text);
    else if (ev.type === 'pair.request') setRequests((r) => [...r.filter((x) => x.id !== ev.request.id), ev.request]);
    else if (ev.type === 'pair.updated' && ev.requestId) setRequests((r) => r.filter((x) => x.id !== ev.requestId));
    else if (ev.type === 'remote.command') {
      if (ev.action === 'playItem' && ev.itemId) navigate(`/play/${encodeURIComponent(ev.itemId)}${ev.positionMs != null ? `?start=${Math.round(ev.positionMs)}` : ''}`);
      else if (ev.action === 'playChannel' && ev.channelId) navigate(`/watch/live/${encodeURIComponent(ev.channelId)}`);
    }
  });

  // Drop requests once they expire.
  useEffect(() => {
    if (!requests.length) return;
    const t = window.setInterval(() => setRequests((r) => r.filter((x) => Date.parse(x.expiresAt) > Date.now())), 5000);
    return () => window.clearInterval(t);
  }, [requests.length]);

  const req = requests[0];
  const answer = async (accept: boolean) => {
    if (!req) return;
    setRequests((r) => r.filter((x) => x.id !== req.id));
    try {
      const res = await pairApi.respond(req.id, accept);
      if (accept && res.status === 'paired') toast.success(`${req.fromUserName} can now control this TV`);
      else if (accept) toast.show('That request expired');
    } catch (e) {
      toast.error(e);
    }
  };

  if (!user) return null;
  return (
    <>
      {dialog && (
        <Suspense fallback={null}>
          <PairDialog open={dialog} onClose={() => setDialog(false)} />
        </Suspense>
      )}
      <Modal
        open={!!req}
        onClose={() => void answer(false)}
        title="Let a phone control this TV?"
        size="sm"
        footer={(
          <>
            <button className="btn btn-ghost" onClick={() => void answer(false)}>Decline</button>
            <button className="btn btn-primary" autoFocus onClick={() => void answer(true)}><Icon name="check" size={16} /> Allow</button>
          </>
        )}
      >
        {req && (
          <p>
            <strong>{req.fromUserName}</strong> wants to use <strong>{req.fromDeviceName}</strong> as a remote for this TV. They’ll be able to control
            playback and browse what you can watch here — not your account, settings or history. You can unpair them any time.
          </p>
        )}
      </Modal>
    </>
  );
}
