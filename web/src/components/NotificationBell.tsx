import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AppNotification } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useServerEvent } from '../hooks';
import { Icon } from './Icon';
import { Img } from './ui';
import { relativeTime } from '../utils/format';

/** Top-bar bell: unread count, a dropdown of recent notifications, live updates over the WebSocket. */
export function NotificationBell() {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const load = () =>
    api.discovery.notifications(30).then((r) => {
      setItems(r.items);
      setUnread(r.unread);
    }).catch(() => undefined);
  useEffect(() => {
    void load();
  }, []);
  useServerEvent((ev) => {
    if (ev.type === 'notification') {
      setItems((l) => [ev.notification, ...l.filter((n) => n.id !== ev.notification.id)].slice(0, 30));
      setUnread(ev.unread);
    }
  });

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    if (next) void load();
  };
  const markAll = async () => {
    try {
      const r = await api.discovery.markRead();
      setUnread(r.unread);
      const now = new Date().toISOString();
      setItems((l) => l.map((n) => (n.readAt ? n : { ...n, readAt: now })));
    } catch {
      /* ignore */
    }
  };
  const openOne = (n: AppNotification) => {
    setOpen(false);
    if (!n.readAt) {
      setItems((l) => l.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)));
      api.discovery.markRead([n.id]).then((r) => setUnread(r.unread)).catch(() => undefined);
    }
  };

  return (
    <div className="notif" ref={ref}>
      <button className={`btn-icon notif-btn ${open ? 'active' : ''}`} onClick={toggle} aria-label={unread ? `Notifications, ${unread} unread` : 'Notifications'} aria-expanded={open} aria-haspopup="dialog">
        <Icon name="bell" size={20} />
        {unread > 0 && <span className="notif-count">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="notif-panel" role="dialog" aria-label="Notifications">
          <header className="notif-head">
            <strong>Notifications</strong>
            {unread > 0 && <button className="btn btn-sm" onClick={markAll}>Mark all read</button>}
          </header>
          {items.length ? (
            <ul className="notif-list">
              {items.map((n) => (
                <li key={n.id} className={n.readAt ? '' : 'unread'}>
                  <Link to={n.itemId ? `/item/${n.itemId}` : '/calendar'} onClick={() => openOne(n)} className="notif-item">
                    <span className="notif-art"><Img src={n.imageUrl} width={160} alt="" fallback={<Icon name="shows" size={18} />} /></span>
                    <span className="notif-text">
                      <span className="notif-title">{n.title}</span>
                      {n.body && <span className="notif-body">{n.body}</span>}
                      <span className="notif-time">{relativeTime(n.createdAt)}</span>
                    </span>
                    {!n.readAt && <span className="notif-dot" aria-label="Unread" />}
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <div className="notif-empty">
              <Icon name="bell" size={26} />
              <p>No notifications yet</p>
              <small className="muted">You'll hear here when new episodes of shows you watch arrive.</small>
            </div>
          )}
          <footer className="notif-foot">
            <Link to="/calendar" onClick={() => setOpen(false)}><Icon name="calendar" size={14} /> Open calendar</Link>
          </footer>
        </div>
      )}
    </div>
  );
}
