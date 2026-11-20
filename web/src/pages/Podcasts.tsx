import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { PodcastSearchResult, PodcastSubscription } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync } from '../hooks';
import { usePlayItem } from '../player/music';
import { Badge, Dropdown, EmptyState, ErrorState, Img, Skeleton, Spinner, useConfirm } from '../components/ui';
import { Icon } from '../components/Icon';
import { relativeTime } from '../utils/format';

const looksLikeUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export default function PodcastsPage() {
  const toast = useToast();
  const confirm = useConfirm();
  const { user } = useApp();
  const play = usePlayItem();
  const subs = useAsync(() => api.podcasts.list(), []);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PodcastSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [autoDownload, setAutoDownload] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const subscribedUrls = new Set((subs.data ?? []).map((s) => s.feedUrl));

  const search = async (e: FormEvent) => {
    e.preventDefault();
    const term = q.trim();
    if (!term) return;
    setSearching(true);
    setSearchError(null);
    try {
      setResults(await api.podcasts.search(term));
    } catch (err) {
      setSearchError((err as Error).message);
      setResults(null);
    } finally {
      setSearching(false);
    }
  };

  const subscribe = async (feedUrl: string) => {
    setBusy(feedUrl);
    try {
      const s = await api.podcasts.subscribe({ feedUrl, autoDownload });
      subs.setData((l) => [...(l ?? []).filter((x) => x.id !== s.id), s]);
      toast.success(`Subscribed to ${s.title}`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const replace = (s: PodcastSubscription) => subs.setData((l) => (l ?? []).map((x) => (x.id === s.id ? s : x)));

  const refresh = async (s: PodcastSubscription) => {
    setBusy(s.id);
    try {
      const r = await api.podcasts.refresh(s.id);
      if (r && typeof r === 'object' && 'id' in r) replace(r);
      else subs.reload();
      toast.success(`${s.title} refreshed`);
    } catch (e) {
      toast.error(e);
    } finally {
      setBusy(null);
    }
  };

  const toggleAuto = async (s: PodcastSubscription) => {
    replace({ ...s, autoDownload: !s.autoDownload });
    try {
      replace(await api.podcasts.update(s.id, { autoDownload: !s.autoDownload }));
    } catch (e) {
      replace(s);
      toast.error(e);
    }
  };

  const unsubscribe = async (s: PodcastSubscription) => {
    if (!(await confirm({ title: `Unsubscribe from ${s.title}?`, message: 'Episodes and listening progress for this podcast are removed from the server.', confirmLabel: 'Unsubscribe', danger: true }))) return;
    try {
      await api.podcasts.remove(s.id);
      subs.setData((l) => (l ?? []).filter((x) => x.id !== s.id));
      toast.success('Unsubscribed');
    } catch (e) {
      toast.error(e);
    }
  };

  const importOpml = async (file: File) => {
    setImporting(true);
    try {
      const text = await file.text();
      const r = await api.podcasts.importOpml(text);
      const failed = Array.isArray(r.failed) ? r.failed.length : r.failed;
      toast.show(`Imported ${r.added} podcast${r.added === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already subscribed` : ''}${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
      subs.reload();
    } catch (e) {
      toast.error(e);
    } finally {
      setImporting(false);
    }
  };

  const list = [...(subs.data ?? [])].sort((a, b) => a.title.localeCompare(b.title));

  return (
    <div className="page podcasts-page">
      <header className="page-head">
        <div className="page-title-wrap"><Icon name="podcast" size={28} className="page-icon" /><h1>Podcasts</h1></div>
        <div className="row-gap">
          <button className="btn" onClick={() => fileInput.current?.click()} disabled={importing}>
            {importing ? <Spinner size={16} /> : <Icon name="upload" size={16} />} Import OPML
          </button>
          <input ref={fileInput} type="file" accept=".opml,.xml,text/xml,application/xml,text/x-opml" hidden onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importOpml(f); }} />
        </div>
      </header>

      <section className="settings-card pod-search">
        <h2>Add a podcast</h2>
        <form className="pod-search-form" onSubmit={search} role="search">
          <div className="input-icon">
            <Icon name="search" size={18} />
            <input className="input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search podcasts or paste a feed URL" aria-label="Search podcasts or paste a feed URL" />
          </div>
          <button className="btn btn-primary" disabled={searching || !q.trim()}>{searching ? <Spinner size={16} /> : looksLikeUrl(q) ? 'Look up feed' : 'Search'}</button>
        </form>
        <label className="check-inline">
          <input type="checkbox" checked={autoDownload} onChange={(e) => setAutoDownload(e.target.checked)} /> Download new episodes to the server automatically
        </label>
        {searchError && <p className="form-error">{searchError}</p>}
        {results && (results.length === 0 ? <p className="muted">No podcasts found for “{q}”.</p> : (
          <ul className="pod-results">
            {results.map((r) => {
              const subscribed = subscribedUrls.has(r.feedUrl);
              return (
                <li key={r.feedUrl} className="pod-result">
                  <div className="pod-art"><Img src={r.imageUrl} width={120} alt="" fallback={<Icon name="podcast" size={22} />} /></div>
                  <div className="pod-text">
                    <strong>{r.title}</strong>
                    <span className="muted">{[r.author, r.genre].filter(Boolean).join(' · ') || r.feedUrl}</span>
                  </div>
                  <button className={`btn btn-sm ${subscribed ? 'btn-ghost' : 'btn-primary'}`} onClick={() => subscribe(r.feedUrl)} disabled={subscribed || busy === r.feedUrl}>
                    {busy === r.feedUrl ? <Spinner size={14} /> : <Icon name={subscribed ? 'check' : 'plus'} size={14} />} {subscribed ? 'Subscribed' : 'Subscribe'}
                  </button>
                </li>
              );
            })}
          </ul>
        ))}
      </section>

      <h2 className="section-title pod-subs-title">Subscriptions {list.length > 0 && <Badge tone="muted">{list.length}</Badge>}</h2>
      {subs.loading && !subs.data ? (
        <div className="pod-grid">{[0, 1, 2, 3].map((i) => <Skeleton key={i} h={120} />)}</div>
      ) : subs.error ? (
        <ErrorState message={subs.error} onRetry={subs.reload} />
      ) : !list.length ? (
        <EmptyState icon="podcast" title="No podcasts yet" message="Search above or import an OPML file from your old podcast app." />
      ) : (
        <ul className="pod-grid">
          {list.map((s) => (
            <li key={s.id} className="pod-sub">
              <Link to={`/item/${s.itemId}`} className="pod-art pod-art-lg" aria-label={s.title}>
                <Img src={s.imageUrl} width={200} alt="" fallback={<Icon name="podcast" size={28} />} />
              </Link>
              <div className="pod-sub-body">
                <Link to={`/item/${s.itemId}`} className="pod-sub-title">{s.title}</Link>
                <span className="muted pod-sub-meta">{s.episodeCount} episode{s.episodeCount === 1 ? '' : 's'} · updated {relativeTime(s.lastRefreshAt)}</span>
                {s.lastError && <span className="form-error pod-sub-error" title={s.lastError}><Icon name="alert" size={13} /> {s.lastError}</span>}
                <div className="pod-sub-actions">
                  <button className="btn btn-sm" onClick={() => play({ id: s.itemId, type: 'podcast' } as never)}><Icon name="play" size={14} /> Play latest</button>
                  <label className="check-inline pod-auto" title="Download new episodes to the server">
                    <input type="checkbox" className="switch" checked={s.autoDownload} onChange={() => toggleAuto(s)} aria-label={`Auto-download ${s.title}`} />
                    <span>Auto-download</span>
                  </label>
                  <Dropdown
                    trigger={({ onClick }) => <button className="btn-icon" onClick={onClick} aria-label={`More for ${s.title}`}>{busy === s.id ? <Spinner size={16} /> : <Icon name="more" size={18} />}</button>}
                    items={[
                      { label: 'Refresh feed', icon: 'refresh', onClick: () => void refresh(s) },
                      { label: 'Copy feed URL', icon: 'copy', onClick: () => { void navigator.clipboard?.writeText(s.feedUrl); toast.success('Feed URL copied'); } },
                      { divider: true, label: '' },
                      { label: 'Unsubscribe', icon: 'trash', danger: true, onClick: () => void unsubscribe(s), disabled: !user },
                    ]}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
