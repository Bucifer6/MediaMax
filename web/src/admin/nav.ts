import type { IconName } from '../components/Icon';

/** Admin pages, for the admin side menu and the command palette (kept out of the lazy admin chunk). */
export const ADMIN_NAV: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/admin', label: 'Overview', icon: 'activity', end: true },
  { to: '/admin/libraries', label: 'Libraries', icon: 'database' },
  { to: '/admin/stats', label: 'Statistics', icon: 'gauge' },
  { to: '/admin/users', label: 'Users', icon: 'users' },
  { to: '/admin/invites', label: 'Invites', icon: 'link' },
  { to: '/admin/livetv', label: 'Live TV sources', icon: 'antenna' },
  { to: '/admin/channels', label: 'Channels', icon: 'tv' },
  { to: '/admin/guide', label: 'TV guide', icon: 'guide' },
  { to: '/admin/downloads', label: 'Downloads', icon: 'download' },
  { to: '/admin/branding', label: 'Branding studio', icon: 'palette' },
  { to: '/admin/settings', label: 'Server settings', icon: 'server' },
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
