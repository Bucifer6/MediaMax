/**
 * CrowdSec Local API client (as a "machine", i.e. the same rights as cscli): alerts, active decisions,
 * manual ban and unban. Credentials come from the deploy installer (cscli machines add mediamax-dashboard).
 */
export interface CsConfig { url: string; machineId: string; password: string }

import { config } from '../../config.js';

// CrowdSec parses the User-Agent at login and rejects Node's default ("node"); always identify ourselves.
const UA = () => `MediaMax/${config.version}`;

let tokenCache: { key: string; token: string; until: number } | null = null;

async function token(cfg: CsConfig): Promise<string> {
  const key = `${cfg.url}|${cfg.machineId}`;
  if (tokenCache && tokenCache.key === key && tokenCache.until > Date.now() + 60000) return tokenCache.token;
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}/v1/watchers/login`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA() }, signal: AbortSignal.timeout(8000),
    body: JSON.stringify({ machine_id: cfg.machineId, password: cfg.password }),
  });
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'CrowdSec rejected the dashboard credentials' : `CrowdSec login failed (HTTP ${res.status})`);
  const j = (await res.json()) as { token: string; expire: string };
  tokenCache = { key, token: j.token, until: Date.parse(j.expire) || Date.now() + 30 * 60000 };
  return j.token;
}

async function call<T>(cfg: CsConfig, method: string, path: string, body?: unknown): Promise<T> {
  const t = await token(cfg);
  const res = await fetch(`${cfg.url.replace(/\/+$/, '')}${path}`, {
    method, headers: { authorization: `Bearer ${t}`, 'user-agent': UA(), ...(body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(10000),
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) tokenCache = null;
  if (!res.ok) throw new Error(`CrowdSec ${method} ${path.split('?')[0]} failed (HTTP ${res.status})`);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

interface RawDecision { id: number; origin: string; type: string; scope: string; value: string; duration: string; scenario: string; until?: string }
interface RawAlert { id: number; scenario: string; message: string; created_at: string; events_count: number; source: { ip?: string; value?: string; cn?: string; as_name?: string; scope: string }; decisions?: RawDecision[] }

export interface CsDecision { id: number; ip: string; scope: string; type: string; origin: string; scenario: string; duration: string; country: string | null; asName: string | null }
export interface CsAlert { id: number; scenario: string; message: string; at: string; events: number; ip: string | null; country: string | null; decisions: number }

/** Recent alerts (newest first) and the decisions that are still active. */
export async function csOverview(cfg: CsConfig, limit = 100): Promise<{ alerts: CsAlert[]; decisions: CsDecision[] }> {
  const alerts = (await call<RawAlert[] | null>(cfg, 'GET', `/v1/alerts?limit=${limit}&include_capi=false`)) ?? [];
  // Active decisions live on alerts; `has_active_decision` returns only those that are still in force.
  const active = (await call<RawAlert[] | null>(cfg, 'GET', '/v1/alerts?has_active_decision=true&include_capi=false&limit=500')) ?? [];
  const decisions: CsDecision[] = [];
  const seen = new Set<number>();
  for (const a of active) {
    for (const d of a.decisions ?? []) {
      if (seen.has(d.id)) continue;
      seen.add(d.id);
      decisions.push({ id: d.id, ip: d.value, scope: d.scope, type: d.type, origin: d.origin, scenario: d.scenario || a.scenario, duration: d.duration, country: a.source?.cn || null, asName: a.source?.as_name || null });
    }
  }
  return {
    alerts: alerts.map((a) => ({ id: a.id, scenario: a.scenario, message: a.message, at: a.created_at, events: a.events_count, ip: a.source?.ip ?? a.source?.value ?? null, country: a.source?.cn || null, decisions: a.decisions?.length ?? 0 })),
    decisions,
  };
}

/** Remove every active decision for an IP (what `cscli decisions delete --ip` does). */
export async function csUnban(cfg: CsConfig, ip: string): Promise<number> {
  const r = await call<{ nbDeleted?: string | number }>(cfg, 'DELETE', `/v1/decisions?ip=${encodeURIComponent(ip)}`);
  return Number(r?.nbDeleted ?? 0);
}

/** Ban an IP manually (what `cscli decisions add` does: a manual alert carrying one decision). */
export async function csBan(cfg: CsConfig, ip: string, duration: string, reason: string) {
  const now = new Date().toISOString();
  const scope = ip.includes('/') ? 'Range' : 'Ip';
  await call(cfg, 'POST', '/v1/alerts', [{
    scenario: `manual 'ban' from MediaMax: ${reason}`.slice(0, 200), scenario_hash: '', scenario_version: '', message: `manual ban from the MediaMax dashboard: ${reason}`.slice(0, 300),
    events_count: 1, start_at: now, stop_at: now, capacity: 0, leakspeed: '0', simulated: false, events: [],
    source: { scope, value: ip }, remediation: true,
    decisions: [{ duration, type: 'ban', scope, value: ip, origin: 'cscli', scenario: `MediaMax dashboard: ${reason}`.slice(0, 200) }],
  }]);
}
