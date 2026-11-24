import { useState, type ReactNode } from 'react';
import { Link, NavLink } from 'react-router-dom';
import type { Library } from '@mediamax/shared';
import { Icon, type IconName } from '../Icon';
import { BrandLogo } from '../BrandLogo';
import { libraryIcon } from '../../utils/items';

/** One sidebar destination. Collapsed (icon rail) the label becomes the tooltip. */
export function NavItem({ to, icon, label, end, badge, title }: { to: string; icon: IconName; label: string; end?: boolean; badge?: ReactNode; title?: string }) {
  return (
    <NavLink to={to} end={end} className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`} title={title ?? label} data-nav>
      <span className="nav-icon"><Icon name={icon} size={20} /></span>
      <span className="nav-label">{label}</span>
      {badge}
    </NavLink>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="nav-section-head">
      <span className="nav-section-label">{children}</span>
      {action}
    </div>
  );
}

/** A collapsible group ("More"). Open state is remembered per device. */
function NavGroup({ id, label, icon, open, onToggle, children }: { id: string; label: string; icon: IconName; open: boolean; onToggle: (id: string) => void; children: ReactNode }) {
  return (
    <div className={`nav-group ${open ? 'open' : ''}`}>
      <button type="button" className="nav-item nav-group-head" aria-expanded={open} aria-controls={`nav-${id}`} onClick={() => onToggle(id)} title={label} data-nav>
        <span className="nav-icon"><Icon name={icon} size={20} /></span>
        <span className="nav-label">{label}</span>
        <Icon name="chevronDown" size={16} className="nav-group-chev" />
      </button>
      <div className="nav-group-body" id={`nav-${id}`} role="group" aria-label={label} hidden={!open}>
        {children}
      </div>
    </div>
  );
}

/** Reorder the pinned libraries: up / down buttons per row (keyboard friendly), Done / Reset. */
function LibraryEditor({ libraries, onSave, onReset, onDone }: { libraries: Library[]; onSave: (ids: string[]) => void; onReset: () => void; onDone: () => void }) {
  const [ids, setIds] = useState(() => libraries.map((l) => l.id));
  const byId = new Map(libraries.map((l) => [l.id, l]));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= ids.length) return;
    const next = [...ids];
    [next[i], next[j]] = [next[j]!, next[i]!];
    setIds(next);
    onSave(next);
  };
  return (
    <div className="nav-edit" role="group" aria-label="Reorder libraries">
      <ol className="nav-edit-list">
        {ids.map((id, i) => {
          const l = byId.get(id);
          if (!l) return null;
          return (
            <li key={id} className="nav-edit-row">
              <span className="nav-icon"><Icon name={libraryIcon(l.type)} size={18} /></span>
              <span className="nav-label">{l.name}</span>
              <button type="button" className="btn-icon btn-icon-sm" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move ${l.name} up`}>
                <Icon name="chevronUp" size={16} />
              </button>
              <button type="button" className="btn-icon btn-icon-sm" onClick={() => move(i, 1)} disabled={i === ids.length - 1} aria-label={`Move ${l.name} down`}>
                <Icon name="chevronDown" size={16} />
              </button>
            </li>
          );
        })}
      </ol>
      <div className="nav-edit-actions">
        <button type="button" className="btn btn-xs btn-ghost" onClick={() => { onReset(); onDone(); }}>Reset</button>
        <button type="button" className="btn btn-xs btn-primary" onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

export interface SidebarModel {
  libraries: Library[];
  iptv: Library[];
  liveTv: boolean;
  dvr: boolean;
  music: boolean;
  djPlaying: boolean;
  showRequests: boolean;
  requestsLabel: string;
  pending: number;
  discover: boolean;
  showIssues: boolean;
  issuesLabel: string;
  openIssues: number;
  isAdmin: boolean;
  serverLabel: string;
  footerText?: string;
  supportUrl?: string | null;
  wsOpen: boolean;
}

const count = (n: number, what: string) => (n > 0 ? <span className="nav-count" aria-label={`${n} ${what}`}>{n > 99 ? '99+' : n}</span> : undefined);

/**
 * The Vibe sidebar: 248 px with labels, or a 72 px icon rail when collapsed (desktop), an off-canvas drawer under
 * 900 px. Home · Search · My List, the viewer's libraries in their own order (Edit), Live TV, listening and requests,
 * a "More" group for everything else, then Settings / Admin / Help and the collapse toggle.
 */
export function Sidebar({
  model, collapsed, onToggleCollapsed, groups, onToggleGroup, onSaveOrder, onResetOrder,
}: {
  model: SidebarModel; collapsed: boolean; onToggleCollapsed: () => void; groups: Record<string, boolean>; onToggleGroup: (id: string) => void;
  onSaveOrder: (ids: string[]) => void; onResetOrder: () => void;
}) {
  const m = model;
  const [editing, setEditing] = useState(false);
  const hasLive = m.liveTv || m.iptv.length > 0;
  return (
    <aside className="sidebar rail" aria-label="Main navigation">
      <div className="sidebar-head">
        <Link to="/" className="sidebar-brand rail-brand" aria-label={`${m.serverLabel} home`} title={m.serverLabel}>
          <span className="brand-full"><BrandLogo height={26} /></span>
          <span className="brand-compact"><BrandLogo height={28} wide={false} /></span>
        </Link>
      </div>
      <nav className="sidebar-nav rail-nav">
        <div className="nav-section">
          <NavItem to="/" end icon="home" label="Home" />
          <NavItem to="/search" icon="search" label="Search" />
          <NavItem to="/my-list" icon="plus" label="My List" />
        </div>

        {m.libraries.length > 0 && (
          <div className="nav-section">
            <SectionLabel
              action={m.libraries.length > 1 && !collapsed && (
                <button type="button" className="nav-section-action" onClick={() => setEditing((e) => !e)} aria-pressed={editing} title="Reorder your libraries">
                  {editing ? 'Done' : 'Edit'}
                </button>
              )}
            >
              Libraries
            </SectionLabel>
            {editing && !collapsed ? (
              <LibraryEditor libraries={m.libraries} onSave={onSaveOrder} onReset={onResetOrder} onDone={() => setEditing(false)} />
            ) : (
              m.libraries.map((l) => (
                <NavItem
                  key={l.id}
                  to={`/library/${l.id}`}
                  icon={libraryIcon(l.type)}
                  label={l.name}
                  badge={l.scanning ? <span className="nav-dot pulse" title="Scanning" /> : undefined}
                />
              ))
            )}
          </div>
        )}

        {hasLive && (
          <div className="nav-section">
            <SectionLabel>Live</SectionLabel>
            {m.liveTv && <NavItem to="/livetv" end icon="tv" label="Live TV" />}
            {m.liveTv && <NavItem to="/livetv/guide" icon="guide" label="Guide" />}
            {m.liveTv && m.dvr && <NavItem to="/dvr" icon="recordOutline" label="Recordings" />}
            {m.iptv.map((l) => (
              <NavItem key={l.id} to={`/library/${l.id}`} icon={libraryIcon(l.type)} label={l.name} badge={<span className="nav-tag">IPTV</span>} />
            ))}
          </div>
        )}

        <div className="nav-section">
          <SectionLabel>Listen & discover</SectionLabel>
          {m.music && <NavItem to="/dj" icon="music" label="DJ" badge={m.djPlaying ? <span className="live-dot nav-live" aria-label="Mix playing" /> : undefined} />}
          <NavItem to="/podcasts" icon="podcast" label="Podcasts" />
          {m.showRequests && <NavItem to="/requests" icon="inbox" label={m.requestsLabel} badge={count(m.pending, 'pending')} />}
          {m.discover && <NavItem to="/discover" icon="compass" label="Discover" />}
          <NavGroup id="more" label="More" icon="grid" open={!!groups.more} onToggle={onToggleGroup}>
            <NavItem to="/calendar" icon="calendar" label="Calendar" />
            <NavItem to="/playlists" icon="playlist" label="Playlists" />
            <NavItem to="/collections" icon="collection" label="Collections" />
            <NavItem to="/roulette" icon="shuffle" label="Roulette" />
            <NavItem to="/match" icon="together" label="Movie Match" />
            {m.showIssues && <NavItem to="/issues" icon="flag" label={m.issuesLabel} badge={count(m.openIssues, 'open')} />}
          </NavGroup>
        </div>
      </nav>
      <div className="sidebar-foot">
        <NavItem to="/settings" icon="settings" label="Settings" />
        {m.isAdmin && <NavItem to="/admin" icon="shield" label="Admin" />}
        <NavItem to="/help" icon="help" label="Help" />
        <div className="sidebar-meta">
          {m.footerText && <p className="footer-text">{m.footerText}</p>}
          {m.supportUrl && (
            <a href={m.supportUrl} target="_blank" rel="noreferrer" className="footer-link">
              <Icon name="info" size={13} /> Contact support
            </a>
          )}
          <div className="sidebar-meta-row">
            <span className={`ws-status ${m.wsOpen ? 'on' : ''}`} title={m.wsOpen ? 'Live updates connected' : 'Live updates disconnected'}>
              <span className="ws-dot" /> <span className="ws-label">{m.wsOpen ? 'Connected' : 'Offline'}</span>
            </span>
            <button type="button" className="btn-icon btn-icon-sm sidebar-collapse" onClick={onToggleCollapsed} aria-pressed={collapsed} aria-label={collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'} aria-keyshortcuts="[" title={collapsed ? 'Expand the sidebar  [' : 'Collapse the sidebar  ['} data-nav>
              <Icon name={collapsed ? 'chevronRight' : 'chevronLeft'} size={18} />
            </button>
          </div>
        </div>
      </div>
    </aside>
  );
}
