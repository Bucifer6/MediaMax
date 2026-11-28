import { djLive } from '../player/djLive';
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { useApp } from '../state/app';
import { Icon } from './Icon';
import { PageLoader } from './ui';
import { isStockName } from './BrandLogo';
import { PRODUCT_NAME } from '../brand/product';
import { MiniPlayer } from '../player/MiniPlayer';
import { RendererBar } from '../player/RendererBar';
import { useMusic } from '../player/music';
import { AmbientMode } from '../tv/Ambient';
import { isTypingTarget } from '../hooks';
import { useSpatialNav } from '../hooks/spatialNav';
import { isIptvLibrary } from '../utils/items';
import { api } from '../api/endpoints';
import { canManageRequests, ISSUES_CHANGED, REQUESTS_CHANGED } from '../utils/requests';
import { seerrApi } from '../api/seerr';
import { AmbientLight } from './AmbientLight';
import { PeekLayer } from './Peek';
import { setAmbient } from '../theme/ambient';
import { applyDensity } from '../theme/applyTheme';
import { Sidebar, type SidebarModel } from './shell/Sidebar';
import { TopBar } from './shell/TopBar';
import { useLibraryOrder, useSidebarCollapsed, useSidebarGroups } from './shell/shellPrefs';
import type { PaletteContext } from './CommandPalette';

// The command palette is only downloaded the first time it's opened.
const CommandPalette = lazy(() => import('./CommandPalette'));

// UserMenu lives in shell/TopBar.tsx; re-exported for existing imports.
export { UserMenu } from './shell/TopBar';

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
  const [collapsedPref, toggleCollapsed] = useSidebarCollapsed();
  // TV mode: always the icon rail; it widens while it has D-pad focus (tv.css).
  const collapsed = collapsedPref || document.documentElement.classList.contains('tv');
  const [groups, toggleGroup] = useSidebarGroups();
  useSpatialNav();
  useEffect(() => applyDensity(), []);

  const openPalette = useCallback(() => setPalette({ open: true, loaded: true }), []);
  const closePalette = useCallback(() => setPalette((p) => ({ ...p, open: false })), []);

  useEffect(() => setDrawer(false), [loc.pathname]);
  // Every page starts in the theme's own light; pages with artwork (home hero, title pages) relight it in their effects.
  useLayoutEffect(() => setAmbient(null), [loc.pathname]);
  useEffect(() => {
    const h = () => setScrolled(window.scrollY > 8);
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
      const plain = !isTypingTarget(e.target) && !e.metaKey && !e.ctrlKey && !e.altKey;
      if (k || (e.key === '/' && plain)) {
        if (!k && document.querySelector('[aria-modal="true"]')) return;
        e.preventDefault();
        openPalette();
      } else if (e.key === '[' && plain && !document.querySelector('[aria-modal="true"]')) {
        // "[": collapse / expand the sidebar.
        e.preventDefault();
        toggleCollapsed();
      } else if (e.key === 'Escape' && drawer) {
        setDrawer(false);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [openPalette, toggleCollapsed, drawer]);

  const local = libraries.filter((l) => !isIptvLibrary(l.type) && l.type !== 'podcasts' && (features.music || l.type !== 'music') && (features.photos || l.type !== 'photos'));
  const [orderedLocal, saveOrder, resetOrder] = useLibraryOrder(user?.id, local);
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
  const serverLabel = isStockName(branding.serverName) ? PRODUCT_NAME : branding.serverName;

  // What the sidebar shows, so the command palette ("Go to") offers exactly the same destinations.
  const paletteCtx: PaletteContext = { local: orderedLocal, iptv, liveTv, dvr, manager, showRequests, showIssues, discover: features.requests && !kidsNoRequests, hasProfiles };
  const model: SidebarModel = {
    libraries: orderedLocal, iptv, liveTv, dvr, music: features.music, djPlaying,
    showRequests, requestsLabel: manager ? 'Requests' : 'My requests', pending,
    discover: features.requests && !kidsNoRequests,
    showIssues, issuesLabel: manager ? 'Issues' : 'My issues', openIssues: manager ? openIssues : 0,
    isAdmin: !!user?.isAdmin, serverLabel, footerText: branding.footerText, supportUrl: branding.supportUrl, wsOpen,
  };

  return (
    <div className={`app-shell ${drawer ? 'drawer-open' : ''} ${collapsed ? 'sidebar-collapsed' : ''} ${music.current ? 'has-mini' : ''}`}>
      <AmbientLight />
      <a href="#main" className="skip-link">Skip to content</a>
      <Sidebar
        model={model}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        groups={groups}
        onToggleGroup={toggleGroup}
        onSaveOrder={saveOrder}
        onResetOrder={resetOrder}
      />
      <div className="drawer-scrim" onClick={() => setDrawer(false)} aria-hidden="true" />
      <div className="main-col">
        <TopBar scrolled={scrolled} onSearch={openPalette} onMenu={() => setDrawer((d) => !d)} serverLabel={serverLabel} drawerOpen={drawer} />
        <main className="main" id="main" tabIndex={-1}>
          {/* Route chunks load inside the shell: the nav stays put instead of the whole screen blanking. */}
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <PeekLayer />
      <AmbientMode />
      <MiniPlayer />
      <RendererBar />
      <nav className="bottom-nav tabbar" aria-label="Quick navigation">
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
