import { Link } from 'react-router-dom';
import type { DownloadRule } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, Skeleton, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { groupRulesByDevice, ruleSummary } from '../utils/downloadRules';

/** Settings → Downloads: smart download rules of every device (set up in the mobile apps), read-only + remove. */
export function DownloadRulesSettings() {
  const toast = useToast();
  const confirm = useConfirm();
  const rules = useAsync(() => api.downloads.rules(), []);
  const remove = async (r: DownloadRule) => {
    if (!(await confirm({ title: `Stop smart downloads of ${r.showTitle} on ${r.deviceName}?`, message: 'Episodes already downloaded stay on the device until they are deleted there.', confirmLabel: 'Stop', danger: true }))) return;
    try {
      await api.downloads.removeRule(r.id);
      rules.setData((l) => (l ?? []).filter((x) => x.id !== r.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const groups = groupRulesByDevice(rules.data ?? []);
  return (
    <div className="settings-card">
      <h2>Smart downloads</h2>
      <p className="muted">Phones and tablets keep the next unwatched episodes of these shows downloaded and delete watched ones. Rules are set up in the mobile app, from a show&apos;s page.</p>
      {rules.loading && !rules.data ? <Skeleton h={120} /> : !groups.length ? <p className="muted">No smart downloads on any device.</p> : groups.map((g) => (
        <section key={g.deviceId} className="download-rules-device">
          <h3><Icon name={g.platform === 'ios' || g.platform === 'android' ? 'device' : 'tv'} size={18} /> {g.deviceName}</h3>
          <ul className="device-list">
            {g.rules.map((r) => (
              <li key={r.id}>
                <Icon name="download" size={20} />
                <div>
                  <Link to={`/item/${r.showId}`}><strong>{r.showTitle}</strong></Link>
                  {r.chargingOnly && <> <Badge>Charging only</Badge></>}
                  <div className="muted">{ruleSummary(r)}{r.lastSyncAt ? ` · checked ${relativeTime(r.lastSyncAt)}` : ' · not checked yet'}</div>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={() => remove(r)}>Remove</button>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
