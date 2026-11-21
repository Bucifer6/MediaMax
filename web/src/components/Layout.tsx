import { djLive } from '../player/djLive';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/app';
import { Icon, type IconName } from './Icon';
import { Avatar, Dropdown, PageLoader } from './ui';
import { BrandLogo } from './BrandLogo';
import { MiniPlayer } from '../player/MiniPlayer';
import { RendererBar } from '../player/RendererBar';
import { useMusic } from '../player/music';
import { isTypingTarget } from '../hooks';
import { useSpatialNav } from '../hooks/spatialNav';
import { isIptvLibrary, libraryIcon } from '../utils/items';
import { openPairDialog } from '../remote/api';
import { api } from '../api/endpoints';
import { canManageRequests, ISSUES_CHANGED, REQUESTS_CHANGED } from '../utils/requests';
import { seerrApi } from '../api/seerr';
import { NotificationBell } from './NotificationBell';
import { ProfileAvatar } from './ProfileAvatar';
import { AmbientLight } from './AmbientLight';
import { PeekLayer } from './Peek';
import { useCardLight } from '../hooks/useCardLight';
import { setAmbient } from '../theme/ambient';
import type { PaletteContext } from './CommandPalette';

// The command palette is only downloaded the first time it's opened.
const CommandPalette = lazy(() => import('./CommandPalette'));

const RAIL_GROUPS_KEY = 'mm.rail.groups';

function NavItem({ to, icon, label, end, badge }: { to: string; icon: IconName; label: ReactNode; end?: boolean; badge?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-nav>
      <span className="nav-icon"><Icon name={icon} size={20} /></span>
      <span className="nav-label">{label}</span>
      {badge}
    </NavLink>
  );
}

/** A collapsible group in the rail (Libraries, Live & IPTV, You). Open state is remembered per device. */
function NavGroup({ id, label, open, onToggle, children }: { id: string; label: string; open: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return (
    <div className={`nav-group ${open ? 'open' : ''}`}>
      <button type="button" className="nav-group-head" aria-expanded={open} aria-controls={`rail-${id}`} onClick={() => onToggle(id)} data-nav>
        <span className="nav-group-line" aria-hidden="true" />
        <span className="nav-group-label">{label}</span>
        <Icon name="chevronDown" size={14} className="nav-group-chev" />
      </button>
      <div className="nav-group-body" id={`rail-${id}`} role="group" aria-label={label} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

function useRailGroups(): [Record<string, boolean>, (id: string) => void] {
  const [groups, setGroups] = useState<Record<string, boolean>>(() => {
    try {
      return { libraries: true, live: true, you: false, ...JSON.parse(localStorage.getItem(RAIL_GROUPS_KEY) || '{}') };
    } catch {
      return { libraries: true, live: true, you: false };
    }
  });
  const toggle = useCallback((id: string) => {
    setGroups((g) => {
      const next = { ...g, [id]: !g[id] };
      try {
        localStorage.setItem(RAIL_GROUPS_KEY, JSON.stringify(next));
      } catch {
        /* storage blocked */
      }
      return next;
    });
  }, []);
  return [groups, toggle];
}

const RAIL_PINNED_KEY = 'mm.rail.pinned';

/** Pinned: the rail stays open with labels and the page makes room for it. Remembered per device. */
function useRailPinned(): [boolean, () => void] {
  const [pinned, setPinned] = useState(() => {
    try {
      return localStorage.getItem(RAIL_PINNED_KEY) === '1';
    } catch {
      return false;
    }
  });
  const toggle = useCallback(() => {
    setPinned((p) => {
      try {
        localStorage.setItem(RAIL_PINNED_KEY, p ? '0' : '1');
      } catch {
        /* storage blocked */
      }
      return !p;
    });
  }, []);
  return [pinned, toggle];
}

export function UserMenu() {
  const { user, logout, features } = useApp();
  const navigate = useNavigate();
  if (!user) return null;
  // Account profiles: "Switch profile" opens "Who's watching?" without signing out.
  const hasProfiles = !!user.parentUserId || !!user.profileCount;
  return (
    <Dropdown
      trigger={({ onClick }) => (
        <button className="user-btn" onClick={onClick} aria-label="Account menu">
          {hasProfiles
            ? <ProfileAvatar name={user.displayName || user.username} url={user.avatarUrl} color={user.profileColor} size={34} />
            : <Avatar name={user.displayName || user.username} url={user.avatarUrl} size={34} />}
        </button>
      )}
      items={[
        { label: <span className="um-profile"><strong>{user.displayName || user.username}</strong>{user.parentUserId && <small>{user.isKids ? 'Kids profile' : 'Profile'} · {user.ownerName}</small>}</span>, disabled: true },
        ...(hasProfiles ? [{ label: 'Switch profile', icon: 'users' as const, onClick: () => navigate('/profiles') }] : []),
        { divider: true, label: '' },
        { label: 'Your year', icon: 'sparkles', onClick: () => navigate('/wrapped') },
        // Phone remote (QR pairing): the TV shows a code; a phone opens the remote.
        { label: document.documentElement.classList.contains('tv') ? 'Use your phone as remote' : 'Pair a phone as remote', icon: 'device', onClick: openPairDialog },
        { label: 'Remote control', icon: 'tv', onClick: () => navigate('/remote') },
        { label: 'Settings', icon: 'settings', onClick: () => navigate('/settings') },
        ...(features.linkCodes && !user.parentUserId ? [{ label: 'Link a device', icon: 'link' as const, onClick: () => navigate('/link') }] : []),
        ...(user.isAdmin ? [{ label: 'Admin dashboard', icon: 'shield' as const, onClick: () => navigate('/admin') }] : []),
        ...(features.profilePicker && !hasProfiles ? [{ label: 'Switch user', icon: 'users' as const, onClick: () => void logout().then(() => navigate('/login?profiles=1')) }] : []),
        { divider: true, label: '' },
        { label: 'Sign out', icon: 'logout', danger: true, onClick: () => void logout().then(() => navigate('/login')) },
      ]}
    />
  );
}

/** Pending request count for admins; refreshed on an interval and whenever requests change. */
function usePendingRequests(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) {
      setN(0);
      return;
    }
    let alive = true;
    const load = () => {
      api.requests.list({ status: 'pending' }).then((l) => alive && setN(l.length)).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 60000);
    window.addEventListener(REQUESTS_CHANGED, load);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener(REQUESTS_CHANGED, load);
    };
  }, [enabled]);
  return n;
}

/** Open issues (all for managers, own for others); refreshed on an interval and whenever issues change. */
function useOpenIssues(enabled: boolean): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!enabled) return setN(0);
    let alive = true;
    const load = () => {
      seerrApi.issueCount().then((r) => alive && setN(r.open)).catch(() => undefined);
    };
    load();
    const t = window.setInterval(load, 120000);
    window.addEventListener(ISSUES_CHANGED, load);
    return () => {
      alive = false;
      window.clearInterval(t);
      window.removeEventListener(ISSUES_CHANGED, load);
    };
  }, [enabled]);
  return n;
}


const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

export function Layout() {
  const { user, libraries, features, branding, wsOpen } = useApp();
  // Live dot on the DJ nav item while a mix plays in the background.
  const [djPlaying, setDjPlaying] = useState(false);
  useEffect(() => djLive.subscribe(setDjPlaying), []);
  const music = useMusic();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [palette, setPalette] = useState<{ open: boolean; loaded: boolean }>({ open: false, loaded: false });
  const [groups, toggleGroup] = useRailGroups();
  const [pinned, togglePinned] = useRailPinned();
  useSpatialNav();
  useCardLight();

  const openPalette = useCallback(() => setPalette({ open: true, loaded: true }), []);
  const closePalette = useCallback(() => setPalette((p) => ({ ...p, open: false })), []);

  useEffect(() => setDrawer(false), [loc.pathname]);
  // Every page starts in the theme's own light; pages with artwork (home hero, title pages) relight it in their effects.
  useLayoutEffect(() => setAmbient(null), [loc.pathname]);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 24);
    h();
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
  }, []);
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [loc.pathname]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      // "/" or Ctrl/⌘+K: the command palette (search titles, jump to pages, run actions).
      const k = e.key.toLowerCase() === 'k' && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey;
      if (k || (e.key === '/' && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey)) {
        if (!k && document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        openPalette();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [openPalette]);

  const local = libraries.filter((l) => !isIptvLibrary(l.type) && l.type !== 'podcasts' && (features.music || l.type !== 'music') && (features.photos || l.type !== 'photos'));
  const iptv = features.iptvVod ? libraries.filter((l) => isIptvLibrary(l.type)) : [];
  const liveTv = features.liveTv && (user?.allowLiveTv ?? true);
  const dvr = features.dvr && (user?.allowDvr ?? true);
  const manager = canManageRequests(user);
  const pending = usePendingRequests(manager && features.requests);
  const openIssues = useOpenIssues(!!user);
  // Kids profiles without any request permission don't see Discover / Requests.
  const kidsNoRequests = !!user?.isKids && !!user.requestPermissions && (['movie', 'show', 'music', 'book'] as const).every((k) => user.requestPermissions![k] === 'none');
  const showRequests = (features.requests && !kidsNoRequests) || pending > 0;
  const showIssues = manager ? openIssues > 0 || features.requests : openIssues > 0;
  const hasProfiles = !!user?.parentUserId || !!user?.profileCount;

  // What the rail shows, so the command palette ("Go to") offers exactly the same destinations.
  const paletteCtx: PaletteContext = { local, iptv, liveTv, dvr, manager, showRequests, showIssues, discover: features.requests && !kidsNoRequests, hasProfiles };

  return (
    <div className={`app-shell ${drawer ? 'drawer-open' : ''} ${pinned ? 'rail-pinned' : ''} ${music.current ? 'has-mini' : ''}`}>
      <AmbientLight />
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className="rail sidebar" aria-label="Main navigation">
        <div className="rail-panel">
          <Link to="/" className="rail-brand sidebar-brand" aria-label={`${branding.serverName || 'Kinora'} home`}>
            <BrandLogo height={30} />
          </Link>
          <nav className="rail-nav">
            <NavItem to="/" end icon="home" label="Home" />
            <NavItem to="/search" icon="search" label="Search" />
            {features.requests && !kidsNoRequests && <NavItem to="/discover" icon="compass" label="Discover" />}
            {showRequests && (
              <NavItem
                to="/requests"
                icon="inbox"
                label={manager ? 'Requests' : 'My requests'}
                badge={pending > 0 ? <span className="nav-count" aria-label={`${pending} pending`}>{pending > 99 ? '99+' : pending}</span> : undefined}
              />
            )}
            {local.length > 0 && (
              <NavGroup id="libraries" label="Libraries" open={!!groups.libraries} onToggle={toggleGroup}>
                {local.map((l) => (
                  <NavItem
                    key={l.id}
                    to={`/library/${l.id}`}
                    icon={libraryIcon(l.type)}
                    label={l.name}
                    badge={l.scanning ? <span className="nav-dot pulse" title="Scanning" /> : undefined}
                  />
                ))}
              </NavGroup>
            )}
            {(liveTv || iptv.length > 0) && (
              <NavGroup id="live" label="Live & IPTV" open={!!groups.live} onToggle={toggleGroup}>
                {liveTv && <NavItem to="/livetv" end icon="tv" label="Live TV" />}
                {liveTv && <NavItem to="/livetv/guide" icon="guide" label="TV Guide" />}
                {liveTv && dvr && <NavItem to="/dvr" icon="recordOutline" label="Recordings" />}
                {iptv.map((l) => (
                  <NavItem key={l.id} to={`/library/${l.id}`} icon={libraryIcon(l.type)} label={l.name} badge={<span className="nav-tag">IPTV</span>} />
                ))}
              </NavGroup>
            )}
            <NavGroup id="you" label="You" open={!!groups.you} onToggle={toggleGroup}>
              <NavItem to="/my-list" icon="plus" label="My List" />
              <NavItem to="/calendar" icon="calendar" label="Calendar" />
              <NavItem to="/roulette" icon="shuffle" label="Roulette" />
              <NavItem to="/match" icon="together" label="Movie Match" />
              {features.music && <NavItem to="/dj" icon="music" label="DJ" badge={djPlaying ? <span className="live-dot" aria-label="Mix playing" /> : undefined} />}
              <NavItem to="/podcasts" icon="podcast" label="Podcasts" />
              <NavItem to="/playlists" icon="playlist" label="Playlists" />
              <NavItem to="/collections" icon="collection" label="Collections" />
              {/* Issues live here rather than in the main list; the count still shows for managers. */}
              {showIssues && (
                <NavItem
                  to="/issues"
                  icon="flag"
                  label={manager ? 'Issues' : 'My issues'}
                  badge={manager && openIssues > 0 ? <span className="nav-count" aria-label={`${openIssues} open`}>{openIssues > 99 ? '99+' : openIssues}</span> : undefined}
                />
              )}
              <NavItem to="/help" icon="help" label="Help" />
            </NavGroup>
          </nav>
          <div className="rail-foot">
            {user?.isAdmin && <NavItem to="/admin" icon="shield" label="Admin" />}
            <NavItem to="/settings" icon="settings" label="Settings" />
            <button type="button" className="nav-item rail-pin" onClick={togglePinned} aria-pressed={pinned} title={pinned ? 'Let the menu hide' : 'Keep the menu open'} data-nav>
              <span className="nav-icon"><Icon name={pinned ? 'lock' : 'menu'} size={20} /></span>
              <span className="nav-label">{pinned ? 'Unpin menu' : 'Pin menu'}</span>
            </button>
            <div className="rail-meta">
              {branding.footerText && <p className="footer-text">{branding.footerText}</p>}
              {branding.supportUrl && (
                <a href={branding.supportUrl} target="_blank" rel="noreferrer" className="footer-link">
                  <Icon name="info" size={14} /> Contact support
                </a>
              )}
              <span className={`ws-status ${wsOpen ? 'on' : ''}`} title={wsOpen ? 'Live updates connected' : 'Live updates disconnected'}>
                <span className="ws-dot" /> {wsOpen ? 'Connected' : 'Offline'}
              </span>
            </div>
          </div>
        </div>
      </aside>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <div className="main-col">
        <header className={`topbar cmdbar ${scrolled ? 'scrolled' : ''}`}>
          <Link to="/" className="topbar-brand" aria-label={`${branding.serverName || 'Kinora'} home`}>
            <BrandLogo height={26} />
          </Link>
          <div className="topbar-spacer" />
          <button className="cmd-trigger" onClick={openPalette} aria-label="Search or jump to" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K /" data-nav>
            <Icon name="search" size={18} />
            <span className="cmd-trigger-text">Search titles, pages, actions…</span>
            <kbd className="cmd-kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd>
          </button>
          <NotificationBell />
          <UserMenu />
        </header>
        <main className="main" id="main" tabIndex={-1}>
          {/* Route chunks load inside the shell: the nav stays put instead of the whole screen blanking. */}
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <PeekLayer />
      <MiniPlayer />
      <RendererBar />
      <nav className="bottom-nav tabbar" aria-label="Quick navigation">
        <NavLink to="/" end className="bn-item">
          <Icon name="home" />
          <span>Home</span>
        </NavLink>
        <button className="bn-item" onClick={openPalette} aria-haspopup="dialog">
          <Icon name="search" />
          <span>Search</span>
        </button>
        {liveTv && (
          <NavLink to="/livetv" className="bn-item">
            <Icon name="tv" />
            <span>Live</span>
          </NavLink>
        )}
        <NavLink to="/my-list" className="bn-item">
          <Icon name="plus" />
          <span>My List</span>
        </NavLink>
        <button className={`bn-item ${drawer ? 'active' : ''}`} onClick={() => setDrawer((d) => !d)} aria-expanded={drawer} aria-label="More: libraries and pages">
          <Icon name="grid" />
          <span>More</span>
        </button>
      </nav>
      {palette.loaded && (
        <Suspense fallback={null}>
          <CommandPalette open={palette.open} onClose={closePalette} ctx={paletteCtx} />
        </Suspense>
      )}
    </div>
  );
}
