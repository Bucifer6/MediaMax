import { useState } from 'react';
import type { Device } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { Badge, EmptyState, ErrorState, Skeleton, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';
import { AdminHeader } from './AdminRoutes';

export function DevicesAdmin() {
  const toast = useToast();
  const confirm = useConfirm();
  const devices = useAsync(() => api.auth.devices(true), []);
  const [q, setQ] = useState('');
  const revoke = async (d: Device) => {
    if (!(await confirm({ title: `Revoke ${d.deviceName}?`, message: `${d.userName} will be signed out on this device.`, confirmLabel: 'Revoke', danger: true }))) return;
    try {
      await api.auth.revokeDevice(d.id);
      devices.setData((l) => (l ?? []).filter((x) => x.id !== d.id));
    } catch (e) {
      toast.error(e);
    }
  };
  const list = (devices.data ?? []).filter((d) => !q || `${d.deviceName} ${d.userName} ${d.platform}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt));
  return (
    <div>
      <AdminHeader title="Devices" subtitle="Every signed-in app and browser across all users." />
      <div className="toolbar"><div className="search-mini"><Icon name="search" size={16} /><input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter devices" /></div></div>
      {devices.loading && !devices.data ? <Skeleton h={300} /> : devices.error ? <ErrorState message={devices.error} onRetry={devices.reload} /> : !list.length ? <EmptyState icon="device" title="No devices" /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Device</th><th>User</th><th>Platform</th><th>Last seen</th><th /></tr></thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id}>
                  <td><div className="user-cell"><Icon name={d.platform === 'web' ? 'monitor' : d.platform === 'ios' || d.platform === 'android' ? 'device' : 'tv'} size={20} /> <span>{d.deviceName} {d.current && <Badge tone="success">This device</Badge>}</span></div></td>
                  <td>{d.userName}</td>
                  <td className="muted">{d.platform}{d.appVersion ? ` · v${d.appVersion}` : ''}</td>
                  <td className="muted">{relativeTime(d.lastSeenAt)}</td>
                  <td className="td-actions">{!d.current && <button className="btn btn-ghost btn-sm" onClick={() => revoke(d)}>Revoke</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
