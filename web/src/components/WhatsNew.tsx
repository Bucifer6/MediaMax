import { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import type { HelpWhatsNew } from '@mediamax/shared';
import { helpApi } from '../api/help';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

const HIDDEN_ON = /^\/(play|watch|login|profiles|invite)\b/;

/**
 * "What's new in <product> <version>": shown once per user (and profile) after the server version changes.
 * The dismissed version is stored in the user's preferences (`whatsNewSeen`), so it follows them across devices.
 */
export function WhatsNew() {
  const { user, setUser, system } = useApp();
  const loc = useLocation();
  const [notes, setNotes] = useState<HelpWhatsNew | null>(null);
  const [closing, setClosing] = useState(false);
  const version = system?.version;
  const due = !!user && !!version && user.preferences.whatsNewSeen !== version;

  useEffect(() => {
    if (!due) return;
    let alive = true;
    helpApi.whatsNew().then((n) => alive && setNotes(n), () => undefined);
    return () => { alive = false; };
  }, [due]);

  if (!due || !notes || !user || HIDDEN_ON.test(loc.pathname) || closing) return null;

  const dismiss = async () => {
    setClosing(true);
    const prev = user;
    setUser({ ...user, preferences: { ...user.preferences, whatsNewSeen: version } });
    try {
      setUser(await api.auth.updateMe({ preferences: { whatsNewSeen: version } }));
    } catch {
      setUser(prev);
    }
  };

  return (
    <aside className="whats-new" role="dialog" aria-labelledby="whats-new-title" aria-modal="false">
      <header>
        <span className="whats-new-icon"><Icon name="sparkles" size={20} /></span>
        <h2 id="whats-new-title">{notes.title}</h2>
        <button className="btn-icon" onClick={() => void dismiss()} aria-label="Dismiss what's new"><Icon name="x" size={18} /></button>
      </header>
      <div className="whats-new-body">
        <Markdown source={notes.markdown} />
      </div>
      <footer>
        <Link to="/help" className="btn btn-ghost btn-sm" onClick={() => void dismiss()}><Icon name="help" size={16} /> Help Centre</Link>
        <button className="btn btn-primary btn-sm" onClick={() => void dismiss()}>Got it</button>
      </footer>
    </aside>
  );
}
