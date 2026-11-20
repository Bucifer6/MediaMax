import { djEngine } from '../player/djEngine';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../state/app';
import { Icon, type IconName } from './Icon';
import { Avatar, Dropdown } from './ui';
import { BrandLogo } from './BrandLogo';
import { MiniPlayer } from '../player/MiniPlayer';
import { useMusic } from '../player/music';
import { isTypingTarget } from '../hooks';
import { useSpatialNav } from '../hooks/spatialNav';
import { isIptvLibrary, libraryIcon } from '../utils/items';
import { api } from '../api/endpoints';
import { REQUESTS_CHANGED } from '../utils/requests';
import { NotificationBell } from './NotificationBell';

function NavItem({ to, icon, label, end, badge }: { to: string; icon: IconName; label: ReactNode; end?: boolean; badge?: ReactNode }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} data-nav>
      <Icon name={icon} size={20} />
      <span className="nav-label">{label}</span>
      {badge}
    </NavLink>
  );
}

export function UserMenu() {
  const { user, logout, features } = useApp();
  const navigate = useNavigate();
  if (!user) return null;
  return (
    <Dropdown
      trigger={({ onClick }) => (
        <button className="user-btn" onClick={onClick} aria-label="Account menu">
          <Avatar name={user.displayName || user.username} url={user.avatarUrl} size={34} />
        </button>
      )}
      items={[
        { label: <strong>{user.displayName || user.username}</strong>, disabled: true },
        { divider: true, label: '' },
        { label: 'Your year', icon: 'sparkles', onClick: () => navigate('/wrapped') },
        { label: 'Settings', icon: 'settings', onClick: () => navigate('/settings') },
        ...(features.linkCodes ? [{ label: 'Link a device', icon: 'link' as const, onClick: () => navigate('/link') }] : []),
        ...(user.isAdmin ? [{ label: 'Admin dashboard', icon: 'shield' as const, onClick: () => navigate('/admin') }] : []),
        ...(features.profilePicker ? [{ label: 'Switch profile', icon: 'users' as const, onClick: () => void logout().then(() => navigate('/login?profiles=1')) }] : []),
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

export function Layout() {
  const { user, libraries, features, branding, wsOpen } = useApp();
  // Live dot on the DJ nav item while a mix plays in the background.
  const [djLive, setDjLive] = useState(false);
  useEffect(() => djEngine().subscribe((st) => setDjLive(st.status === 'playing')), []);
  const music = useMusic();
  const navigate = useNavigate();
  const loc = useLocation();
  const [drawer, setDrawer] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  useSpatialNav();

  useEffect(() => setDrawer(false), [loc.pathname]);
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
      if (e.key === '/' && !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        navigate('/search');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [navigate]);

  const local = libraries.filter((l) => !isIptvLibrary(l.type) && l.type !== 'podcasts' && (features.music || l.type !== 'music') && (features.photos || l.type !== 'photos'));
  const iptv = features.iptvVod ? libraries.filter((l) => isIptvLibrary(l.type)) : [];
  const liveTv = features.liveTv && (user?.allowLiveTv ?? true);
  const dvr = features.dvr && (user?.allowDvr ?? true);
  const pending = usePendingRequests(!!user?.isAdmin && features.requests);

  return (
    <div className={`app-shell ${drawer ? 'drawer-open' : ''} ${music.current ? 'has-mini' : ''}`}>
      <aside className="sidebar" aria-label="Main navigation">
        <Link to="/" className="sidebar-brand">
          <BrandLogo height={30} />
        </Link>
        <nav className="sidebar-nav">
          <NavItem to="/" end icon="home" label="Home" />
          <NavItem to="/search" icon="search" label="Search" />
          {features.requests && <NavItem to="/discover" icon="compass" label="Discover" />}
          {(features.requests || pending > 0) && (
            <NavItem
              to="/requests"
              icon="inbox"
              label={user?.isAdmin ? 'Requests' : 'My requests'}
              badge={pending > 0 ? <span className="nav-count" aria-label={`${pending} pending`}>{pending > 99 ? '99+' : pending}</span> : undefined}
            />
          )}
          {local.length > 0 && <div className="nav-section">Libraries</div>}
          {local.map((l) => (
            <NavItem
              key={l.id}
              to={`/library/${l.id}`}
              icon={libraryIcon(l.type)}
              label={l.name}
              badge={l.scanning ? <span className="nav-dot pulse" title="Scanning" /> : undefined}
            />
          ))}
          {(liveTv || iptv.length > 0) && <div className="nav-section">Live & IPTV</div>}
          {liveTv && <NavItem to="/livetv" end icon="tv" label="Live TV" />}
          {liveTv && <NavItem to="/livetv/guide" icon="guide" label="TV Guide" />}
          {liveTv && dvr && <NavItem to="/dvr" icon="recordOutline" label="Recordings" />}
          {iptv.map((l) => (
            <NavItem key={l.id} to={`/library/${l.id}`} icon={libraryIcon(l.type)} label={l.name} badge={<span className="nav-tag">IPTV</span>} />
          ))}
          <div className="nav-section">You</div>
          <NavItem to="/my-list" icon="plus" label="My List" />
          <NavItem to="/calendar" icon="calendar" label="Calendar" />
          {features.music && <NavItem to="/dj" icon="music" label="DJ" badge={djLive ? <span className="live-dot" aria-label="Mix playing" /> : undefined} />}
          <NavItem to="/podcasts" icon="podcast" label="Podcasts" />
          <NavItem to="/playlists" icon="playlist" label="Playlists" />
          <NavItem to="/collections" icon="collection" label="Collections" />
          {user?.isAdmin && <NavItem to="/admin" icon="shield" label="Admin" />}
        </nav>
        <div className="sidebar-foot">
          {branding.footerText && <p className="footer-text">{branding.footerText}</p>}
          {branding.supportUrl && (
            <a href={branding.supportUrl} target="_blank" rel="noreferrer" className="footer-link">
              <Icon name="info" size={14} /> Help & support
            </a>
          )}
          <span className={`ws-status ${wsOpen ? 'on' : ''}`} title={wsOpen ? 'Live updates connected' : 'Live updates disconnected'}>
            <span className="ws-dot" /> {wsOpen ? 'Connected' : 'Offline'}
          </span>
        </div>
      </aside>
      <div className="drawer-scrim" onClick={() => setDrawer(false)} />
      <div className="main-col">
        <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
          <button className="btn-icon topbar-menu" onClick={() => setDrawer((d) => !d)} aria-label="Menu">
            <Icon name="menu" />
          </button>
          <Link to="/" className="topbar-brand">
            <BrandLogo height={26} />
          </Link>
          <div className="topbar-spacer" />
          <button className="topbar-search" onClick={() => navigate('/search')} aria-label="Search">
            <Icon name="search" size={18} />
            <span>Search</span>
            <kbd>/</kbd>
          </button>
          <NotificationBell />
          <UserMenu />
        </header>
        <main className="main" id="main">
          <Outlet />
        </main>
      </div>
      <MiniPlayer />
      <nav className="bottom-nav" aria-label="Quick navigation">
        <NavLink to="/" end className="bn-item">
          <Icon name="home" />
          <span>Home</span>
        </NavLink>
        <NavLink to="/search" className="bn-item">
          <Icon name="search" />
          <span>Search</span>
        </NavLink>
        {liveTv && (
          <NavLink to="/livetv" className="bn-item">
            <Icon name="tv" />
            <span>Live</span>
          </NavLink>
        )}
        <button className="bn-item" onClick={() => setDrawer(true)}>
          <Icon name="grid" />
          <span>Library</span>
        </button>
        <NavLink to="/settings" className="bn-item">
          <Icon name="user" />
          <span>Me</span>
        </NavLink>
      </nav>
    </div>
  );
}
