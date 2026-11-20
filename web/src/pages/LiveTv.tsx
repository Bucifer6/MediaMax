import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type { Channel, ChannelCategory, Program } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useToast } from '../state/toast';
import { useAsync, useDebounced, useInfiniteSentinel, useNow } from '../hooks';
import { EmptyState, ErrorState, Img, ProgressBar, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';
import { programProgress } from '../components/Cards';
import { ProgramModal } from '../components/ProgramModal';
import { formatTime } from '../utils/format';

const PAGE = 80;

export default function LiveTvPage() {
  const toast = useToast();
  const cats = useAsync(() => api.livetv.categories(), []);
  const [category, setCategory] = useState<string>('');
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

  const load = useCallback(
    async (offset: number) => {
      const id = ++req.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.livetv.channels({ categoryId: category || undefined, favorite: fav || undefined, search: q || undefined, limit: PAGE, offset, withEpg: true });
        if (id !== req.current) return;
        setChannels((c) => (offset ? [...c, ...res.items] : res.items));
        setTotal(res.total);
      } catch (e) {
        if (id === req.current) setError((e as Error).message);
      } finally {
        if (id === req.current) setLoading(false);
      }
    },
    [category, fav, q],
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
    } catch (e) {
      toast.error(e);
    }
  };

  const visibleCats = (cats.data ?? []).filter((c: ChannelCategory) => !c.hidden).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));

  return (
    <div className="page livetv-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="tv" size={28} className="page-icon" />
          <div>
            <h1>Live TV</h1>
            <p className="muted">{total ? `${total.toLocaleString()} channels` : ' '}</p>
          </div>
        </div>
        <div className="row-gap">
          <Link to="/livetv/guide" className="btn"><Icon name="guide" size={16} /> TV Guide</Link>
          <Link to="/dvr" className="btn btn-ghost"><Icon name="recordOutline" size={16} /> Recordings</Link>
        </div>
      </header>
      <div className="livetv-layout">
        <aside className="cat-list">
          <div className="search-mini">
            <Icon name="search" size={16} />
            <input className="input" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a channel" aria-label="Search channels" />
          </div>
          <button className={`cat ${!category && !fav ? 'active' : ''}`} onClick={() => { setCategory(''); setFav(false); }}>
            <Icon name="grid" size={16} /> All channels
          </button>
          <button className={`cat ${fav ? 'active' : ''}`} onClick={() => { setFav(true); setCategory(''); }}>
            <Icon name="starFill" size={16} /> Favourites
          </button>
          <div className="cat-divider" />
          {cats.loading && !cats.data ? Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} h={30} style={{ margin: '6px 0' }} />) : visibleCats.map((c) => (
            <button key={c.id} className={`cat ${category === c.id ? 'active' : ''}`} onClick={() => { setCategory(c.id); setFav(false); }}>
              <span className="cat-name">{c.name}</span>
              <span className="cat-count">{c.channelCount}</span>
            </button>
          ))}
        </aside>
        <div className="channel-list-wrap">
          <div className="cat-chips">
            <button className={`chip ${!category && !fav ? 'active' : ''}`} onClick={() => { setCategory(''); setFav(false); }}>All</button>
            <button className={`chip ${fav ? 'active' : ''}`} onClick={() => { setFav(true); setCategory(''); }}><Icon name="starFill" size={12} /> Favourites</button>
            {visibleCats.map((c) => (
              <button key={c.id} className={`chip ${category === c.id ? 'active' : ''}`} onClick={() => { setCategory(c.id); setFav(false); }}>{c.name}</button>
            ))}
          </div>
          {error && !channels.length ? (
            <ErrorState message={error} onRetry={() => load(0)} />
          ) : !loading && !channels.length ? (
            <EmptyState icon="tv" title={fav ? 'No favourite channels yet' : 'No channels'} message={fav ? 'Tap the star on any channel to pin it here.' : 'Ask an admin to add a Live TV source.'} />
          ) : (
            <ul className="channel-list">
              {channels.map((c) => {
                const np = c.nowPlaying;
                return (
                  <li key={c.id} className="channel-row">
                    <Link to={`/watch/live/${c.id}`} className="channel-row-main" data-nav>
                      <span className="ch-num">{c.number ?? ''}</span>
                      <span className="ch-logo"><Img src={c.logoUrl} width={120} alt={c.name} fallback={<span className="ch-logo-text">{c.name.slice(0, 3)}</span>} /></span>
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
                      <button className="ch-next" onClick={() => setSelected({ p: c.next!, c })} title="Up next">
                        <small>Next · {formatTime(c.next.start)}</small>
                        <span>{c.next.title}</span>
                      </button>
                    )}
                    {np && (
                      <button className="btn-icon" onClick={() => setSelected({ p: np, c })} aria-label="Programme info"><Icon name="info" size={18} /></button>
                    )}
                    <button className={`btn-icon ${c.favorite ? 'fav-on' : ''}`} onClick={() => toggleFav(c)} aria-label={c.favorite ? 'Unfavourite' : 'Favourite'}>
                      <Icon name={c.favorite ? 'starFill' : 'star'} size={18} />
                    </button>
                  </li>
                );
              })}
              {loading && Array.from({ length: 6 }).map((_, i) => <li key={`s${i}`} className="channel-row"><Skeleton h={56} w="100%" /></li>)}
            </ul>
          )}
          <div ref={sentinel} className="sentinel" />
        </div>
      </div>
      {selected && <ProgramModal program={selected.p} channel={selected.c} onClose={() => setSelected(null)} />}
    </div>
  );
}
