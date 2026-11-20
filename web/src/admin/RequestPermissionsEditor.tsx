import type { RequestPermissionKind, RequestPermissionLevel, RequestPermissions, RequestQuotaKind, RequestQuotas } from '@mediamax/shared';
import { Switch } from '../components/ui';
import { Icon, type IconName } from '../components/Icon';
import '../styles/requests.css';

export const DEFAULT_REQUEST_PERMISSIONS: RequestPermissions = {
  movie: 'request', show: 'request', movie4k: 'none', show4k: 'none', music: 'request', book: 'request',
  manageRequests: false, reportIssues: true, watchlistAutoRequest: false,
};
export const DEFAULT_QUOTAS: RequestQuotas = { movie: { limit: 10, days: 7 }, show: { limit: 10, days: 7 }, music: { limit: 10, days: 7 }, book: { limit: 10, days: 7 } };

const ROWS: { key: RequestPermissionKind; label: string; icon: IconName }[] = [
  { key: 'movie', label: 'Movies', icon: 'film' },
  { key: 'show', label: 'Shows', icon: 'shows' },
  { key: 'movie4k', label: 'Movies in 4K', icon: 'film' },
  { key: 'show4k', label: 'Shows in 4K', icon: 'shows' },
  { key: 'music', label: 'Music', icon: 'music' },
  { key: 'book', label: 'Books', icon: 'book' },
];
const LEVELS: { value: RequestPermissionLevel; label: string; title: string }[] = [
  { value: 'none', label: 'No', title: "Can't request" },
  { value: 'request', label: 'Request', title: 'Needs approval' },
  { value: 'auto', label: 'Auto', title: 'Approved automatically' },
];

/** Per-kind none / request / auto + manager / issues / watchlist switches. */
export function RequestPermissionsEditor({ value, onChange, isAdmin }: { value: RequestPermissions; onChange: (v: RequestPermissions) => void; isAdmin?: boolean }) {
  const set = (p: Partial<RequestPermissions>) => onChange({ ...value, ...p });
  if (isAdmin) return <p className="muted perm-admin-note"><Icon name="shield" size={14} /> Administrators can request everything, are approved automatically and manage all requests.</p>;
  return (
    <div className="perm-editor">
      <div className="perm-grid" role="table" aria-label="Request permissions">
        {ROWS.map((r) => (
          <div className="perm-row" role="row" key={r.key}>
            <span className="perm-label" role="rowheader"><Icon name={r.icon} size={15} /> {r.label}</span>
            <div className="segmented perm-seg" role="radiogroup" aria-label={r.label}>
              {LEVELS.map((l) => (
                <button key={l.value} type="button" role="radio" aria-checked={value[r.key] === l.value} title={l.title} className={value[r.key] === l.value ? 'active' : ''} onClick={() => set({ [r.key]: l.value })}>
                  {l.label}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
      <small className="field-hint">“Request” needs approval by an admin or request manager; “Auto” is approved and sent to Radarr/Sonarr/Lidarr/Readarr right away. 4K also needs the regular permission.</small>
      <div className="switch-group">
        <Switch checked={value.manageRequests} onChange={(v) => set({ manageRequests: v })} label="Manage requests" hint="Approve, decline, edit and delete everyone's requests; handle issues and the blacklist. No admin access otherwise." />
        <Switch checked={value.reportIssues} onChange={(v) => set({ reportIssues: v })} label="Report issues" hint="Report video, audio or subtitle problems with titles." />
        <Switch checked={value.watchlistAutoRequest} onChange={(v) => set({ watchlistAutoRequest: v })} label="Auto-request from watchlist" hint="Titles added to the Discover watchlist are requested automatically (permissions and quotas still apply)." />
      </div>
    </div>
  );
}

const QROWS: { key: RequestQuotaKind; label: string; unit: string }[] = [
  { key: 'movie', label: 'Movies', unit: 'movies' },
  { key: 'show', label: 'TV', unit: 'seasons' },
  { key: 'music', label: 'Music', unit: 'artists/albums' },
  { key: 'book', label: 'Books', unit: 'books' },
];

/** "N per X days" for each kind; 0 = unlimited. */
export function QuotaEditor({ value, onChange }: { value: RequestQuotas; onChange: (v: RequestQuotas) => void }) {
  return (
    <div className="quota-grid">
      {QROWS.map((r) => (
        <div className="quota-row" key={r.key}>
          <span className="perm-label">{r.label}</span>
          <input className="input quota-num" type="number" min={0} max={10000} inputMode="numeric" aria-label={`${r.label} limit`} value={value[r.key].limit}
            onChange={(e) => onChange({ ...value, [r.key]: { ...value[r.key], limit: Math.max(0, Math.round(Number(e.target.value) || 0)) } })} />
          <span className="muted">{r.unit} per</span>
          <input className="input quota-num" type="number" min={1} max={365} inputMode="numeric" aria-label={`${r.label} days`} value={value[r.key].days}
            onChange={(e) => onChange({ ...value, [r.key]: { ...value[r.key], days: Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))) } })} />
          <span className="muted">days</span>
          {value[r.key].limit === 0 && <span className="quota-unl">Unlimited</span>}
        </div>
      ))}
      <small className="field-hint">0 = unlimited. TV counts seasons, like Overseerr. Declined requests don't count.</small>
    </div>
  );
}

/** One-line summary of permissions for the users table. */
export function permissionSummary(p: RequestPermissions | undefined): string {
  if (!p) return '';
  const auto = ROWS.filter((r) => p[r.key] === 'auto').map((r) => r.label);
  const req = ROWS.filter((r) => p[r.key] === 'request').map((r) => r.label);
  if (!auto.length && !req.length) return 'No requests';
  if (auto.length === ROWS.length) return 'Auto-approve all';
  return [auto.length ? `Auto: ${auto.join(', ')}` : '', req.length === ROWS.length ? 'Requests need approval' : req.length ? `Request: ${req.join(', ')}` : ''].filter(Boolean).join(' · ');
}
