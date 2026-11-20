import { Component, lazy, Suspense, type ReactNode } from 'react';
import type React from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './state/app';
import { ToastProvider } from './state/toast';
import { ConfirmProvider, PageLoader } from './components/ui';
import { MusicProvider } from './player/music';
import { Layout } from './components/Layout';
import { Icon } from './components/Icon';
import { BrandLogo } from './components/BrandLogo';
import { Login } from './pages/Login';
import { SetupWizard } from './pages/SetupWizard';
import { Home } from './pages/Home';
import { LibraryPage } from './pages/Library';
import { ItemPage } from './pages/ItemDetail';
import { SearchPage } from './pages/Search';
import { LinkDevicePage } from './pages/LinkDevice';
import { NotFound } from './pages/NotFound';

/** Lazy-load a route chunk; after a server upgrade old chunk names 404, so reload once. */
function lazyPage<T extends { default: React.ComponentType<any> }>(load: () => Promise<T>) {
  const key = 'mm.chunkReload';
  return lazy(() =>
    load().then(
      (m) => {
        try { sessionStorage.removeItem(key); } catch { /* ignore */ }
        return m;
      },
      (e) => {
        try {
          if (!sessionStorage.getItem(key)) {
            sessionStorage.setItem(key, '1');
            location.reload();
          }
        } catch { /* ignore */ }
        throw e;
      },
    ),
  );
}

const VideoPlayer = lazyPage(() => import('./player/VideoPlayer'));
const LivePlayer = lazyPage(() => import('./player/LivePlayer'));
const Multiview = lazyPage(() => import('./player/Multiview'));
const LiveTvPage = lazyPage(() => import('./pages/LiveTv'));
const GuidePage = lazyPage(() => import('./pages/Guide'));
const DvrPage = lazyPage(() => import('./pages/Dvr'));
const SettingsPage = lazyPage(() => import('./pages/Settings'));
const ContainersPage = lazyPage(() => import('./pages/Containers'));
const WrappedPage = lazyPage(() => import('./pages/Wrapped'));
const PodcastsPage = lazyPage(() => import('./pages/Podcasts'));
const DiscoverPage = lazyPage(() => import('./pages/Discover'));
const RequestsPage = lazyPage(() => import('./pages/Requests'));
const AdminRoutes = lazyPage(() => import('./admin/AdminRoutes'));

class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error) {
    console.error(error);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fullscreen-center">
          <div className="empty-state">
            <div className="empty-icon"><Icon name="alert" size={34} /></div>
            <h3>Something broke</h3>
            <p className="muted">{this.state.error.message}</p>
            <button className="btn btn-primary" onClick={() => location.reload()}>Reload</button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function Splash() {
  const { branding } = useApp();
  return (
    <div className="splash" style={{ background: branding.splash.backgroundColor }}>
      {branding.splash.logoUrl ? <img src={branding.splash.logoUrl} alt="" className="splash-logo" /> : <BrandLogo height={48} />}
      <div className="splash-bar"><span /></div>
    </div>
  );
}

function Offline() {
  const { retryBoot } = useApp();
  return (
    <div className="fullscreen-center offline">
      <div className="empty-state">
        <BrandLogo height={40} />
        <div className="empty-icon" style={{ marginTop: 24 }}><Icon name="server" size={34} /></div>
        <h3>Can't reach the server</h3>
        <p className="muted">MediaMax isn't responding right now. Check that the server is running and you're on the right network.</p>
        <button className="btn btn-primary" onClick={retryBoot}>
          <Icon name="refresh" size={16} /> Retry
        </button>
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user } = useApp();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function RequireAdmin({ children }: { children: ReactNode }) {
  const { user } = useApp();
  if (!user?.isAdmin) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Gate() {
  const { status, system } = useApp();
  if (status === 'loading') return <Splash />;
  if (status === 'offline') return <Offline />;
  if (system?.setupRequired) return <SetupWizard />;
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/play/:itemId" element={<RequireAuth><VideoPlayer /></RequireAuth>} />
        <Route path="/watch/multiview" element={<RequireAuth><Multiview /></RequireAuth>} />
        <Route path="/watch/live/:channelId" element={<RequireAuth><LivePlayer /></RequireAuth>} />
        <Route element={<RequireAuth><Layout /></RequireAuth>}>
          <Route index element={<Home />} />
          <Route path="library/:libraryId" element={<LibraryPage />} />
          <Route path="item/:itemId" element={<ItemPage />} />
          <Route path="search" element={<SearchPage />} />
          <Route path="livetv" element={<LiveTvPage />} />
          <Route path="livetv/guide" element={<GuidePage />} />
          <Route path="dvr" element={<DvrPage />} />
          <Route path="playlists" element={<ContainersPage kind="playlists" />} />
          <Route path="collections" element={<ContainersPage kind="collections" />} />
          <Route path="link" element={<LinkDevicePage />} />
          <Route path="wrapped" element={<WrappedPage />} />
          <Route path="podcasts" element={<PodcastsPage />} />
          <Route path="discover" element={<DiscoverPage />} />
          <Route path="requests" element={<RequestsPage />} />
          <Route path="settings/*" element={<SettingsPage />} />
          <Route path="admin/*" element={<RequireAdmin><AdminRoutes /></RequireAdmin>} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </Suspense>
  );
}

export function App() {
  return (
    <ErrorBoundary>
      <ToastProvider>
        <ConfirmProvider>
          <AppProvider>
            <MusicProvider>
              <Gate />
            </MusicProvider>
          </AppProvider>
        </ConfirmProvider>
      </ToastProvider>
    </ErrorBoundary>
  );
}
