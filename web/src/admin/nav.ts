import type { IconName } from '../components/Icon';

export interface AdminNavEntry {
  to: string;
  label: string;
  icon: IconName;
  end?: boolean;
  /** Section heading in the admin side list. */
  group: string;
  /** Extra words for the admin filter and the command palette. */
  keywords?: string;
}

/** Admin pages, for the admin side menu and the command palette (kept out of the lazy admin chunk). */
export const ADMIN_NAV: AdminNavEntry[] = [
  { to: '/admin', label: 'Overview', icon: 'activity', end: true, group: 'Server', keywords: 'dashboard health status now playing streams sessions' },
  { to: '/admin/stats', label: 'Statistics', icon: 'gauge', group: 'Server', keywords: 'charts plays users popular' },
  { to: '/admin/activity', label: 'Activity & logs', icon: 'list', group: 'Server', keywords: 'log errors events audit' },
  { to: '/admin/tasks', label: 'Scheduled tasks', icon: 'clock', group: 'Server', keywords: 'scan jobs cron refresh' },

  { to: '/admin/libraries', label: 'Libraries', icon: 'database', group: 'Media', keywords: 'folders scan movies shows music photos paths' },
  { to: '/admin/storage', label: 'Storage & disks', icon: 'folder', group: 'Media', keywords: 'disk sleep spin down space' },
  { to: '/admin/downloads', label: 'Downloads', icon: 'download', group: 'Media', keywords: 'offline sync' },
  { to: '/admin/import', label: 'Import (Emby, Jellyfin, Plex)', icon: 'inbox', group: 'Media', keywords: 'migrate emby jellyfin plex watched history' },

  { to: '/admin/users', label: 'Users', icon: 'users', group: 'People', keywords: 'accounts permissions parental rating profiles kids' },
  { to: '/admin/invites', label: 'Invites', icon: 'link', group: 'People', keywords: 'invite link sign up' },
  { to: '/admin/devices', label: 'Devices', icon: 'device', group: 'People', keywords: 'sessions clients sign out' },

  { to: '/admin/livetv', label: 'Live TV sources', icon: 'antenna', group: 'Live TV', keywords: 'iptv m3u xtream hdhomerun tuner' },
  { to: '/admin/channels', label: 'Channels', icon: 'tv', group: 'Live TV', keywords: 'numbers logos' },
  { to: '/admin/guide', label: 'TV guide', icon: 'guide', group: 'Live TV', keywords: 'epg xmltv schedules' },

  { to: '/admin/settings?tab=transcoding', label: 'Transcoding', icon: 'zap', group: 'Playback', keywords: 'hardware acceleration gpu nvenc vaapi qsv ffmpeg tone mapping hdr bitrate' },
  { to: '/admin/renderers', label: 'Play to devices', icon: 'cast', group: 'Playback', keywords: 'dlna chromecast renderers' },
  { to: '/admin/ai', label: 'AI', icon: 'sparkles', group: 'Playback', keywords: 'ask recaps subtitles translation llm ollama openai' },

  { to: '/admin/branding', label: 'Branding studio', icon: 'palette', group: 'Look & feel', keywords: 'theme colours logo fonts home rows features custom css login' },

  { to: '/admin/settings', label: 'Server settings', icon: 'server', group: 'System', keywords: 'general metadata tmdb cinema dvr requests notifications arr sonarr radarr sso trickplay subtitles trakt lastfm dlna webhooks karaoke' },
  { to: '/admin/network', label: 'Network & HTTPS', icon: 'link', group: 'System', keywords: 'ports certificate tls proxy' },
  { to: '/admin/remote', label: 'Remote access', icon: 'globe', group: 'System', keywords: 'upnp port forwarding outside' },
  { to: '/admin/security', label: 'Security', icon: 'shield', group: 'System', keywords: 'ban ip failed logins fail2ban' },
  { to: '/admin/updates', label: 'Updates', icon: 'download', group: 'System', keywords: 'upgrade new version release github install' },
  { to: '/admin/backups', label: 'Backups', icon: 'layers', group: 'System', keywords: 'restore export' },
  { to: '/admin/plugins', label: 'Plugins', icon: 'puzzle', group: 'System', keywords: 'extensions repositories' },
  { to: '/admin/smarthome', label: 'Smart home', icon: 'zap', group: 'System', keywords: 'home assistant mqtt webhooks' },
];
