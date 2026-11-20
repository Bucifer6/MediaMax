import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import type { Item, ItemQuery, ItemSort } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useInfiniteSentinel, useServerEvent } from '../hooks';
import { CardSkeleton, PosterCard } from '../components/Cards';
import { EmptyState, ErrorState, Badge } from '../components/ui';
import { Icon } from '../components/Icon';
import { isIptvLibrary, libraryIcon, libraryItemTypes } from '../utils/items';

const PAGE = 60;
const LETTERS = ['#', ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('')];
const SORTS: { value: ItemSort; label: string }[] = [
  { value: 'title', label: 'Title' },
  { value: 'addedAt', label: 'Date added' },
  { value: 'releaseDate', label: 'Release date' },
  { value: 'year', label: 'Year' },
  { value: 'rating', label: 'Rating' },
  { value: 'lastPlayed', label: 'Last played' },
  { value: 'random', label: 'Random' },
];

export function LibraryPage() {
  const { libraryId = '' } = useParams();
  const { libraries, user } = useApp();
  const toast = useToast();
  const library = libraries.find((l) => l.id === libraryId);
  const [params, setParams] = useSearchParams();
  const sort = (params.get('sort') as ItemSort) || 'title';
  const order = (params.get('order') as 'asc' | 'desc') || (sort === 'title' ? 'asc' : 'desc');
  const genre = params.get('genre') || '';
  const year = params.get('year') || '';
  const played = params.get('played') || '';
  const fav = params.get('fav') === '1';
  const letter = params.get('letter') || '';
  const view = params.get('view') || '';
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<number | null>(null);
  const reqId = useRef(0);

  const genres = useAsync(() => api.items.genres(libraryId).catch(() => [] as string[]), [libraryId]);

  const type = library?.type === 'music' ? (view === 'artists' ? 'artist' : 'album') : library ? libraryItemTypes(library.type) : undefined;

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };

  const query = useCallback(
    (offset: number): ItemQuery => ({
      libraryId,
      type,
      sort,
      order,
      genre: genre || undefined,
      year: year ? Number(year) : undefined,
      played: played === 'played' ? true : played === 'unplayed' ? false : undefined,
      favorite: fav || undefined,
      letter: letter || undefined,
      limit: PAGE,
      offset,
    }),
    [libraryId, type, sort, order, genre, year, played, fav, letter],
  );

  const load = useCallback(
    async (reset: boolean) => {
      const id = ++reqId.current;
      setLoading(true);
      setError(null);
      try {
        const res = await api.items.query(query(reset ? 0 : items.length));
        if (id !== reqId.current) return;
        setItems((prev) => (reset ? res.items : [...prev, ...res.items]));
        setTotal(res.total);
      } catch (e) {
        if (id === reqId.current) setError((e as Error).message);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    },
    [query, items.length],
  );

  useEffect(() => {
    setItems([]);
    setTotal(0);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useServerEvent((ev) => {
    if (ev.type === 'library.scan' && ev.libraryId === libraryId) {
      setScanProgress(ev.status === 'finished' ? null : ev.progress ?? 0);
      if (ev.status === 'finished') void load(true);
    }
    if (ev.type === 'userdata.updated') setItems((list) => list.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)));
  });

  const hasMore = items.length < total;
  const sentinel = useInfiniteSentinel(() => {
    if (!loading && hasMore) void load(false);
  }, hasMore && !loading && !error);

  const years: number[] = [];
  for (let y = new Date().getFullYear() + 1; y >= 1920; y--) years.push(y);
  const shape = library?.type === 'music' || library?.type === 'photos' ? 'square' : library?.type === 'videos' ? 'landscape' : 'poster';

  const scan = async () => {
    try {
      await api.libraries.scan(libraryId);
      setScanProgress(0);
      toast.success('Scan started');
    } catch (e) {
      toast.error(e);
    }
  };

  if (!library && libraries.length) {
    return <div className="page"><EmptyState icon="alert" title="Library not found" /></div>;
  }

  return (
    <div className="page library-page">
      <header className="page-head">
        <div className="page-title-wrap">
          {library && <Icon name={libraryIcon(library.type)} size={28} className="page-icon" />}
          <div>
            <h1>
              {library?.name ?? 'Library'} {library && isIptvLibrary(library.type) && <Badge tone="accent">IPTV</Badge>}
            </h1>
            <p className="muted">{loading && !items.length ? 'Loading…' : `${total.toLocaleString()} ${total === 1 ? 'item' : 'items'}`}{scanProgress != null || library?.scanning ? ' · scanning…' : ''}</p>
          </div>
        </div>
        {user?.isAdmin && (
          <button className="btn btn-ghost" onClick={scan} disabled={scanProgress != null}>
            <Icon name="refresh" size={16} className={scanProgress != null ? 'spin' : ''} /> {scanProgress != null ? `Scanning ${Math.round(scanProgress)}%` : 'Scan'}
          </button>
        )}
      </header>

      <div className="filter-bar">
        {library?.type === 'music' && (
          <div className="segmented">
            <button className={view !== 'artists' ? 'active' : ''} onClick={() => set('view', null)}>Albums</button>
            <button className={view === 'artists' ? 'active' : ''} onClick={() => set('view', 'artists')}>Artists</button>
          </div>
        )}
        <div className="select-wrap">
          <Icon name="sort" size={16} />
          <select className="select" value={sort} onChange={(e) => set('sort', e.target.value)} aria-label="Sort by">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
        </div>
        <button className="btn-icon" onClick={() => set('order', order === 'asc' ? 'desc' : 'asc')} aria-label={`Order ${order}`} title={order === 'asc' ? 'Ascending' : 'Descending'}>
          <Icon name={order === 'asc' ? 'chevronUp' : 'chevronDown'} />
        </button>
        <select className="select" value={genre} onChange={(e) => set('genre', e.target.value)} aria-label="Genre">
          <option value="">All genres</option>
          {(genres.data ?? []).map((g) => (
            <option key={g} value={g}>{g}</option>
          ))}
        </select>
        <select className="select" value={year} onChange={(e) => set('year', e.target.value)} aria-label="Year">
          <option value="">Any year</option>
          {years.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
        {library?.type !== 'photos' && (
          <select className="select" value={played} onChange={(e) => set('played', e.target.value)} aria-label="Watched state">
            <option value="">All</option>
            <option value="unplayed">Unwatched</option>
            <option value="played">Watched</option>
          </select>
        )}
        <button className={`chip ${fav ? 'active' : ''}`} onClick={() => set('fav', fav ? null : '1')}>
          <Icon name={fav ? 'heartFill' : 'heart'} size={14} /> Favourites
        </button>
        {(genre || year || played || fav || letter) && (
          <button className="btn btn-ghost btn-sm" onClick={() => setParams(new URLSearchParams(sort !== 'title' ? { sort } : {}), { replace: true })}>
            <Icon name="x" size={14} /> Clear
          </button>
        )}
      </div>

      <div className="library-body">
        <div className="library-grid-wrap">
          {error && !items.length ? (
            <ErrorState message={error} onRetry={() => load(true)} />
          ) : !loading && !items.length ? (
            <EmptyState icon="filter" title="No matches" message={letter || genre || year || played || fav ? 'Try clearing some filters.' : 'This library is empty. Items appear here once a scan finds them.'} />
          ) : (
            <div className={`grid grid-${shape}`}>
              {items.map((it) => (
                <PosterCard key={it.id} item={it} shape={shape} width="100%" />
              ))}
              {loading && Array.from({ length: items.length ? 6 : 18 }).map((_, i) => <CardSkeleton key={`s${i}`} shape={shape} />)}
            </div>
          )}
          <div ref={sentinel} className="sentinel" />
        </div>
        {sort === 'title' && (
          <nav className="jumpbar" aria-label="Jump to letter">
            <button className={!letter ? 'active' : ''} onClick={() => set('letter', null)} title="All">•</button>
            {LETTERS.map((l) => (
              <button key={l} className={letter === l ? 'active' : ''} onClick={() => set('letter', letter === l ? null : l)}>
                {l}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
