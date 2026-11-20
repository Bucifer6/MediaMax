import type { CSSProperties, ReactElement } from 'react';

const P = (d: string) => <path d={d} />;

const ICONS = {
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none" />,
  pause: (
    <>
      <rect x="6" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" rx="1" fill="currentColor" stroke="none" />
    </>
  ),
  home: <>{P('M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z')}</>,
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      {P('m20 20-3.5-3.5')}
    </>
  ),
  tv: (
    <>
      <rect x="2" y="7" width="20" height="14" rx="2" />
      {P('m17 2-5 5-5-5')}
    </>
  ),
  film: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      {P('M7 3v18M17 3v18M3 12h18M3 7.5h4M3 16.5h4M17 7.5h4M17 16.5h4')}
    </>
  ),
  shows: (
    <>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      {P('M8 21h8M12 17v4')}
    </>
  ),
  music: (
    <>
      {P('M9 18V5l12-2v13')}
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </>
  ),
  image: (
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      {P('m21 15-5-5L5 21')}
    </>
  ),
  video: (
    <>
      <rect x="2" y="6" width="14" height="12" rx="2" />
      {P('m22 8-6 4 6 4z')}
    </>
  ),
  grid: (
    <>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <rect x="14" y="14" width="7" height="7" rx="1" />
    </>
  ),
  list: <>{P('M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01')}</>,
  guide: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      {P('M3 9h18M9 9v11M15 9v11')}
    </>
  ),
  record: <circle cx="12" cy="12" r="7" fill="currentColor" />,
  recordOutline: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      {P('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z')}
    </>
  ),
  shield: <>{P('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z')}</>,
  user: (
    <>
      <circle cx="12" cy="8" r="4" />
      {P('M4 21a8 8 0 0 1 16 0')}
    </>
  ),
  users: (
    <>
      <circle cx="9" cy="8" r="4" />
      {P('M2 21a7 7 0 0 1 14 0M16 3.13a4 4 0 0 1 0 7.75M22 21a7 7 0 0 0-4-6.3')}
    </>
  ),
  logout: <>{P('M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9')}</>,
  heart: <>{P('M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z')}</>,
  heartFill: <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z" fill="currentColor" />,
  star: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" />,
  starFill: <path d="m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z" fill="currentColor" />,
  check: <>{P('M20 6 9 17l-5-5')}</>,
  checkCircle: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('m8 12 3 3 5-6')}
    </>
  ),
  plus: <>{P('M12 5v14M5 12h14')}</>,
  minus: <>{P('M5 12h14')}</>,
  x: <>{P('M18 6 6 18M6 6l12 12')}</>,
  chevronLeft: <>{P('m15 18-6-6 6-6')}</>,
  chevronRight: <>{P('m9 18 6-6-6-6')}</>,
  chevronDown: <>{P('m6 9 6 6 6-6')}</>,
  chevronUp: <>{P('m18 15-6-6-6 6')}</>,
  arrowLeft: <>{P('M19 12H5M12 19l-7-7 7-7')}</>,
  more: (
    <>
      <circle cx="5" cy="12" r="1.5" fill="currentColor" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" />
      <circle cx="19" cy="12" r="1.5" fill="currentColor" />
    </>
  ),
  menu: <>{P('M3 6h18M3 12h18M3 18h18')}</>,
  edit: <>{P('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z')}</>,
  trash: <>{P('M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6M10 11v6M14 11v6')}</>,
  refresh: <>{P('M21 12a9 9 0 1 1-2.64-6.36L21 8M21 3v5h-5')}</>,
  upload: <>{P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12')}</>,
  download: <>{P('M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3')}</>,
  folder: <>{P('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z')}</>,
  volume: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" />
      {P('M15.5 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14')}
    </>
  ),
  volumeLow: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" />
      {P('M15.5 8.5a5 5 0 0 1 0 7')}
    </>
  ),
  mute: (
    <>
      <path d="M11 5 6 9H2v6h4l5 4z" fill="currentColor" />
      {P('m23 9-6 6M17 9l6 6')}
    </>
  ),
  fullscreen: <>{P('M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3')}</>,
  fullscreenExit: <>{P('M8 3v3a2 2 0 0 1-2 2H3M21 8h-3a2 2 0 0 1-2-2V3M3 16h3a2 2 0 0 1 2 2v3M16 21v-3a2 2 0 0 1 2-2h3')}</>,
  pip: (
    <>
      <rect x="2" y="4" width="20" height="16" rx="2" />
      <rect x="12" y="11" width="7" height="6" rx="1" fill="currentColor" />
    </>
  ),
  subtitles: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      {P('M7 13h4M13 13h4M7 16h10')}
    </>
  ),
  audio: <>{P('M2 10v4M6 6v12M10 3v18M14 8v8M18 5v14M22 10v4')}</>,
  gauge: <>{P('M12 14l4-4M3.34 19a10 10 0 1 1 17.32 0')}</>,
  skipBack: <>{P('M11 19 2 12l9-7zM22 19l-9-7 9-7z')}</>,
  skipFwd: <>{P('m13 19 9-7-9-7zM2 19l9-7-9-7z')}</>,
  rewind10: (
    <>
      {P('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5')}
      <text x="12" y="15.5" fontSize="7.5" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text>
    </>
  ),
  forward10: (
    <>
      {P('M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5')}
      <text x="12" y="15.5" fontSize="7.5" textAnchor="middle" fill="currentColor" stroke="none" fontWeight="700">10</text>
    </>
  ),
  prev: (
    <>
      <path d="M19 20 9 12l10-8z" fill="currentColor" />
      {P('M5 19V5')}
    </>
  ),
  next: (
    <>
      <path d="m5 4 10 8-10 8z" fill="currentColor" />
      {P('M19 5v14')}
    </>
  ),
  shuffle: <>{P('M16 3h5v5M4 20 21 3M21 16v5h-5M15 15l6 6M4 4l5 5')}</>,
  repeat: <>{P('m17 1 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 23l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3')}</>,
  queue: <>{P('M3 6h13M3 12h13M3 18h9M17 15v6l5-3z')}</>,
  cast: <>{P('M2 16.1A5 5 0 0 1 5.9 20M2 12.05A9 9 0 0 1 9.95 20M2 8V6a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-6')}<circle cx="2" cy="20" r=".5" fill="currentColor" /></>,
  link: <>{P('M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71')}</>,
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      {P('M8 11V7a4 4 0 0 1 8 0v4')}
    </>
  ),
  key: <>{P('M21 2l-2 2m-7.6 7.6a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4')}</>,
  palette: (
    <>
      {P('M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22z')}
      <circle cx="7.5" cy="10.5" r="1.2" fill="currentColor" />
      <circle cx="11" cy="6.8" r="1.2" fill="currentColor" />
      <circle cx="16" cy="8" r="1.2" fill="currentColor" />
    </>
  ),
  device: (
    <>
      <rect x="5" y="2" width="14" height="20" rx="2" />
      {P('M12 18h.01')}
    </>
  ),
  monitor: (
    <>
      <rect x="2" y="3" width="20" height="14" rx="2" />
      {P('M8 21h8M12 17v4')}
    </>
  ),
  activity: <>{P('M22 12h-4l-3 9L9 3l-3 9H2')}</>,
  clock: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('M12 6v6l4 2')}
    </>
  ),
  calendar: (
    <>
      <rect x="3" y="4" width="18" height="18" rx="2" />
      {P('M16 2v4M8 2v4M3 10h18')}
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5" rx="9" ry="3" />
      {P('M21 12c0 1.66-4 3-9 3s-9-1.34-9-3M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5')}
    </>
  ),
  antenna: <>{P('M2 12 7 2M7 12l5-10M12 12l5-10M17 12l5-10M4.5 7h15M12 16v6')}</>,
  zap: <path d="M13 2 3 14h9l-1 8 10-12h-9z" />,
  info: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('M12 16v-4M12 8h.01')}
    </>
  ),
  help: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01')}
    </>
  ),
  keyboard: (
    <>
      <rect x="2" y="5" width="20" height="14" rx="2" />
      {P('M6 9h.01M10 9h.01M14 9h.01M18 9h.01M6 13h.01M18 13h.01M10 13h4M7 16h10')}
    </>
  ),
  alert: (
    <>
      {P('M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01')}
    </>
  ),
  eye: (
    <>
      {P('M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z')}
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  eyeOff: <>{P('M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24M1 1l22 22')}</>,
  drag: (
    <>
      {[6, 12, 18].map((y) => (
        <g key={y}>
          <circle cx="9" cy={y} r="1.3" fill="currentColor" stroke="none" />
          <circle cx="15" cy={y} r="1.3" fill="currentColor" stroke="none" />
        </g>
      ))}
    </>
  ),
  sort: <>{P('M3 6h18M6 12h12M10 18h4')}</>,
  filter: <>{P('M22 3H2l8 9.46V19l4 2v-8.54z')}</>,
  layers: <>{P('m12 2 10 5-10 5L2 7zM2 17l10 5 10-5M2 12l10 5 10-5')}</>,
  rows: (
    <>
      <rect x="3" y="4" width="18" height="6" rx="1" />
      <rect x="3" y="14" width="18" height="6" rx="1" />
    </>
  ),
  code: <>{P('m16 18 6-6-6-6M8 6l-6 6 6 6')}</>,
  type: <>{P('M4 7V4h16v3M9 20h6M12 4v16')}</>,
  flag: <>{P('M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zM4 22v-7')}</>,
  server: (
    <>
      <rect x="2" y="2" width="20" height="8" rx="2" />
      <rect x="2" y="14" width="20" height="8" rx="2" />
      {P('M6 6h.01M6 18h.01')}
    </>
  ),
  globe: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('M2 12h20M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z')}
    </>
  ),
  sparkles: <>{P('M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9zM19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9zM5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6z')}</>,
  collection: (
    <>
      <rect x="2" y="7" width="14" height="14" rx="2" />
      {P('M6 3h14a2 2 0 0 1 2 2v12')}
    </>
  ),
  playlist: <>{P('M3 6h12M3 12h12M3 18h8M19 9v9')}<circle cx="16.5" cy="18" r="2.5" /></>,
  together: (
    <>
      <circle cx="8" cy="9" r="3" />
      <circle cx="16" cy="9" r="3" />
      {P('M2 20a6 6 0 0 1 12 0M10 20a6 6 0 0 1 12 0')}
    </>
  ),
  speed: <>{P('M12 12 17 7M20.5 16a9 9 0 1 0-17 0')}</>,
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      {P('M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1')}
    </>
  ),
  external: <>{P('M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3')}</>,
  book: <>{P('M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5M8 7h8')}</>,
  podcast: (
    <>
      <circle cx="12" cy="11" r="2" />
      {P('M12 13v8M8.5 15.5a5 5 0 1 1 7 0M5.6 18.4a9 9 0 1 1 12.8 0')}
    </>
  ),
  chapters: <>{P('M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01')}</>,
  lyrics: <>{P('M4 6h10M4 10h10M4 14h6M18 4v11.5M18 15.5a2.5 2.5 0 1 1-2.5-2.5H18')}</>,
  compass: (
    <>
      <circle cx="12" cy="12" r="9" />
      {P('m15.5 8.5-2 5-5 2 2-5z')}
    </>
  ),
  inbox: <>{P('M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z')}</>,
  wand: <>{P('M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M17.8 6.2 19 5M12.2 6.2 11 5M15 9l-12 12')}</>,
  puzzle: <>{P('M19.44 12.33a1.9 1.9 0 0 0-.5-1.53l-1.57-1.57a.94.94 0 0 1-.27-.71c.02-.43.36-.78.7-1.04a2.5 2.5 0 1 0-3.5-3.5c-.26.34-.6.68-1.04.7a.94.94 0 0 1-.71-.27L11 2.84a1.9 1.9 0 0 0-2.69 0L6.73 4.4a.94.94 0 0 0-.27.71c.02.43.36.78.7 1.04a2.5 2.5 0 1 1-3.5 3.5c-.26-.34-.6-.68-1.04-.7a.94.94 0 0 0-.69.27l-.2.2a1.9 1.9 0 0 0 0 2.69l1.57 1.57c.18.18.28.44.27.71-.02.43-.36.78-.7 1.04a2.5 2.5 0 1 0 3.5 3.5c.26-.34.6-.68 1.04-.7.27-.01.53.09.71.27l1.57 1.57a1.9 1.9 0 0 0 2.69 0l1.57-1.57a.94.94 0 0 0 .27-.71c-.02-.43-.36-.78-.7-1.04a2.5 2.5 0 1 1 3.5-3.5c.26.34.6.68 1.04.7a.94.94 0 0 0 .71-.27l1.57-1.57c.31-.31.47-.72.5-1.16z')}</>,
  bell: <>{P('M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10.3 21a1.94 1.94 0 0 0 3.4 0')}</>,
  thumbUp: <>{P('M7 10v12M15 5.88 14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88z')}</>,
  thumbDown: <>{P('M17 14V2M9 18.12 10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88z')}</>,
  ban: (
    <>
      <circle cx="12" cy="12" r="10" />
      {P('m4.9 4.9 14.2 14.2')}
    </>
  ),
  trending: <>{P('m22 7-8.5 8.5-5-5L2 17M16 7h6v6')}</>,
} satisfies Record<string, ReactElement>;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, className, style, title }: { name: IconName; size?: number; className?: string; style?: CSSProperties; title?: string }) {
  return (
    <svg
      className={'icon' + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.9}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      style={style}
    >
      {title && <title>{title}</title>}
      {ICONS[name]}
    </svg>
  );
}
