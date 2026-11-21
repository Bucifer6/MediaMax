import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useServerEvent } from '../hooks';
import { Icon } from './Icon';

interface Shown {
  id: number;
  from: string;
  header: string | null;
  text: string;
  tone: 'info' | 'warning';
}

let seq = 0;

/**
 * Messages from the server administrator (dashboard "Send message") and "your stream was stopped" notices.
 * Rendered into the fullscreen element when there is one, so they show over fullscreen video too.
 */
export function ServerMessages() {
  const [items, setItems] = useState<Shown[]>([]);
  const [, setFs] = useState(0);
  useEffect(() => {
    const on = () => setFs((n) => n + 1);
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  const push = (m: Omit<Shown, 'id'>, ms: number) => {
    const id = ++seq;
    setItems((l) => [...l.slice(-2), { ...m, id }]);
    window.setTimeout(() => setItems((l) => l.filter((x) => x.id !== id)), ms);
  };
  useServerEvent((ev) => {
    if (ev.type === 'session.message') push({ from: ev.from, header: ev.header, text: ev.text, tone: 'info' }, ev.timeoutMs);
    else if (ev.type === 'session.terminated' && ev.reason !== 'idle') {
      push({ from: 'Server', header: 'Playback stopped', text: ev.reason === 'user_deleted' ? 'This account was removed.' : ev.reason, tone: 'warning' }, 10000);
    }
  });
  if (!items.length) return null;
  return createPortal(
    <div className="server-messages" role="status" aria-live="assertive">
      {items.map((m) => (
        <div key={m.id} className={`server-message tone-${m.tone}`} onClick={() => setItems((l) => l.filter((x) => x.id !== m.id))}>
          <Icon name={m.tone === 'warning' ? 'alert' : 'info'} size={20} />
          <div>
            <strong>{m.header || `Message from ${m.from}`}</strong>
            <p>{m.text}</p>
          </div>
        </div>
      ))}
    </div>,
    document.fullscreenElement ?? document.body,
  );
}
