import type React from 'react';
import { Link, Navigate, Route, Routes } from 'react-router-dom';
import { Icon } from '../components/Icon';
import { ADMIN_NAV as NAV } from './nav';
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
import { ServerImportAdmin } from './ServerImport';
import { BackupsAdmin } from './Backups';
import { UpdatesAdmin } from './Updates';
import { RemoteAccessAdmin } from './RemoteAccess';
import { DownloadsAdmin } from './Downloads';
import { RenderersAdmin } from './Renderers';
import { SmartHomeAdmin } from './SmartHome';
import { StorageAdmin } from './Storage';
import { AiSettingsAdmin } from './AiSettings';
import WrappedPage from '../pages/Wrapped';
import { HelpLink } from '../components/HelpLink';
import { SectionNav, type SectionNavGroup } from '../components/SectionNav';


/** The admin pages grouped for the side list (Server, Media, People, Live TV, Playback, Look & feel, System). */
const GROUPS: SectionNavGroup[] = [];
for (const n of NAV) {
  let g = GROUPS.find((x) => x.label === n.group);
  if (!g) GROUPS.push((g = { label: n.group, items: [] }));
  g.items.push(n);
}

export default function AdminRoutes() {
  return (
    <div className="page admin">
      <div className="admin-layout twopane">
        <SectionNav
          title="Admin"
          icon="shield"
          label="Admin"
          groups={GROUPS}
          footer={<Link to="/settings"><Icon name="settings" size={16} /> Your personal settings <Icon name="chevronRight" size={14} /></Link>}
        />
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
            <Route path="import" element={<ServerImportAdmin />} />
            <Route path="import-emby" element={<Navigate to="/admin/import?source=emby" replace />} />
            <Route path="storage" element={<StorageAdmin />} />
            <Route path="ai" element={<AiSettingsAdmin />} />
            <Route path="smarthome" element={<SmartHomeAdmin />} />
            <Route path="renderers" element={<RenderersAdmin />} />
            <Route path="remote" element={<RemoteAccessAdmin />} />
            <Route path="backups" element={<BackupsAdmin />} />
            <Route path="updates" element={<UpdatesAdmin />} />
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
