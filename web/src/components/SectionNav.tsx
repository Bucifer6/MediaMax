import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Icon, type IconName } from './Icon';
import '../styles/screens-account.css';

export interface SectionNavItem {
  /** Route (may carry a `?tab=` query, matched against the current search). */
  to: string;
  label: string;
  icon: IconName;
  /** Extra words the filter matches ("subtitle language pin 2fa"). */
  keywords?: string;
  /** Match the path exactly (an index route such as /admin). */
  end?: boolean;
  /** Short note on the right (a count, "New"). */
  badge?: ReactNode;
  /** A path outside this area (shown with an arrow). */
  external?: boolean;
}
export interface SectionNavGroup {
  label?: string;
  items: SectionNavItem[];
}

const words = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').split(/[^a-z0-9]+/).filter(Boolean);

/** Is `item` the current section? A `?tab=` link wins over its plain path when the current URL carries that tab. */
function isActive(item: SectionNavItem, all: SectionNavItem[], pathname: string, search: string): boolean {
  const [path, query] = item.to.split('?');
  const onPath = item.end ? pathname === path || pathname === `${path}/` : pathname === path || pathname.startsWith(`${path}/`);
  if (!onPath) return false;
  const tab = new URLSearchParams(search).get('tab');
  if (query) return new URLSearchParams(query).get('tab') === tab;
  // The plain entry yields to a sibling `?tab=` entry that matches the current tab.
  return !all.some((o) => o !== item && o.to.startsWith(`${path}?`) && new URLSearchParams(o.to.split('?')[1]).get('tab') === tab);
}

/**
 * The section list of a two-pane area (Settings, Admin): grouped links with a filter field. On phones it folds into a
 * disclosure that names the current section. Enter in the filter opens the first match; Esc clears it.
 */
export function SectionNav({ title, icon, groups, label, footer }: { title: string; icon: IconName; groups: SectionNavGroup[]; label: string; footer?: ReactNode }) {
  const { pathname, search } = useLocation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const current = all.find((i) => isActive(i, all, pathname, search));

  // Close the phone disclosure after navigating.
  useEffect(() => setOpen(false), [pathname, search]);

  const terms = words(q);
  const matches = terms.length
    ? all.filter((i) => {
        const hay = words(`${i.label} ${i.keywords ?? ''}`);
        return terms.every((t) => hay.some((w) => w.startsWith(t)));
      })
    : null;

  const renderItem = (i: SectionNavItem) => {
    const active = i === current;
    return (
      <li key={i.to}>
        <Link to={i.to} className={`snav-link ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
          <Icon name={i.icon} size={18} />
          <span className="snav-label">{i.label}</span>
          {i.badge != null && <span className="snav-badge">{i.badge}</span>}
          {i.external && <Icon name="chevronRight" size={14} className="snav-ext" />}
        </Link>
      </li>
    );
  };

  return (
    <nav className={`snav ${open ? 'open' : ''}`} aria-label={label}>
      <div className="snav-head">
        <span className="snav-title"><Icon name={icon} size={18} /> {title}</span>
      </div>
      <button type="button" className="snav-toggle" aria-expanded={open} aria-controls={listId} onClick={() => setOpen((o) => !o)}>
        {current ? <Icon name={current.icon} size={18} /> : <Icon name={icon} size={18} />}
        <span className="snav-toggle-label"><small>{title}</small>{current?.label ?? 'Sections'}</span>
        <Icon name="chevronDown" size={18} className="snav-chev" />
      </button>
      <div className="snav-body" id={listId}>
        <div className="snav-search input-wrap">
          <Icon name="search" size={16} />
          <input
            ref={input}
            className="input input-sm"
            type="search"
            value={q}
            placeholder={`Search ${title.toLowerCase()}`}
            aria-label={`Search ${title.toLowerCase()}`}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && matches?.[0]) {
                e.preventDefault();
                navigate(matches[0].to);
                setQ('');
              } else if (e.key === 'Escape' && q) {
                e.stopPropagation();
                setQ('');
              }
            }}
          />
        </div>
        {matches ? (
          <>
            <p className="snav-count" aria-live="polite">{matches.length ? `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}` : 'No matching sections'}</p>
            <ul className="snav-list">{matches.map(renderItem)}</ul>
          </>
        ) : (
          groups.map((g, gi) => (
            <div className="snav-group" key={g.label ?? gi}>
              {g.label && <h2 className="snav-group-label">{g.label}</h2>}
              <ul className="snav-list">{g.items.map(renderItem)}</ul>
            </div>
          ))
        )}
        {footer && !matches && <div className="snav-footer">{footer}</div>}
      </div>
    </nav>
  );
}
