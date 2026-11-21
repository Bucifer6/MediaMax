import type React from 'react';
import { NavLink, Route, Routes } from 'react-router-dom';
import { Icon, type IconName } from '../components/Icon';
import { Overview } from './Overview';
import { LibrariesAdmin } from './Libraries';
import { UsersAdmin } from './Users';
import { LiveSourcesAdmin } from './LiveSources';
import { ChannelsAdmin } from './Channels';
import { GuideAdmin } from './GuideAdmin';
import { BrandingStudio } from './Branding';
import { ServerSettingsAdmin } from './ServerSettings';
import { TasksAdmin } from './Tasks';
import { ActivityAdmin } from './Activity';
import { SecurityAdmin } from './Security';
import { NetworkAdmin } from './Network';
import { DevicesAdmin } from './Devices';
import { StatsAdmin } from './Stats';
import { PluginsAdmin } from './Plugins';
import { InvitesAdmin } from './Invites';
import { EmbyImportAdmin } from './EmbyImport';
import { BackupsAdmin } from './Backups';
import { RemoteAccessAdmin } from './RemoteAccess';
import { DownloadsAdmin } from './Downloads';
import { RenderersAdmin } from './Renderers';
import { SmartHomeAdmin } from './SmartHome';
import { StorageAdmin } from './Storage';
import { AiSettingsAdmin } from './AiSettings';
import WrappedPage from '../pages/Wrapped';
import { HelpLink } from '../components/HelpLink';

const NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', icon: 'activity', end: true },
  { to: '/admin/libraries', label: 'Libraries', icon: 'database' },
  { to: '/admin/stats', label: 'Statistics', icon: 'gauge' },
  { to: '/admin/users', label: 'Users', icon: 'users' },
  { to: '/admin/invites', label: 'Invites', icon: 'link' },
  { to: '/admin/import-emby', label: 'Import from Emby', icon: 'inbox' },
  { to: '/admin/livetv', label: 'Live TV sources', icon: 'antenna' },
  { to: '/admin/channels', label: 'Channels', icon: 'tv' },
  { to: '/admin/guide', label: 'TV guide', icon: 'guide' },
  { to: '/admin/downloads', label: 'Downloads', icon: 'download' },
  { to: '/admin/branding', label: 'Branding studio', icon: 'palette' },
  { to: '/admin/settings', label: 'Server settings', icon: 'server' },
  { to: '/admin/ai', label: 'AI', icon: 'sparkles' },
  { to: '/admin/storage', label: 'Storage & disks', icon: 'folder' },
  { to: '/admin/smarthome', label: 'Smart home', icon: 'zap' },
  { to: '/admin/renderers', label: 'Play to devices', icon: 'cast' },
  { to: '/admin/remote', label: 'Remote access', icon: 'globe' },
  { to: '/admin/network', label: 'Network & HTTPS', icon: 'link' },
  { to: '/admin/security', label: 'Security', icon: 'shield' },
  { to: '/admin/backups', label: 'Backups', icon: 'layers' },
  { to: '/admin/plugins', label: 'Plugins', icon: 'puzzle' },
  { to: '/admin/tasks', label: 'Scheduled tasks', icon: 'clock' },
  { to: '/admin/activity', label: 'Activity & logs', icon: 'list' },
  { to: '/admin/devices', label: 'Devices', icon: 'device' },
];

export default function AdminRoutes() {
  return (
    <div className="page admin">
      <div className="admin-layout">
        <nav className="admin-nav" aria-label="Admin">
          <div className="admin-nav-title"><Icon name="shield" size={18} /> Admin</div>
          {NAV.map((n) => (
            <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => `admin-link ${isActive ? 'active' : ''}`}>
              <Icon name={n.icon} size={18} /> <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="admin-content">
          <Routes>
            <Route index element={<Overview />} />
            <Route path="libraries" element={<LibrariesAdmin />} />
            <Route path="stats" element={<StatsAdmin />} />
            <Route path="users" element={<UsersAdmin />} />
            <Route path="users/:userId/wrapped" element={<WrappedPage />} />
            <Route path="livetv" element={<LiveSourcesAdmin />} />
            <Route path="channels" element={<ChannelsAdmin />} />
            <Route path="guide" element={<GuideAdmin />} />
            <Route path="branding" element={<BrandingStudio />} />
            <Route path="settings" element={<ServerSettingsAdmin />} />
            <Route path="downloads" element={<DownloadsAdmin />} />
            <Route path="invites" element={<InvitesAdmin />} />
            <Route path="import-emby" element={<EmbyImportAdmin />} />
            <Route path="storage" element={<StorageAdmin />} />
            <Route path="ai" element={<AiSettingsAdmin />} />
            <Route path="smarthome" element={<SmartHomeAdmin />} />
            <Route path="renderers" element={<RenderersAdmin />} />
            <Route path="remote" element={<RemoteAccessAdmin />} />
            <Route path="backups" element={<BackupsAdmin />} />
            <Route path="plugins" element={<PluginsAdmin />} />
            <Route path="tasks" element={<TasksAdmin />} />
            <Route path="activity" element={<ActivityAdmin />} />
            <Route path="security" element={<SecurityAdmin />} />
            <Route path="network" element={<NetworkAdmin />} />
            <Route path="devices" element={<DevicesAdmin />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export function AdminHeader({ title, subtitle, actions, help }: { title: string; subtitle?: string; actions?: React.ReactNode; /** Help Centre article slug for the "?" button. */ help?: string }) {
  return (
    <header className="admin-head">
      <div>
        <h1>{title}{help && <HelpLink slug={help} label={title} />}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row-gap">{actions}</div>}
    </header>
  );
}
