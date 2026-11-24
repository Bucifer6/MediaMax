import { useState } from 'react';
import { Link } from 'react-router-dom';
import type { Recording, RecordingRule } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useServerEvent } from '../hooks';
import { Badge, Button, EmptyState, ErrorState, Field, Modal, PageHeader, Skeleton, Switch, Tabs, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes, formatTime, relativeTime } from '../utils/format';
import { HelpLink } from '../components/HelpLink';
import '../styles/epg.css';

type Tab = 'upcoming' | 'completed' | 'rules';

const STATUS_LABEL: Record<string, string> = { scheduled: 'Scheduled', recording: 'Recording', completed: 'Recorded', failed: 'Failed', cancelled: 'Cancelled' };

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function ruleChips(r: RecordingRule): string[] {
  const parts = [r.channelId ? 'One channel' : 'Any channel', r.newOnly ? 'New episodes only' : 'All airings'];
  if (r.daysOfWeek?.length) parts.push(r.daysOfWeek.map((d) => DAYS[d]).join(', '));
  if (r.timeFrom && r.timeTo) parts.push(`${r.timeFrom}–${r.timeTo}`);
  if (r.skipRepeats) parts.push('Skip repeats');
  parts.push(r.keepLatest ? `Keep latest ${r.keepLatest}` : 'Keep all', `Priority ${r.priority}`, `Padding −${r.paddingBeforeMin}/+${r.paddingAfterMin} min`);
  return parts;
}

function formatGap(sec: number) {
  if (sec < 90) return `${Math.max(1, Math.round(sec))}s`;
  const m = Math.round(sec / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

function RecordingRow({ r, onDelete, onPriority }: { r: Recording; onDelete: (r: Recording) => void; onPriority: (r: Recording, p: number) => void }) {
  const conflict = !!r.conflict && r.status === 'scheduled';
  const tone = conflict ? 'warning' : r.status === 'recording' ? 'live' : r.status === 'completed' ? 'success' : r.status === 'failed' ? 'danger' : r.status === 'cancelled' ? 'muted' : 'outline';
  const active = r.status === 'scheduled' || r.status === 'recording';
  return (
    <li className={`rec-row ${r.status === 'recording' ? 'is-recording' : ''} ${conflict ? 'is-conflict' : ''} ${r.status === 'failed' ? 'is-failed' : ''}`}>
      <div className="rec-when">
        <strong>{formatTime(r.start)} – {formatTime(r.end)}</strong>
        <span>{r.status === 'scheduled' ? relativeTime(r.start) : new Date(r.start).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}</span>
      </div>
      <div className="rec-info">
        <div className="rec-title">
          {r.status === 'recording' && <span className="live-dot rec-dot" aria-hidden="true" />}<span>{r.title}</span>
        </div>
        <div className="rec-sub">
          <span>{r.channelName}</span>
          {r.ruleId && <><span aria-hidden="true">·</span><Icon name="layers" size={12} /> <span>Series</span></>}
          {r.sizeBytes ? <><span aria-hidden="true">·</span><span>{formatBytes(r.sizeBytes)}</span></> : null}
          {r.status === 'scheduled' && r.priority !== 50 && <><span aria-hidden="true">·</span><span>Priority {r.priority}</span></>}
        </div>
        {conflict && (
          <div className="rec-conflict" role="note">
            <Icon name="alert" size={14} /> Won't record: every tuner / provider connection is booked by higher-priority recordings.
            <button className="btn btn-xs" onClick={() => onPriority(r, 100)} disabled={r.priority >= 100}>Make top priority</button>
          </div>
        )}
        {r.error && <div className="rec-error">{r.error}</div>}
        {!!r.gapSeconds && r.gapSeconds > 0 && (
          <div className="rec-note"><Icon name="alert" size={12} /> Recording was interrupted for ~{formatGap(r.gapSeconds)} (server restart); the parts were joined.</div>
        )}
        {!!r.leftoverParts?.length && (
          <div className="rec-note">
            {r.leftoverParts.length === 1 ? 'A part recorded before the interruption' : `${r.leftoverParts.length} parts recorded before the interruption`} could not be joined and {r.leftoverParts.length === 1 ? 'is' : 'are'} kept separately (deleted with this recording):{' '}
            {r.leftoverParts.map((p) => <code key={p.name}>{p.name}{p.sizeBytes ? ` (${formatBytes(p.sizeBytes)})` : ''}</code>)}
          </div>
        )}
        {r.description && <p className="rec-desc">{r.description}</p>}
      </div>
      <Badge tone={tone} className="rec-status">{conflict ? 'Conflict' : STATUS_LABEL[r.status] ?? r.status}</Badge>
      <div className="rec-actions">
        {r.itemId && (
          <Link to={`/play/${r.itemId}`} className="btn btn-primary btn-sm"><Icon name="play" size={14} /> Play</Link>
        )}
        {r.status === 'recording' && (
          <Link to={`/watch/live/${r.channelId}`} className="btn btn-sm"><Icon name="tv" size={14} /> Watch live</Link>
        )}
        <button className="btn-icon btn-icon-sm" onClick={() => onDelete(r)} aria-label={active ? `Cancel recording ${r.title}` : `Delete recording ${r.title}`} title={active ? 'Cancel' : 'Delete'}>
          <Icon name={active ? 'x' : 'trash'} size={16} />
        </button>
      </div>
    </li>
  );
}

/** Scheduled recordings grouped by day ("Today", "Tomorrow", "Wed 26 Nov"). */
function byDay(list: Recording[]): [string, Recording[]][] {
  const out = new Map<string, Recording[]>();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const r of list) {
    const d = new Date(r.start);
    d.setHours(0, 0, 0, 0);
    const diff = Math.round((d.getTime() - today.getTime()) / 86400000);
    const key = r.status === 'recording' ? 'Recording now' : diff === 0 ? 'Today' : diff === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
    if (!out.has(key)) out.set(key, []);
    out.get(key)!.push(r);
  }
  return [...out];
}

export default function DvrPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const [tab, setTab] = useState<Tab>('upcoming');
  const recs = useAsync(() => api.dvr.recordings(), []);
  const rules = useAsync(() => api.dvr.rules(), []);
  const defaults = useAsync(() => api.dvr.defaults().catch(() => ({ paddingBeforeMin: 1, paddingAfterMin: 5 })), []);
  const padBefore = defaults.data?.paddingBeforeMin ?? 1;
  const padAfter = defaults.data?.paddingAfterMin ?? 5;
  const [editRule, setEditRule] = useState<Partial<RecordingRule> | null>(null);

  useServerEvent((ev) => {
    if (ev.type === 'recording.updated') {
      recs.setData((list) => {
        const l = list ?? [];
        return l.some((x) => x.id === ev.recording.id) ? l.map((x) => (x.id === ev.recording.id ? ev.recording : x)) : [...l, ev.recording];
      });
    }
  });

  const all = recs.data ?? [];
  const upcoming = all.filter((r) => r.status === 'scheduled' || r.status === 'recording').sort((a, b) => a.start.localeCompare(b.start));
  const done = all.filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled').sort((a, b) => b.start.localeCompare(a.start));

  const del = async (r: Recording) => {
    const active = r.status === 'scheduled' || r.status === 'recording';
    if (!(await confirm({ title: active ? 'Cancel this recording?' : 'Delete this recording?', message: r.title, confirmLabel: active ? 'Cancel recording' : 'Delete', danger: true }))) return;
    try {
      await api.dvr.removeRecording(r.id);
      recs.setData((l) => (l ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      toast.error(e);
    }
  };

  const setPriority = async (r: Recording, priority: number) => {
    try {
      const u = await api.dvr.updateRecording(r.id, { priority });
      recs.setData((l) => (l ?? []).map((x) => (x.id === u.id ? u : x)));
      recs.reload(); // other recordings' conflict flags may have changed
    } catch (e) {
      toast.error(e);
    }
  };

  const saveRule = async () => {
    if (!editRule?.titleMatch?.trim()) return;
    try {
      const body = {
        titleMatch: editRule.titleMatch.trim(),
        channelId: editRule.channelId || null,
        newOnly: editRule.newOnly ?? true,
        keepLatest: editRule.keepLatest ?? null,
        paddingBeforeMin: editRule.paddingBeforeMin ?? padBefore,
        paddingAfterMin: editRule.paddingAfterMin ?? padAfter,
        enabled: editRule.enabled ?? true,
        priority: editRule.priority ?? 50,
        daysOfWeek: editRule.daysOfWeek?.length ? editRule.daysOfWeek : null,
        timeFrom: editRule.timeFrom && editRule.timeTo ? editRule.timeFrom : null,
        timeTo: editRule.timeFrom && editRule.timeTo ? editRule.timeTo : null,
        skipRepeats: editRule.skipRepeats ?? true,
      };
      if (editRule.id) {
        const r = await api.dvr.updateRule(editRule.id, body);
        rules.setData((l) => (l ?? []).map((x) => (x.id === r.id ? r : x)));
      } else {
        const r = await api.dvr.createRule(body);
        rules.setData((l) => [...(l ?? []), r]);
      }
      setEditRule(null);
      toast.success('Series rule saved');
      recs.reload();
    } catch (e) {
      toast.error(e);
    }
  };

  const toggleRule = async (r: RecordingRule) => {
    try {
      const u = await api.dvr.updateRule(r.id, { enabled: !r.enabled });
      rules.setData((l) => (l ?? []).map((x) => (x.id === u.id ? u : x)));
    } catch (e) {
      toast.error(e);
    }
  };
  const deleteRule = async (r: RecordingRule) => {
    if (!(await confirm({ title: `Delete series rule "${r.titleMatch}"?`, confirmLabel: 'Delete', danger: true }))) return;
    try {
      await api.dvr.removeRule(r.id);
      rules.setData((l) => (l ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      toast.error(e);
    }
  };

  const recordingNow = upcoming.filter((r) => r.status === 'recording').length;
  const conflicts = upcoming.filter((r) => r.conflict && r.status === 'scheduled');
  const newRule = () => setEditRule({ newOnly: true, paddingBeforeMin: padBefore, paddingAfterMin: padAfter, enabled: true, priority: 50, skipRepeats: true });

  return (
    <div className="page dvr-page">
      <PageHeader
        title={<>Recordings <HelpLink slug="recordings" label="Recordings" /></>}
        actions={(
          <>
            <Link to="/livetv/guide" className="btn"><Icon name="guide" size={16} /> Schedule from guide</Link>
            <Button variant="ghost" icon="plus" onClick={newRule}>Series rule</Button>
          </>
        )}
      />
      {recs.data && (recordingNow > 0 || conflicts.length > 0) && (
        <div className="dvr-summary" aria-label="Status">
          {recordingNow > 0 && <span className="dvr-stat is-live"><span className="live-dot" aria-hidden="true" /> Recording now <strong>{recordingNow}</strong></span>}
          {conflicts.length > 0 && <span className="dvr-stat is-warn"><Icon name="alert" size={14} /> Conflicts <strong>{conflicts.length}</strong></span>}
        </div>
      )}
      {conflicts.length > 0 && tab === 'upcoming' && (
        <div className="dvr-conflicts" role="alert">
          <Icon name="alert" size={20} />
          <div>
            <strong>{conflicts.length === 1 ? '1 recording won’t happen' : `${conflicts.length} recordings won’t happen`}</strong>
            <p>Every tuner or provider connection is already booked at {conflicts.length === 1 ? 'that time' : 'those times'}. Make {conflicts.length === 1 ? 'it' : 'one'} top priority below, or cancel something else.</p>
          </div>
        </div>
      )}
      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'upcoming', label: <>Scheduled {upcoming.length > 0 && <span className="tab-count">{upcoming.length}</span>}</> },
          { value: 'completed', label: <>Recorded {done.length > 0 && <span className="tab-count">{done.length}</span>}</> },
          { value: 'rules', label: <>Series rules {rules.data?.length ? <span className="tab-count">{rules.data.length}</span> : null}</> },
        ]}
      />
      <div className="dvr-body">
        {tab !== 'rules' ? (
          recs.loading && !recs.data ? (
            <div>{[0, 1, 2].map((i) => <Skeleton key={i} h={72} r={14} style={{ marginBottom: 8 }} />)}</div>
          ) : recs.error ? (
            <ErrorState message={recs.error} onRetry={recs.reload} />
          ) : (tab === 'upcoming' ? upcoming : done).length === 0 ? (
            <EmptyState icon="recordOutline" title={tab === 'upcoming' ? 'Nothing scheduled' : 'No recordings yet'} message="Open the guide, pick a programme and choose Record." action={<Link to="/livetv/guide" className="btn"><Icon name="guide" size={16} /> Open the guide</Link>} />
          ) : tab === 'upcoming' ? (
            byDay(upcoming).map(([day, list]) => (
              <section key={day} className="dvr-day" aria-label={day}>
                <h2 className="dvr-day-title">{day}</h2>
                <ul className="rec-list">{list.map((r) => <RecordingRow key={r.id} r={r} onDelete={del} onPriority={setPriority} />)}</ul>
              </section>
            ))
          ) : (
            <ul className="rec-list">{done.map((r) => <RecordingRow key={r.id} r={r} onDelete={del} onPriority={setPriority} />)}</ul>
          )
        ) : rules.loading && !rules.data ? (
          <Skeleton h={120} r={14} />
        ) : !rules.data?.length ? (
          <EmptyState icon="layers" title="No series rules" message="Rules automatically record every airing whose title matches." action={<Button variant="primary" icon="plus" onClick={newRule}>New rule</Button>} />
        ) : (
          <ul className="rec-list">
            {rules.data.map((r) => (
              <li key={r.id} className={`rec-row rule-row ${r.enabled ? '' : 'is-off'}`}>
                <span className="rule-icon" aria-hidden="true"><Icon name="layers" size={20} /></span>
                <div className="rec-info">
                  <div className="rec-title"><span>“{r.titleMatch}”</span>{!r.enabled && <Badge tone="muted">Paused</Badge>}</div>
                  <div className="rule-chips">{ruleChips(r).map((c) => <Badge key={c} tone="outline">{c}</Badge>)}</div>
                </div>
                <input type="checkbox" className="switch" checked={r.enabled} onChange={() => toggleRule(r)} aria-label={`Rule “${r.titleMatch}” enabled`} />
                <div className="rec-actions">
                  <button className="btn-icon btn-icon-sm" onClick={() => setEditRule(r)} aria-label={`Edit rule “${r.titleMatch}”`} title="Edit"><Icon name="edit" size={16} /></button>
                  <button className="btn-icon btn-icon-sm" onClick={() => deleteRule(r)} aria-label={`Delete rule “${r.titleMatch}”`} title="Delete"><Icon name="trash" size={16} /></button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <Modal
        open={!!editRule}
        onClose={() => setEditRule(null)}
        title={editRule?.id ? 'Edit series rule' : 'New series rule'}
        footer={<><button className="btn btn-ghost" onClick={() => setEditRule(null)}>Cancel</button><button className="btn btn-primary" onClick={saveRule} disabled={!editRule?.titleMatch?.trim()}>Save</button></>}
      >
        {editRule && (
          <div className="form-grid">
            <Field label="Title contains"><input className="input" value={editRule.titleMatch ?? ''} onChange={(e) => setEditRule({ ...editRule, titleMatch: e.target.value })} autoFocus /></Field>
            <div className="form-row form-row-3">
              <Field label="Start early (min)"><input className="input" type="number" min={0} value={editRule.paddingBeforeMin ?? 0} onChange={(e) => setEditRule({ ...editRule, paddingBeforeMin: Number(e.target.value) })} /></Field>
              <Field label="End late (min)"><input className="input" type="number" min={0} value={editRule.paddingAfterMin ?? 0} onChange={(e) => setEditRule({ ...editRule, paddingAfterMin: Number(e.target.value) })} /></Field>
              <Field label="Keep latest" hint="Blank = keep all"><input className="input" type="number" min={1} value={editRule.keepLatest ?? ''} onChange={(e) => setEditRule({ ...editRule, keepLatest: e.target.value ? Number(e.target.value) : null })} /></Field>
            </div>
            <Field label="Days" hint="None selected = every day">
              <div className="chip-row" style={{ display: "flex", flexWrap: "wrap", gap: 6 }} role="group" aria-label="Days of the week">
                {DAYS.map((d, i) => {
                  const on = editRule.daysOfWeek?.includes(i) ?? false;
                  return (
                    <button key={d} type="button" className={`chip${on ? ' active' : ''}`} aria-pressed={on}
                      onClick={() => setEditRule({ ...editRule, daysOfWeek: on ? (editRule.daysOfWeek ?? []).filter((x) => x !== i) : [...(editRule.daysOfWeek ?? []), i].sort() })}>
                      {d}
                    </button>
                  );
                })}
              </div>
            </Field>
            <div className="form-row form-row-3">
              <Field label="From" hint="Optional time window"><input className="input" type="time" value={editRule.timeFrom ?? ''} onChange={(e) => setEditRule({ ...editRule, timeFrom: e.target.value || null })} /></Field>
              <Field label="To"><input className="input" type="time" value={editRule.timeTo ?? ''} onChange={(e) => setEditRule({ ...editRule, timeTo: e.target.value || null })} /></Field>
              <Field label="Priority" hint="0–99; wins tuner conflicts"><input className="input" type="number" min={0} max={99} value={editRule.priority ?? 50} onChange={(e) => setEditRule({ ...editRule, priority: Number(e.target.value) })} /></Field>
            </div>
            <Switch checked={editRule.newOnly ?? true} onChange={(v) => setEditRule({ ...editRule, newOnly: v })} label="New episodes only" />
            <Switch checked={editRule.skipRepeats ?? true} onChange={(v) => setEditRule({ ...editRule, skipRepeats: v })} label="Skip episodes already recorded" />
            <Switch checked={editRule.enabled ?? true} onChange={(v) => setEditRule({ ...editRule, enabled: v })} label="Enabled" />
          </div>
        )}
      </Modal>
    </div>
  );
}
