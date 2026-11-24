import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import type { Channel, FeatureFlags, Item, Library } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { seerrApi } from '../api/seerr';
import { useApp } from '../state/app';
import { useDebounced } from '../hooks';
import { ADMIN_NAV } from '../admin/nav';
import { itemLink, itemSubtitle, landscapeFor, libraryIcon, posterFor } from '../utils/items';
import { getAmbient, paletteFor, setAmbient, type Palette } from '../theme/ambient';
import { Icon, type IconName } from './Icon';
import { Img, Spinner } from './ui';

/** A destination or action the palette can offer (built by Layout from the same data as the rail). */
export interface PaletteEntry {
  id: string;
  label: string;
  icon: IconName;
  group: string;
  to?: string;
  run?: () => void;
  hint?: string;
  keywords?: string;
}

/** What the rail is showing (computed in Layout), so the palette offers the same destinations. */
export interface PaletteContext {
  local: Library[];
  iptv: Library[];
  liveTv: boolean;
  dvr: boolean;
  manager: boolean;
  showRequests: boolean;
  showIssues: boolean;
  discover: boolean;
  hasProfiles: boolean;
}

function buildDestinations(c: PaletteContext, features: FeatureFlags, linkDevice: boolean): PaletteEntry[] {
  const d: PaletteEntry[] = [
    { id: 'home', label: 'Home', icon: 'home', to: '/', group: 'Go to' },
    { id: 'search', label: 'Search', icon: 'search', to: '/search', group: 'Go to' },
  ];
  if (c.discover) d.push({ id: 'discover', label: 'Discover', icon: 'compass', to: '/discover', group: 'Go to', hint: 'Find something new to request' });
  if (c.showRequests) d.push({ id: 'requests', label: c.manager ? 'Requests' : 'My requests', icon: 'inbox', to: '/requests', group: 'Go to' });
  if (c.showIssues) d.push({ id: 'issues', label: c.manager ? 'Issues' : 'My issues', icon: 'flag', to: '/issues', group: 'Go to' });
  for (const l of c.local) d.push({ id: `lib-${l.id}`, label: l.name, icon: libraryIcon(l.type), to: `/library/${l.id}`, group: 'Libraries' });
  if (c.liveTv) {
    d.push({ id: 'livetv', label: 'Live TV', icon: 'tv', to: '/livetv', group: 'Live & IPTV' });
    d.push({ id: 'guide', label: 'TV Guide', icon: 'guide', to: '/livetv/guide', group: 'Live & IPTV' });
    if (c.dvr) d.push({ id: 'dvr', label: 'Recordings', icon: 'recordOutline', to: '/dvr', group: 'Live & IPTV' });
  }
  for (const l of c.iptv) d.push({ id: `lib-${l.id}`, label: l.name, icon: libraryIcon(l.type), to: `/library/${l.id}`, group: 'Live & IPTV', hint: 'IPTV' });
  d.push(
    { id: 'mylist', label: 'My List', icon: 'plus', to: '/my-list', group: 'You' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', to: '/calendar', group: 'You' },
    { id: 'roulette', label: 'Roulette: pick something for me', icon: 'shuffle', to: '/roulette', group: 'You' },
    { id: 'match', label: 'Movie Match (decide together)', icon: 'together', to: '/match', group: 'You' },
    { id: 'remote', label: 'Use your phone as remote', icon: 'device', to: '/remote', group: 'You' },
    { id: 'downloads', label: 'Smart downloads', icon: 'download', to: '/settings/downloads', group: 'You' },
    ...(features.music ? [{ id: 'dj', label: 'DJ', icon: 'music' as IconName, to: '/dj', group: 'You' }] : []),
    { id: 'podcasts', label: 'Podcasts', icon: 'podcast', to: '/podcasts', group: 'You' },
    { id: 'playlists', label: 'Playlists', icon: 'playlist', to: '/playlists', group: 'You' },
    { id: 'collections', label: 'Collections', icon: 'collection', to: '/collections', group: 'You' },
    { id: 'wrapped', label: 'Your year', icon: 'sparkles', to: '/wrapped', group: 'You' },
    { id: 'help', label: 'Help Centre', icon: 'help', to: '/help', group: 'You' },
    { id: 'settings', label: 'Settings', icon: 'settings', to: '/settings', group: 'Settings' },
    { id: 'set-appearance', label: 'Appearance & visual effects', icon: 'palette', to: '/settings/appearance', group: 'Settings', keywords: 'theme lite mode effects' },
    { id: 'set-playback', label: 'Playback settings', icon: 'play', to: '/settings/playback', group: 'Settings', keywords: 'subtitles audio quality' },
    { id: 'set-profiles', label: 'Profiles', icon: 'users', to: '/settings/profiles', group: 'Settings' },
    { id: 'set-devices', label: 'Devices', icon: 'device', to: '/settings/devices', group: 'Settings' },
  );
  if (linkDevice) d.push({ id: 'link', label: 'Link a device', icon: 'link', to: '/link', group: 'Settings' });
  return d;
}

type Result =
  | { kind: 'entry'; id: string; entry: PaletteEntry }
  | { kind: 'item'; id: string; item: Item }
  | { kind: 'channel'; id: string; channel: Channel }
  | { kind: 'person'; id: string; person: { id: string; name: string; profileUrl: string | null; knownFor: string | null } }
  | { kind: 'all'; id: string; q: string };

/** Ranks how well `q` matches an entry: 0 = no match, higher is better (word starts beat substrings). */
function score(e: PaletteEntry, q: string): number {
  const label = e.label.toLowerCase();
  const hay = `${label} ${e.group.toLowerCase()} ${(e.keywords ?? '').toLowerCase()} ${(e.hint ?? '').toLowerCase()}`;
  if (label === q) return 100;
  if (label.startsWith(q)) return 80;
  if (new RegExp(`\\b${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(label)) return 60;
  if (label.includes(q)) return 40;
  if (q.split(/\s+/).every((w) => hay.includes(w))) return 20;
  return 0;
}

const groupOf = (r: Result) => (r.kind === 'entry' ? r.entry.group : r.kind === 'item' ? 'Titles' : r.kind === 'channel' ? 'Channels' : r.kind === 'person' ? 'People' : 'Search');

/**
 * ⌘K / Ctrl+K / "/" command palette: titles, people and channels from the server, every page in the app (admin
 * pages for admins) and a few actions. Arrow keys + Enter, Esc to close; on a TV remote the options are ordinary
 * buttons the D-pad moves between. Moving over a title lights the page with its artwork.
 */
export default function CommandPalette({ open, onClose, ctx }: { open: boolean; onClose: () => void; ctx: PaletteContext }) {
  const navigate = useNavigate();
  const { features, user, logout } = useApp();
  const isAdmin = !!user?.isAdmin;
  const destinations = useMemo(() => buildDestinations(ctx, features, features.linkCodes && !user?.parentUserId), [ctx, features, user?.parentUserId]);
  const actions = useMemo<PaletteEntry[]>(() => [
    ...(ctx.hasProfiles ? [{ id: 'act-profile', label: 'Switch profile', icon: 'users' as IconName, group: 'Actions', run: () => navigate('/profiles') }] : []),
    { id: 'act-shortcuts', label: 'Keyboard shortcuts', icon: 'keyboard', group: 'Actions', run: () => window.dispatchEvent(new CustomEvent('mm:shortcuts')) },
    { id: 'act-signout', label: 'Sign out', icon: 'logout', group: 'Actions', run: () => void logout().then(() => navigate('/login')) },
  ], [ctx.hasProfiles, navigate, logout]);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const debounced = useDebounced(query, 160);
  const [remote, setRemote] = useState<{ q: string; items: Item[]; channels: Channel[]; people: Extract<Result, { kind: 'person' }>['person'][] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const prevAmbient = useRef<Palette | null>(null);
  const navigated = useRef(false);
  const listId = useId();

  // Open / close: remember focus and light, restore both if nothing was chosen.
  useEffect(() => {
    if (!open) return;
    const prevFocus = document.activeElement as HTMLElement | null;
    prevAmbient.current = getAmbient();
    navigated.current = false;
    setQ('');
    setActive(0);
    document.body.classList.add('modal-open');
    const t = window.setTimeout(() => input.current?.focus(), 10);
    return () => {
      window.clearTimeout(t);
      document.body.classList.remove('modal-open');
      if (!navigated.current) {
        setAmbient(prevAmbient.current);
        prevFocus?.focus?.();
      }
    };
  }, [open]);

  useEffect(() => {
    if (!open || debounced.length < 2) {
      setRemote(null);
      setLoading(false);
      return;
    }
    const ctrl = new AbortController();
    setLoading(true);
    const people = features.requests ? seerrApi.people(debounced).catch(() => []) : Promise.resolve([]);
    Promise.all([api.items.search(debounced, 8, ctrl.signal), people])
      .then(([res, ppl]) => !ctrl.signal.aborted && setRemote({ q: debounced, items: res.items.slice(0, 8), channels: res.channels.slice(0, 4), people: ppl.slice(0, 4) }))
      .catch(() => !ctrl.signal.aborted && setRemote({ q: debounced, items: [], channels: [], people: [] }))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [debounced, open, features.requests]);

  const results = useMemo<Result[]>(() => {
    const admin: PaletteEntry[] = isAdmin ? ADMIN_NAV.map((n) => ({ id: `admin-${n.to}`, label: n.label, icon: n.icon, to: n.to, group: 'Admin', keywords: `admin server ${n.group} ${n.keywords ?? ''}` })) : [];
    const entries = [...destinations, ...admin, ...actions];
    if (!query) {
      const top = destinations.filter((d) => d.group !== 'Settings').slice(0, 9);
      return [...top, ...actions].map((e) => ({ kind: 'entry', id: e.id, entry: e }));
    }
    const out: Result[] = [];
    if (remote && remote.q === debounced) {
      for (const item of remote.items) out.push({ kind: 'item', id: `i-${item.id}`, item });
      for (const person of remote.people) out.push({ kind: 'person', id: `p-${person.id}`, person });
      for (const channel of remote.channels) out.push({ kind: 'channel', id: `c-${channel.id}`, channel });
    }
    const matched = entries.map((e) => ({ e, s: score(e, query) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 10);
    // Pages first when the query reads like a page name ("guide", "users"), titles first otherwise.
    const pages = matched.map(({ e }) => ({ kind: 'entry' as const, id: e.id, entry: e }));
    const strong = matched.length && matched[0].s >= 60;
    const merged = strong ? [...pages, ...out] : [...out, ...pages];
    merged.push({ kind: 'all', id: 'all', q: q.trim() });
    return merged;
  }, [query, debounced, remote, destinations, actions, isAdmin, q]);

  useEffect(() => setActive(0), [results.length, query]);

  // Light the page with the title under the cursor.
  const current = results[Math.min(active, results.length - 1)];
  useEffect(() => {
    if (!open || current?.kind !== 'item') return;
    let alive = true;
    void paletteFor(current.item.backdropUrl ?? landscapeFor(current.item) ?? posterFor(current.item)).then((p) => alive && p && setAmbient(p));
    return () => {
      alive = false;
    };
  }, [open, current]);

  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;
  const tv = document.documentElement.classList.contains('tv');

  const choose = (r: Result) => {
    navigated.current = r.kind !== 'entry' || !!r.entry.to;
    onClose();
    if (r.kind === 'entry') {
      if (r.entry.to) navigate(r.entry.to);
      else r.entry.run?.();
    } else if (r.kind === 'item') navigate(itemLink(r.item));
    else if (r.kind === 'channel') navigate(`/watch/live/${encodeURIComponent(r.channel.id)}`);
    else if (r.kind === 'person') navigate(`/discover/person/${encodeURIComponent(r.person.id)}`);
    else navigate(`/search?q=${encodeURIComponent(r.q)}`);
  };

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
      return;
    }
    // TV mode moves focus between the option buttons itself (tv/spatial.ts runs first and marks the event handled).
    if (e.defaultPrevented) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = results.length;
      if (n) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : n - 1)) % n);
    } else if (e.key === 'Enter' && e.target === input.current && current) {
      e.preventDefault();
      choose(current);
    } else if (e.key === 'Tab') {
      // Keep focus inside the dialog.
      const els = [...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('input, button')];
      const i = els.indexOf(document.activeElement as HTMLElement);
      const next = els[(i + (e.shiftKey ? els.length - 1 : 1)) % els.length];
      if (next) {
        e.preventDefault();
        next.focus();
      }
    }
  };

  let lastGroup = '';
  return createPortal(
    <div className="cmdk-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="cmdk" role="dialog" aria-modal="true" aria-label="Search and commands" onKeyDown={onKey}>
        <div className="cmdk-input-row">
          <Icon name="search" size={20} />
          <input
            ref={input}
            className="cmdk-input"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search titles, people, pages…"
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={current ? `${listId}-${current.id}` : undefined}
            aria-autocomplete="list"
            autoComplete="off"
            spellCheck={false}
            enterKeyHint="go"
          />
          {loading ? <Spinner size={18} /> : <kbd className="cmdk-esc">Esc</kbd>}
        </div>
        <div className="cmdk-list" id={listId} role="listbox" ref={list} aria-label="Results">
          {results.map((r, i) => {
            const g = groupOf(r);
            const head = g !== lastGroup ? <div className="cmdk-group" role="presentation">{g}</div> : null;
            lastGroup = g;
            return (
              <div key={r.id} role="presentation">
                {head}
                <button
                  type="button"
                  id={`${listId}-${r.id}`}
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  className={`cmdk-item ${i === active ? 'active' : ''}`}
                  onMouseMove={() => i !== active && setActive(i)}
                  onFocus={() => setActive(i)}
                  onClick={() => choose(r)}
                  // Desktop keeps focus in the input (aria-activedescendant); a TV remote moves focus onto the options.
                  tabIndex={tv ? 0 : -1}
                  data-nav
                >
                  <ResultRow r={r} />
                </button>
              </div>
            );
          })}
          {query.length >= 2 && !loading && results.length <= 1 && <p className="cmdk-empty">No matches in titles or pages.</p>}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>↵</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function ResultRow({ r }: { r: Result }) {
  switch (r.kind) {
    case 'entry':
      return (
        <>
          <span className="cmdk-icon"><Icon name={r.entry.icon} size={18} /></span>
          <span className="cmdk-text"><span>{r.entry.label}</span>{r.entry.hint && <small>{r.entry.hint}</small>}</span>
          <Icon name={r.entry.to ? 'chevronRight' : 'zap'} size={16} className="cmdk-go" />
        </>
      );
    case 'item':
      return (
        <>
          <span className="cmdk-thumb"><Img src={posterFor(r.item)} width={48} alt="" fallback={<Icon name="film" size={16} />} /></span>
          <span className="cmdk-text"><span>{r.item.title}</span><small>{itemSubtitle(r.item) || r.item.type}</small></span>
          <Icon name="chevronRight" size={16} className="cmdk-go" />
        </>
      );
    case 'channel':
      return (
        <>
          <span className="cmdk-thumb cmdk-logo"><Img src={r.channel.logoUrl} width={48} alt="" fallback={<Icon name="tv" size={16} />} /></span>
          <span className="cmdk-text"><span>{r.channel.name}</span><small>{r.channel.nowPlaying?.title ?? 'Live channel'}</small></span>
          <Icon name="play" size={14} className="cmdk-go" />
        </>
      );
    case 'person':
      return (
        <>
          <span className="cmdk-thumb cmdk-person"><Img src={r.person.profileUrl} width={48} alt="" fallback={<Icon name="user" size={16} />} /></span>
          <span className="cmdk-text"><span>{r.person.name}</span><small>{r.person.knownFor ?? 'Person'}</small></span>
          <Icon name="chevronRight" size={16} className="cmdk-go" />
        </>
      );
    default:
      return (
        <>
          <span className="cmdk-icon"><Icon name="search" size={18} /></span>
          <span className="cmdk-text"><span>Search everything for “{r.q}”</span><small>Full results: movies, shows, music, live TV</small></span>
          <Icon name="chevronRight" size={16} className="cmdk-go" />
        </>
      );
  }
}
