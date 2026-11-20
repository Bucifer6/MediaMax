import { useEffect, useState } from 'react';
import type { SecurityCount, SecurityDashboardSettings, SecurityOverview } from '@mediamax/shared';
import { http } from '../api/client';
import { useToast } from '../state/toast';
import { Badge, ErrorState, Field, Modal, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { formatBytes, relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

const api = {
  overview: (refresh = false) => http.get<SecurityOverview>('/admin/security', refresh ? { refresh: '1' } : undefined),
  settings: () => http.get<SecurityDashboardSettings>('/admin/security/settings'),
  saveSettings: (s: Partial<SecurityDashboardSettings>) => http.put<SecurityDashboardSettings>('/admin/security/settings', s),
  ban: (b: { ip: string; tool: 'crowdsec' | 'fail2ban'; jail?: string; duration?: string; reason?: string }) => http.post<{ ok: true }>('/admin/security/ban', b),
  unban: (b: { ip: string; tool?: 'crowdsec' | 'fail2ban'; jail?: string }) => http.post<{ ok: true; removedFrom: string[] }>('/admin/security/unban', b),
};

const REASON: Record<string, string> = { password: 'Wrong password', pin: 'Wrong PIN', totp: 'Wrong 2FA code', api_key: 'Bad API key', subsonic: 'Music app login' };

function Bars({ data, label, tone = 'primary' }: { data: number[]; label: string; tone?: 'primary' | 'danger' }) {
  const max = Math.max(1, ...data);
  return (
    <div className={`sec-bars sec-bars-${tone}`} role="img" aria-label={`${label}: ${data.reduce((a, b) => a + b, 0)} in the last 24 hours`}>
      {data.map((v, i) => <i key={i} style={{ height: `${Math.max(2, (v / max) * 100)}%` }} title={`${23 - i}h ago: ${v}`} />)}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string | number; sub?: string; tone?: 'good' | 'warn' | 'bad' }) {
  return (
    <div className={`sec-tile ${tone ? `sec-${tone}` : ''}`}>
      <span className="sec-tile-label">{label}</span>
      <strong>{value}</strong>
      {sub && <span className="muted small">{sub}</span>}
    </div>
  );
}

function IpTable({ rows, onBan, empty, extraLabel }: { rows: SecurityCount[]; onBan?: (ip: string) => void; empty: string; extraLabel?: string }) {
  if (!rows.length) return <p className="muted small">{empty}</p>;
  return (
    <table className="sec-table">
      <thead><tr><th>Address</th><th className="num">Count</th>{extraLabel && <th>{extraLabel}</th>}{onBan && <th />}</tr></thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="mono">{r.key}</td>
            <td className="num">{r.count}</td>
            {extraLabel && <td className="muted">{r.extra ?? ''}</td>}
            {onBan && <td className="right"><button className="btn btn-sm btn-ghost" onClick={() => onBan(r.key)}><Icon name="lock" size={14} /> Ban</button></td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function NotConnected({ what, hint }: { what: string; hint: string }) {
  return <p className="muted small"><Icon name="info" size={14} /> {what} isn't connected. {hint}</p>;
}

export function SecurityAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const [data, setData] = useState<SecurityOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [banOpen, setBanOpen] = useState<{ ip: string } | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const load = async (refresh = false) => {
    setBusy(true);
    try {
      setData(await api.overview(refresh));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 30000);
    return () => window.clearInterval(t);
  }, []);

  const unban = async (ip: string, tool?: 'crowdsec' | 'fail2ban', jail?: string) => {
    if (!(await confirm({ title: `Unban ${ip}?`, message: tool ? `Removes the ${tool === 'crowdsec' ? 'CrowdSec decision' : `fail2ban ban in ${jail}`}.` : 'Removes it from CrowdSec and every fail2ban jail.', confirmLabel: 'Unban' }))) return;
    try {
      const r = await api.unban({ ip, tool, jail });
      toast.success(r.removedFrom.length ? `Unbanned from ${r.removedFrom.join(', ')}` : `${ip} wasn't banned`);
      void load(true);
    } catch (e) {
      toast.error(e);
    }
  };

  if (error && !data) return <div><AdminHeader title="Security" /><ErrorState message={error} onRetry={() => void load()} /></div>;
  if (!data) return <div><AdminHeader title="Security" /><Skeleton h={480} /></div>;

  const d = data;
  const activeBans = (d.crowdsec?.decisions.length ?? 0) + (d.fail2ban?.jails.reduce((n, j) => n + j.currentlyBanned, 0) ?? 0);
  const errorRate = d.proxy && d.proxy.requests24h ? (d.proxy.status.s4xx + d.proxy.status.s5xx) / d.proxy.requests24h : 0;
  const canBan = !!(d.crowdsec?.ok || d.fail2ban?.ok);

  return (
    <div className="sec-page">
      <AdminHeader
        title="Security"
        subtitle="Sign-in attempts, your reverse proxy, HTTPS certificate, CrowdSec and fail2ban — in one place."
        actions={<>
          {canBan && <button className="btn" onClick={() => setBanOpen({ ip: '' })}><Icon name="lock" size={16} /> Ban an address</button>}
          <button className="btn btn-ghost" onClick={() => setSettingsOpen(true)}><Icon name="settings" size={16} /> Connections</button>
          <button className="btn btn-ghost" onClick={() => void load(true)} disabled={busy} aria-label="Refresh">{busy ? <Spinner size={16} /> : <Icon name="refresh" size={16} />}</button>
        </>}
      />

      <div className="sec-tiles">
        <Tile label="Failed sign-ins (24 h)" value={d.signIns.failures24h} sub={`${d.signIns.failures7d} this week · ${d.signIns.successes24h} successful`} tone={d.signIns.failures24h > 50 ? 'bad' : d.signIns.failures24h > 10 ? 'warn' : 'good'} />
        <Tile label="Accounts locked (24 h)" value={d.signIns.lockouts24h} tone={d.signIns.lockouts24h ? 'warn' : 'good'} />
        <Tile label="Active bans" value={d.crowdsec || d.fail2ban ? activeBans : '—'} sub={[d.crowdsec && 'CrowdSec', d.fail2ban && 'fail2ban'].filter(Boolean).join(' + ') || 'No ban tool connected'} />
        {d.proxy && <Tile label={`${d.proxy.kind === 'caddy' ? 'Caddy' : 'Nginx'} requests (24 h)`} value={d.proxy.requests24h.toLocaleString()} sub={`${(errorRate * 100).toFixed(1)}% errors · ${formatBytes(d.proxy.bytes24h)}`} tone={errorRate > 0.2 ? 'warn' : 'good'} />}
        {d.certificate && (
          <Tile label="HTTPS certificate" value={d.certificate.daysLeft != null ? `${d.certificate.daysLeft} days` : 'Error'} sub={d.certificate.ok ? `${d.certificate.host} · ${d.certificate.issuer ?? ''}` : d.certificate.error ?? ''}
            tone={!d.certificate.ok || (d.certificate.daysLeft ?? 0) < 7 ? 'bad' : (d.certificate.daysLeft ?? 0) < 20 ? 'warn' : 'good'} />
        )}
      </div>

      <div className="sec-grid">
        <section className="sec-card">
          <h2><Icon name="shield" size={18} /> Sign-in attempts</h2>
          <Bars data={d.signIns.hourly} label="Failed sign-ins per hour" tone="danger" />
          <div className="chip-row">
            {d.signIns.byReason.map((r) => <Badge key={r.key} tone="muted">{REASON[r.key] ?? r.key}: {r.count}</Badge>)}
          </div>
          <h3>Top addresses (24 h)</h3>
          <IpTable rows={d.signIns.topIps} onBan={canBan ? (ip) => setBanOpen({ ip }) : undefined} empty="No failed sign-ins in the last 24 hours." />
          {d.signIns.topUsers.length > 0 && <><h3>Targeted accounts</h3><p className="small">{d.signIns.topUsers.map((u) => `${u.key} (${u.count})`).join(' · ')}</p></>}
          <details>
            <summary>Recent events</summary>
            <ul className="sec-events">
              {d.signIns.recent.map((e, i) => (
                <li key={i}><span className="muted">{relativeTime(e.at)}</span> <Badge tone={e.event === 'AUTH_LOCKED' ? 'warning' : 'danger'}>{e.event === 'AUTH_LOCKED' ? 'Locked' : REASON[e.reason ?? ''] ?? 'Failed'}</Badge> <span className="mono">{e.ip}</span>{e.user ? ` · ${e.user}` : ''}</li>
              ))}
            </ul>
          </details>
        </section>

        <section className="sec-card">
          <h2><Icon name="globe" size={18} /> Reverse proxy</h2>
          {!d.proxy ? (
            <NotConnected what="The proxy's access log" hint="Installed with deploy/install.sh? It's set up automatically. Otherwise set the log path under Connections." />
          ) : !d.proxy.ok ? (
            <p className="form-error">{d.proxy.error}</p>
          ) : (
            <>
              <p className="muted small">{d.proxy.kind === 'caddy' ? 'Caddy' : 'Nginx'} · last request {d.proxy.lastRequestAt ? relativeTime(d.proxy.lastRequestAt) : 'none in 24 h'} · {d.proxy.uniqueIps24h} visitors</p>
              <Bars data={d.proxy.hourly} label="Requests per hour" />
              <div className="sec-status">
                <span className="ok">2xx {d.proxy.status.s2xx}</span><span>3xx {d.proxy.status.s3xx}</span><span className="warn">4xx {d.proxy.status.s4xx}</span><span className="bad">5xx {d.proxy.status.s5xx}</span>
              </div>
              <h3>Busiest addresses</h3>
              <IpTable rows={d.proxy.topIps} extraLabel="Errors" onBan={canBan ? (ip) => setBanOpen({ ip }) : undefined} empty="No traffic." />
              {d.proxy.topErrors.length > 0 && (
                <>
                  <h3>Most common errors</h3>
                  <ul className="sec-errors">{d.proxy.topErrors.map((e) => <li key={e.key}><span className="mono">{e.key}</span> <span className="muted">×{e.count}</span></li>)}</ul>
                </>
              )}
            </>
          )}
        </section>

        <section className="sec-card">
          <h2><Icon name="zap" size={18} /> CrowdSec</h2>
          {!d.crowdsec ? (
            <NotConnected what="CrowdSec" hint="deploy/install.sh connects it for you; or enter the Local API URL and a machine login under Connections." />
          ) : !d.crowdsec.ok ? (
            <p className="form-error">{d.crowdsec.error}</p>
          ) : (
            <>
              <h3>Active decisions ({d.crowdsec.decisions.length})</h3>
              {d.crowdsec.decisions.length === 0 ? <p className="muted small">Nobody is banned right now.</p> : (
                <table className="sec-table">
                  <thead><tr><th>Address</th><th>Why</th><th>Expires in</th><th /></tr></thead>
                  <tbody>
                    {d.crowdsec.decisions.slice(0, 100).map((x) => (
                      <tr key={x.id}>
                        <td className="mono">{x.ip}{x.country ? <span className="muted"> · {x.country}</span> : null}</td>
                        <td className="small">{x.scenario.replace(/^crowdsecurity\//, '')}<span className="muted"> ({x.origin})</span></td>
                        <td className="small">{x.duration.replace(/\.\d+s$/, 's')}</td>
                        <td className="right"><button className="btn btn-sm btn-ghost" onClick={() => void unban(x.ip, 'crowdsec')}>Unban</button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <details>
                <summary>Recent alerts ({d.crowdsec.alerts.length})</summary>
                <ul className="sec-events">
                  {d.crowdsec.alerts.map((a) => <li key={a.id}><span className="muted">{relativeTime(a.at)}</span> <span className="mono">{a.ip ?? '—'}</span> · {a.scenario.replace(/^crowdsecurity\//, '')} <span className="muted">({a.events} events)</span></li>)}
                </ul>
              </details>
            </>
          )}
        </section>

        <section className="sec-card">
          <h2><Icon name="lock" size={18} /> fail2ban</h2>
          {!d.fail2ban ? (
            <NotConnected what="fail2ban" hint="deploy/install.sh connects it through the MediaMax bridge; or set the bridge socket under Connections." />
          ) : !d.fail2ban.ok ? (
            <p className="form-error">{d.fail2ban.error}</p>
          ) : d.fail2ban.jails.length === 0 ? <p className="muted small">No jails are running.</p> : (
            d.fail2ban.jails.map((j) => (
              <div key={j.name} className="sec-jail">
                <h3>{j.name} <span className="muted small">· {j.currentlyFailed} failing now · {j.totalFailed} failures · {j.totalBanned} bans total</span></h3>
                {j.bannedIps.length === 0 ? <p className="muted small">Nobody is banned.</p> : (
                  <ul className="sec-banned">
                    {j.bannedIps.map((ip) => <li key={ip}><span className="mono">{ip}</span><button className="btn btn-sm btn-ghost" onClick={() => void unban(ip, 'fail2ban', j.name)}>Unban</button></li>)}
                  </ul>
                )}
              </div>
            ))
          )}
        </section>
      </div>
      <p className="muted small">Updated {relativeTime(d.generatedAt)} · refreshes every 30 seconds. Bans and unbans are recorded in Activity &amp; logs.</p>

      {banOpen && <BanModal initialIp={banOpen.ip} data={d} onClose={() => setBanOpen(null)} onDone={() => { setBanOpen(null); void load(true); }} />}
      {settingsOpen && <ConnectionsModal onClose={() => setSettingsOpen(false)} onSaved={() => { setSettingsOpen(false); void load(true); }} />}
    </div>
  );
}

function BanModal({ initialIp, data, onClose, onDone }: { initialIp: string; data: SecurityOverview; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [ip, setIp] = useState(initialIp);
  const [tool, setTool] = useState<'crowdsec' | 'fail2ban'>(data.crowdsec?.ok ? 'crowdsec' : 'fail2ban');
  const [jail, setJail] = useState(data.fail2ban?.jails[0]?.name ?? 'mediamax');
  const [duration, setDuration] = useState('4h');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api.ban({ ip: ip.trim(), tool, jail: tool === 'fail2ban' ? jail : undefined, duration: tool === 'crowdsec' ? duration : undefined, reason: reason || undefined });
      toast.success(`${ip} banned`);
      onDone();
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Ban an address" footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void submit()} disabled={!ip.trim() || busy}>{busy ? <Spinner size={16} /> : 'Ban'}</button></>}>
      <div className="form-grid">
        <Field label="IP address or range"><input className="input mono" value={ip} onChange={(e) => setIp(e.target.value)} placeholder="203.0.113.9 or 203.0.113.0/24" autoFocus /></Field>
        <Field label="Ban with">
          <select className="input" value={tool} onChange={(e) => setTool(e.target.value as 'crowdsec' | 'fail2ban')}>
            {data.crowdsec?.ok && <option value="crowdsec">CrowdSec (blocks at the proxy / firewall)</option>}
            {data.fail2ban?.ok && <option value="fail2ban">fail2ban (firewall)</option>}
          </select>
        </Field>
        {tool === 'crowdsec' ? (
          <Field label="For">
            <select className="input" value={duration} onChange={(e) => setDuration(e.target.value)}>
              {['1h', '4h', '24h', '7d', '30d', '365d'].map((x) => <option key={x} value={x}>{x.replace('h', ' hours').replace('d', ' days').replace(/^1 hours$/, '1 hour').replace(/^24 hours$/, '1 day')}</option>)}
            </select>
          </Field>
        ) : (
          <Field label="Jail" hint="Uses the jail's own ban time.">
            <select className="input" value={jail} onChange={(e) => setJail(e.target.value)}>{data.fail2ban?.jails.map((j) => <option key={j.name}>{j.name}</option>)}</select>
          </Field>
        )}
        <Field label="Reason (optional)"><input className="input" value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function ConnectionsModal({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const toast = useToast();
  const [s, setS] = useState<SecurityDashboardSettings | null>(null);
  useEffect(() => {
    api.settings().then(setS).catch((e) => toast.error(e));
  }, [toast]);
  const save = async () => {
    if (!s) return;
    try {
      await api.saveSettings(s);
      toast.success('Saved');
      onSaved();
    } catch (e) {
      toast.error(e);
    }
  };
  return (
    <Modal open onClose={onClose} size="lg" title="Connections" footer={<><button className="btn btn-ghost" onClick={onClose}>Cancel</button><button className="btn btn-primary" onClick={() => void save()} disabled={!s}>Save</button></>}>
      {!s ? <Spinner /> : (
        <div className="form-grid">
          <p className="muted small">The one-command installer (<code>deploy/install.sh</code>) fills these in for you. Values saved here override it. Paths are as seen from inside the MediaMax container.</p>
          <div className="form-row">
            <Field label="Reverse proxy">
              <select className="input" value={s.proxy.kind} onChange={(e) => setS({ ...s, proxy: { ...s.proxy, kind: e.target.value as SecurityDashboardSettings['proxy']['kind'] } })}>
                <option value="none">None</option><option value="caddy">Caddy (JSON log)</option><option value="nginx">Nginx (combined log)</option>
              </select>
            </Field>
            <Field label="Access log path"><input className="input mono" value={s.proxy.accessLog ?? ''} placeholder="/var/log/proxy/caddy/access.log" onChange={(e) => setS({ ...s, proxy: { ...s.proxy, accessLog: e.target.value || null } })} /></Field>
          </div>
          <Field label="Public host name (HTTPS certificate check)"><input className="input mono" value={s.publicHost ?? ''} placeholder="media.example.com" onChange={(e) => setS({ ...s, publicHost: e.target.value || null })} /></Field>
          <div className="form-row">
            <Field label="CrowdSec Local API"><input className="input mono" value={s.crowdsec.url ?? ''} placeholder="http://crowdsec:8080" onChange={(e) => setS({ ...s, crowdsec: { ...s.crowdsec, url: e.target.value || null } })} /></Field>
            <Field label="Machine ID"><input className="input mono" value={s.crowdsec.machineId ?? ''} placeholder="mediamax-dashboard" onChange={(e) => setS({ ...s, crowdsec: { ...s.crowdsec, machineId: e.target.value || null } })} /></Field>
            <Field label="Machine password" hint="cscli machines add mediamax-dashboard --password …"><input className="input mono" type="password" autoComplete="off" value={s.crowdsec.password ?? ''} onChange={(e) => setS({ ...s, crowdsec: { ...s.crowdsec, password: e.target.value || null } })} /></Field>
          </div>
          <Field label="fail2ban bridge socket" hint="fail2ban's own socket is root-only; point this at the MediaMax bridge (deploy/fail2ban/bridge.py)."><input className="input mono" value={s.fail2banSocket ?? ''} placeholder="/run/mediamax-f2b/bridge.sock" onChange={(e) => setS({ ...s, fail2banSocket: e.target.value || null })} /></Field>
        </div>
      )}
    </Modal>
  );
}
