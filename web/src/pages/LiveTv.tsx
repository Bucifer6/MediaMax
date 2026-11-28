import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Channel, ChannelCategory, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useDebounced, useInfiniteSentinel, useNow } from '../hooks';
import { Chip, EmptyState, ErrorState, Img, Input, PageHeader, ProgressBar, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { ChannelCard, programProgress } from '../components/Cards';
import { Row } from '../components/Row';
import { ProgramModal } from '../components/ProgramModal';
import { formatTime } from '../utils/format';
import { HelpLink } from '../components/HelpLink';
import { recentChannelIds } from '../livetv/recent';
import '../styles/epg.css';

const PAGE = 80;

/** Favourites and recently watched channels, as rows of "on now" cards. */
function useChannelRows(userId: string | undefined, kind: 'tv' | 'radio') {
  const favs = useAsync(() => api.livetv.channels({ favorite: true, limit: 30, withEpg: true, kind }).then((r) => r.items), [kind]);
  const recent = useAsync(async () => {
    const ids = recentChannelIds(userId).slice(0, 10);
    const list = await Promise.all(ids.map((id) => api.livetv.channel(id).catch(() => null)));
    return list.filter((c): c is Channel => !!c && !c.hidden && !!c.radio === (kind === 'radio'));
  }, [userId, kind]);
  return { favs, recent };
}

export default function LiveTvPage() {
  const toast = useToast();
  const { user } = useApp();
  const cats = useAsync(() => api.livetv.categories(), []);
  const [category, setCategory] = useState<string>('');
  // TV and radio stations (a tuner's audio-only services) are listed apart; the Radio tab shows only when there are any.
  const [kind, setKind] = useState<'tv' | 'radio'>('tv');
  const radioCount = useAsync(() => api.livetv.channels({ kind: 'radio', limit: 1, withEpg: false }).then((r) => r.total).catch(() => 0), []);
  const [fav, setFav] = useState(false);
  const [search, setSearch] = useState('');
  const q = useDebounced(search.trim(), 250);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{ p: Program; c: Channel } | null>(null);
  const req = useRef(0);
  const now = useNow(30000);
  const rows = useChannelRows(user?.id, kind);

  const load = useCallback(
    async (offset: number) => {
      const id = ++req.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.livetv.channels({ categoryId: category || undefined, favorite: fav || undefined, search: q || undefined, limit: PAGE, offset, withEpg: true, kind });
        if (id !== req.current) return;
        setChannels((c) => (offset ? [...c, ...res.items] : res.items));
        setTotal(res.total);
      } catch (e) {
        if (id === req.current) setError((e as Error).message);
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [category, fav, q, kind],
  );
  useEffect(() => {
    void load(0);
  }, [load]);

  const hasMore = channels.length < total;
  const sentinel = useInfiniteSentinel(() => void load(channels.length), hasMore && !loading);

  const toggleFav = async (c: Channel) => {
    try {
      const r = await api.livetv.setFavorite(c.id, !c.favorite);
      setChannels((list) => (fav && !r.favorite ? list.filter((x) => x.id !== c.id) : list.map((x) => (x.id === c.id ? { ...x, favorite: r.favorite } : x))));
      rows.favs.reload();
      toast.show(r.favorite ? `${c.name} added to favourites` : `${c.name} removed from favourites`);
    } catch (e) {
      toast.error(e);
    }
  };
  const replaceChannel = (c: Channel) => {
    setChannels((list) => list.map((x) => (x.id === c.id ? { ...x, favorite: c.favorite } : x)));
    setSelected((s) => (s ? { ...s, c } : s));
    rows.favs.reload();
  };

  const visibleCats = (cats.data ?? []).filter((c: ChannelCategory) => !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const filter = (cat: string, f: boolean) => {
    setCategory(cat);
    setFav(f);
  };
  const favList = rows.favs.data ?? [];
  const recentList = rows.recent.data ?? [];
  const filtered = !!(category || fav || q);

  return (
    <div className="page livetv-page">
      <PageHeader
        title={<>Live TV <HelpLink slug="live-tv" label="Live TV" /></>}
        subtitle={total && !filtered ? `${total.toLocaleString()} channels` : undefined}
        actions={(
          <>
            <Link to="/livetv/guide" className="btn btn-primary"><Icon name="guide" size={16} /> Guide</Link>
            <Link to="/watch/multiview" className="btn"><Icon name="grid" size={16} /> Multiview</Link>
            <Link to="/dvr" className="btn btn-ghost"><Icon name="recordOutline" size={16} /> Recordings</Link>
          </>
        )}
      />

      {(radioCount.data ?? 0) > 0 && (
        <div className="segmented lt-kind" role="tablist" aria-label="TV or radio">
          {(['tv', 'radio'] as const).map((k) => (
            <button key={k} role="tab" aria-selected={kind === k} className={kind === k ? 'active' : ''} onClick={() => { setKind(k); filter('', false); }}>
              <Icon name={k === 'tv' ? 'tv' : 'music'} size={16} /> {k === 'tv' ? 'TV' : 'Radio'}
            </button>
          ))}
        </div>
      )}

      {favList.length > 0 && (
        <div className="lt-section">
          <Row title="Favourites" subtitle={`${favList.length}`} className="lt-row">
            {favList.map((c) => <ChannelCard key={c.id} channel={c} />)}
          </Row>
        </div>
      )}
      {recentList.length > 0 && (
        <div className="lt-section">
          <Row title="Recently watched" className="lt-row">
            {recentList.map((c) => <ChannelCard key={c.id} channel={c} />)}
          </Row>
        </div>
      )}

      <section className="lt-on-now" aria-labelledby="lt-on-now">
        <div className="lt-list-head">
          <h2 id="lt-on-now">{kind === 'radio' ? 'Radio' : 'On now'}{total > 0 && <span className="lt-count">{total.toLocaleString()} {kind === 'radio' ? 'station' : 'channel'}{total === 1 ? '' : 's'}</span>}</h2>
          <Input icon="search" inputSize="sm" className="lt-search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a channel" aria-label="Search channels" />
        </div>
        <div className="chip-scroller lt-filters" role="group" aria-label="Filter channels">
          <Chip active={!category && !fav} onClick={() => filter('', false)}>All</Chip>
          <Chip active={fav} icon={fav ? 'starFill' : 'star'} onClick={() => filter('', !fav)}>Favourites</Chip>
          {visibleCats.length > 0 && <span className="chip-sep" aria-hidden="true" />}
          {cats.loading && !cats.data ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} w={84} h={32} r={999} />) : visibleCats.map((c) => (
            <Chip key={c.id} active={category === c.id} onClick={() => filter(category === c.id ? '' : c.id, false)}>
              {c.name} <span className="chip-count">{c.channelCount}</span>
            </Chip>
          ))}
        </div>
        {error && !channels.length ? (
          <ErrorState message={error} onRetry={() => load(0)} />
        ) : !loading && !channels.length ? (
          <EmptyState icon="tv" title={fav ? 'No favourite channels yet' : q ? `No channels match “${q}”` : 'No channels'} message={fav ? 'Tap the star on any channel to pin it here.' : q ? undefined : 'Ask an admin to add a Live TV source.'} />
        ) : (
          <ul className="channel-list" aria-busy={loading}>
            {channels.map((c) => {
              const np = c.nowPlaying;
              return (
                <li key={c.id} className="channel-row">
                  <Link to={`/watch/live/${c.id}`} className="channel-row-main" data-nav aria-label={`Watch ${c.name}${np ? `: ${np.title}` : ''}`}>
                    <span className="ch-num">{c.number ?? ''}</span>
                    <span className="ch-logo"><Img src={c.logoUrl} width={120} alt="" fallback={<span className="ch-logo-text">{c.name.slice(0, 3)}</span>} /></span>
                    <span className="ch-info">
                      <span className="ch-name">{c.name} {c.hasArchive && <span className="badge badge-muted" title={`${c.archiveDays} days catch-up`}>Catch-up</span>}</span>
                      {np ? (
                        <>
                          <span className="ch-now">{np.title}</span>
                          <span className="ch-progress"><ProgressBar value={programProgress(np.start, np.end, now)} /> <small>{formatTime(np.start)} – {formatTime(np.end)}</small></span>
                        </>
                      ) : (
                        <span className="ch-now muted">No guide information</span>
                      )}
                    </span>
                  </Link>
                  {c.next && (
                    <button className="ch-next" onClick={() => setSelected({ p: c.next!, c })} title="Up next: details, record or remind">
                      <small>Next · {formatTime(c.next.start)}</small>
                      <span>{c.next.title}</span>
                    </button>
                  )}
                  {np && (
                    <button className="btn-icon btn-icon-sm" onClick={() => setSelected({ p: np, c })} aria-label={`About ${np.title}`} title="Programme details"><Icon name="info" size={18} /></button>
                  )}
                  <button className={`btn-icon btn-icon-sm ${c.favorite ? 'fav-on' : ''}`} onClick={() => toggleFav(c)} aria-label={c.favorite ? `Remove ${c.name} from favourites` : `Add ${c.name} to favourites`} aria-pressed={!!c.favorite}>
                    <Icon name={c.favorite ? 'starFill' : 'star'} size={18} />
                  </button>
                </li>
              );
            })}
            {loading && Array.from({ length: 6 }).map((_, i) => <li key={`s${i}`} className="lt-skeleton"><Skeleton h={68} w="100%" r={14} /></li>)}
          </ul>
        )}
        <div ref={sentinel} className="sentinel" />
      </section>
      {selected && <ProgramModal program={selected.p} channel={selected.c} onClose={() => setSelected(null)} onChannelChanged={replaceChannel} />}
    </div>
  );
}
