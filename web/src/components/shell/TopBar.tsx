import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useApp } from '../../state/app';
import { Icon } from '../Icon';
import { Avatar, Dropdown } from '../ui';
import { BrandLogo } from '../BrandLogo';
import { NotificationBell } from '../NotificationBell';
import { ProfileAvatar } from '../ProfileAvatar';
import { openPairDialog } from '../../remote/api';
import { openShortcuts } from '../Shortcuts';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** Profile avatar menu: who is signed in, switch profile, account, devices, admin, sign out. */
export function UserMenu() {
  const { user, logout, features } = useApp();
  const navigate = useNavigate();
  if (!user) return null;
  // Account profiles: "Switch profile" opens "Who's watching?" without signing out.
  const hasProfiles = !!user.parentUserId || !!user.profileCount;
  const name = user.displayName || user.username;
  return (
    <Dropdown
      className="user-menu"
      trigger={({ onClick, open }) => (
        <button className="user-btn" onClick={onClick} aria-label={`Account menu, ${name}`} aria-haspopup="menu" aria-expanded={open} title={name} data-nav>
          {hasProfiles
            ? <ProfileAvatar name={name} url={user.avatarUrl} color={user.profileColor} size={32} kids={false} />
            : <Avatar name={name} url={user.avatarUrl} size={32} />}
          {user.isKids && <span className="user-kids" aria-label="Kids profile">Kids</span>}
        </button>
      )}
      items={[
        { label: <span className="um-profile"><strong>{name}</strong><small>{user.parentUserId ? `${user.isKids ? 'Kids profile' : 'Profile'} · ${user.ownerName}` : user.isAdmin ? 'Administrator' : 'Signed in'}</small></span>, disabled: true },
        ...(hasProfiles ? [{ label: 'Switch profile', icon: 'users' as const, onClick: () => navigate('/profiles') }] : []),
        { label: 'Account & settings', icon: 'settings', onClick: () => navigate('/settings') },
        { divider: true, label: '' },
        { label: 'Your year', icon: 'sparkles', onClick: () => navigate('/wrapped') },
        // Phone remote (QR pairing): the TV shows a code; a phone opens the remote.
        { label: document.documentElement.classList.contains('tv') ? 'Use your phone as remote' : 'Pair a phone as remote', icon: 'device', onClick: openPairDialog },
        { label: 'Remote control', icon: 'tv', onClick: () => navigate('/remote') },
        ...(features.linkCodes && !user.parentUserId ? [{ label: 'Link a device', icon: 'link' as const, onClick: () => navigate('/link') }] : []),
        { label: 'Keyboard shortcuts', icon: 'keyboard', onClick: openShortcuts },
        ...(user.isAdmin ? [{ label: 'Admin dashboard', icon: 'shield' as const, onClick: () => navigate('/admin') }] : []),
        ...(features.profilePicker && !hasProfiles ? [{ label: 'Switch user', icon: 'users' as const, onClick: () => void logout().then(() => navigate('/login?profiles=1')) }] : []),
        { divider: true, label: '' },
        { label: 'Sign out', icon: 'logout', danger: true, onClick: () => void logout().then(() => navigate('/login')) },
      ]}
    />
  );
}

/**
 * Sticky translucent top bar: (phones: menu, back, brand) · global search field (opens the command palette; ⌘K / Ctrl K
 * / "/") · notifications · profile menu. Transparent over a hero until the page scrolls.
 */
export function TopBar({ scrolled, onSearch, onMenu, serverLabel, drawerOpen }: { scrolled: boolean; onSearch: () => void; onMenu: () => void; serverLabel: string; drawerOpen: boolean }) {
  const navigate = useNavigate();
  const loc = useLocation();
  const canGoBack = loc.pathname !== '/' && typeof window !== 'undefined' && window.history.length > 1;
  return (
    <header className={`topbar ${scrolled ? 'scrolled' : ''}`}>
      <div className="topbar-start">
        <button className="btn-icon topbar-menu" onClick={onMenu} aria-label="Menu: libraries and pages" aria-expanded={drawerOpen} title="Menu">
          <Icon name="menu" size={20} />
        </button>
        {canGoBack && (
          <button className="btn-icon topbar-back" onClick={() => navigate(-1)} aria-label="Back" title="Back">
            <Icon name="chevronLeft" size={22} />
          </button>
        )}
        <Link to="/" className="topbar-brand" aria-label={`${serverLabel} home`}>
          <BrandLogo height={24} />
        </Link>
      </div>
      <button className="topbar-search cmd-trigger" onClick={onSearch} aria-label="Search titles, people and pages" aria-haspopup="dialog" aria-keyshortcuts="Control+K Meta+K /" data-nav>
        <Icon name="search" size={17} />
        <span className="topbar-search-text">Search titles, people, pages…</span>
        <kbd className="topbar-kbd">{isMac ? '⌘' : 'Ctrl'} K</kbd>
      </button>
      <div className="topbar-end">
        <NotificationBell />
        <UserMenu />
      </div>
    </header>
  );
}
