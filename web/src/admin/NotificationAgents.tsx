import { useState } from 'react';
import type { NotificationAgent, NotificationAgentKind, NotifyEvent } from '@mediamax/shared';
import { seerrApi } from '../api/seerr';
import { useAsync } from '../hooks';
import { useToast } from '../state/toast';
import { Dropdown, Field, Skeleton, Spinner, Switch } from '../components/ui';
import { Icon } from '../components/Icon';
import '../styles/requests.css';

const EVENTS: { value: NotifyEvent; label: string }[] = [
  { value: 'request.pending', label: 'New request' },
  { value: 'request.auto_approved', label: 'Auto-approved' },
  { value: 'request.approved', label: 'Approved' },
  { value: 'request.declined', label: 'Declined' },
  { value: 'request.available', label: 'Available' },
  { value: 'request.failed', label: 'Failed' },
  { value: 'request.comment', label: 'Request comment' },
  { value: 'issue.created', label: 'New issue' },
  { value: 'issue.comment', label: 'Issue comment' },
  { value: 'issue.resolved', label: 'Issue resolved' },
  { value: 'issue.reopened', label: 'Issue reopened' },
];

/** Discord, Slack, Telegram, ntfy, Gotify, Pushover, email and JSON webhook agents with per-event toggles and a Test button. */
export function NotificationAgentsPanel({ value, onChange }: { value: NotificationAgent[]; onChange: (v: NotificationAgent[]) => void }) {
  const toast = useToast();
  const kinds = useAsync(() => seerrApi.agentKinds(), []);
  const [testing, setTesting] = useState<string | null>(null);
  const upd = (id: string, p: Partial<NotificationAgent>) => onChange(value.map((a) => (a.id === id ? { ...a, ...p } : a)));
  const add = (kind: NotificationAgentKind) => {
    const info = kinds.data?.find((k) => k.kind === kind);
    onChange([...value, { id: `new-${Date.now().toString(36)}`, kind, name: info?.label ?? kind, enabled: true, events: EVENTS.map((e) => e.value), config: {} }]);
  };
  const test = async (a: NotificationAgent) => {
    setTesting(a.id);
    try {
      const r = await seerrApi.testAgent(a);
      if (r.ok) toast.success(`${a.name}: test sent`);
      else toast.show(`${a.name}: ${r.message}`, 'error');
    } catch (e) {
      toast.error(e);
    } finally {
      setTesting(null);
    }
  };
  if (kinds.loading && !kinds.data) return <Skeleton h={120} />;
  return (
    <div className="form-grid">
      <p className="muted" style={{ margin: 0 }}>
        Send request and issue updates to chat apps, push services or email. Requesters and admins also get in-app notifications (the bell) automatically;
        the JSON webhooks in the Webhooks tab get the same events.
      </p>
      <div className="agent-list">
        {value.map((a) => {
          const info = kinds.data?.find((k) => k.kind === a.kind);
          return (
            <section key={a.id} className="agent">
              <header>
                <strong>{info?.label ?? a.kind}</strong>
                <input className="input grow" value={a.name} onChange={(e) => upd(a.id, { name: e.target.value })} aria-label="Name" />
                <Switch checked={a.enabled} onChange={(v) => upd(a.id, { enabled: v })} label="On" />
                <button className="btn btn-sm" onClick={() => void test(a)} disabled={testing === a.id}>{testing === a.id ? <Spinner size={14} /> : <Icon name="zap" size={14} />} Test</button>
                <button className="btn-icon" aria-label={`Remove ${a.name}`} onClick={() => onChange(value.filter((x) => x.id !== a.id))}><Icon name="trash" size={16} /></button>
              </header>
              <div className="form-row" style={{ flexWrap: 'wrap' }}>
                {(info?.fields ?? []).map((f) => (
                  <Field key={f.key} label={`${f.label}${f.required ? '' : ' (optional)'}`} hint={f.hint}>
                    <input className={`input ${f.secret ? 'mono' : ''}`} type={f.secret ? 'password' : 'text'} autoComplete="off" placeholder={f.placeholder}
                      value={a.config[f.key] ?? ''} onChange={(e) => upd(a.id, { config: { ...a.config, [f.key]: e.target.value } })} />
                  </Field>
                ))}
              </div>
              <div className="event-chips">
                {EVENTS.map((e) => (
                  <label key={e.value} className={`check-chip ${a.events.includes(e.value) ? 'on' : ''}`}>
                    <input type="checkbox" checked={a.events.includes(e.value)} onChange={(ev) => upd(a.id, { events: ev.target.checked ? [...a.events, e.value] : a.events.filter((x) => x !== e.value) })} /> {e.label}
                  </label>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      <div>
        <Dropdown align="left"
          trigger={({ onClick }) => <button className="btn" onClick={onClick}><Icon name="plus" size={16} /> Add notification agent</button>}
          items={(kinds.data ?? []).map((k) => ({ label: k.label, icon: 'bell' as const, onClick: () => add(k.kind) }))} />
      </div>
      <small className="field-hint">Save changes to keep agents. Links in messages use the Public URL (General tab).</small>
    </div>
  );
}
