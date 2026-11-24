import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import type { Item, ItemQuery, ItemSort, Library } from '@mediamax/shared';
import { api } from '../api/endpoints';
import { useApp } from '../state/app';
import { useToast } from '../state/toast';
import { useAsync, useInfiniteSentinel, useServerEvent } from '../hooks';
import { CardSkeleton, PosterCard } from '../components/Cards';
import { EmptyState, ErrorState, Badge, Button, Chip, IconButton, Img, ProgressBar, Segmented } from '../components/ui';
import { openPlayRules } from '../components/PlayRules';
import { YourDjCard, useYourDjAvailable } from '../components/YourDjCard';
import { Icon } from '../components/Icon';
import { isIptvLibrary, isSquare, itemLink, itemSubtitle, libraryIcon, libraryItemTypes, posterFor, progressPct } from '../utils/items';
import { formatDuration } from '../utils/format';
import { ListenBrainzRow } from '../components/ListenBrainz';
import { LibraryDecideButtons } from '../components/decide/DecideBar';
import { peekHandlers } from '../components/Peek';
import { useMusicActions } from '../player/music';
import '../styles/screens-browse.css';

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
type View = 'grid' | 'list' | 'az';
/** Parameters remembered per library (per device): the view, sort and filters. `letter` and `series` are not. */
const REMEMBERED = ['view', 'sort', 'order', 'genre', 'year', 'played', 'fav', 'layout'] as const;
const memoryKey = (libraryId: string) => `vibe.library.${libraryId}`;

function readMemory(libraryId: string): Record<string, string> | null {
  try {
    const raw = localStorage.getItem(memoryKey(libraryId));
    return raw ? (JSON.parse(raw) as Record<string, string>) : null;
  } catch {
    return null;
  }
}
function writeMemory(libraryId: string, params: URLSearchParams) {
  try {
    const keep: Record<string, string> = {};
    for (const k of REMEMBERED) {
      const v = params.get(k);
      if (v) keep[k] = v;
    }
    if (Object.keys(keep).length) localStorage.setItem(memoryKey(libraryId), JSON.stringify(keep));
    else localStorage.removeItem(memoryKey(libraryId));
  } catch {
    /* private mode */
  }
}

/** The letter an item files under in the A–Z view (matches the server's `letter` filter: digits and symbols → #). */
function letterOf(item: Item): string {
  const t = (item.sortTitle || item.title || '').trim().replace(/^(the|a|an)\s+/i, '');
  const c = t.charAt(0).toUpperCase();
  return c >= 'A' && c <= 'Z' ? c : '#';
}

function nounFor(library: Library | undefined, artists: boolean, n: number): string {
  const one = n === 1;
  switch (library?.type) {
    case 'movies': return one ? 'movie' : 'movies';
    case 'shows': return one ? 'show' : 'shows';
    case 'music': return artists ? (one ? 'artist' : 'artists') : one ? 'album' : 'albums';
    case 'audiobooks': return one ? 'book' : 'books';
    case 'photos': return one ? 'photo' : 'photos';
    case 'podcasts': return one ? 'podcast' : 'podcasts';
    default: return one ? 'item' : 'items';
  }
}

/** One title as a list row: thumbnail, title + meta, time / watched state. */
function ListRow({ item }: { item: Item }) {
  const pct = progressPct(item);
  const played = !!item.userData?.played;
  const unplayed = item.userData?.unplayedCount;
  const square = isSquare(item);
  const meta = [itemSubtitle(item), item.contentRating, item.genres?.slice(0, 2).join(', ')].filter(Boolean).join(' · ');
  return (
    <li>
      <Link to={itemLink(item)} className="lib-list-row" data-nav {...peekHandlers(item)}>
        <span className={`lib-list-art ${square ? 'square' : ''}`}>
          <Img src={posterFor(item)} width={120} alt="" fallback={<Icon name={libraryIconForItem(item)} size={18} />} />
          {pct > 0 && !played && <ProgressBar value={pct} className="card-progress" />}
        </span>
        <span className="lib-list-text">
          <span className="lib-list-title">{item.title}</span>
          <span className="lib-list-meta">{meta}</span>
        </span>
        <span className="lib-list-side">
          {item.communityRating != null && <span className="lib-list-rating"><Icon name="starFill" size={12} /> {item.communityRating.toFixed(1)}</span>}
          {item.durationMs && item.type !== 'show' ? <span className="tabular">{formatDuration(item.durationMs)}</span> : null}
          {item.userData?.favorite && <Icon name="heartFill" size={14} className="lib-list-fav" aria-label="Favourite" />}
          {played ? (
            <span className="lib-list-watched" title="Watched"><Icon name="check" size={13} /><span className="sr-only">Watched</span></span>
          ) : unplayed != null && unplayed > 0 ? (
            <span className="lib-list-count" title={`${unplayed} unwatched`}>{unplayed}</span>
          ) : null}
        </span>
      </Link>
    </li>
  );
}

function libraryIconForItem(item: Item) {
  return item.type === 'album' || item.type === 'artist' ? 'music' : item.type === 'photo' ? 'image' : item.type === 'audiobook' ? 'book' : item.type === 'show' ? 'shows' : 'film';
}

export function LibraryPage() {
  const { libraryId = '' } = useParams();
  const { libraries, user } = useApp();
  const toast = useToast();
  const library = libraries.find((l) => l.id === libraryId);
  const [params, setParams] = useSearchParams();

  // Restore what this library last showed (view, sort, filters) when the URL doesn't say; remember changes.
  const [restoredFor, setRestoredFor] = useState<string | null>(null);
  useEffect(() => {
    if (restoredFor === libraryId) return;
    const hasState = REMEMBERED.some((k) => params.has(k)) || params.has('series') || params.has('letter');
    const mem = hasState ? null : readMemory(libraryId);
    if (mem && Object.keys(mem).length) setParams(new URLSearchParams(mem), { replace: true });
    setRestoredFor(libraryId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [libraryId]);
  const ready = restoredFor === libraryId;
  useEffect(() => {
    if (ready) writeMemory(libraryId, params);
  }, [params, libraryId, ready]);

  const isPhotos = library?.type === 'photos';
  const isMusic = library?.type === 'music';
  const djAvailable = useYourDjAvailable();
  const music = useMusicActions();
  const rawView = params.get('layout') as View | null;
  const view: View = isPhotos ? 'grid' : rawView === 'list' || rawView === 'az' ? rawView : 'grid';
  const az = view === 'az';
  const sort = az ? 'title' : (params.get('sort') as ItemSort) || 'title';
  const order = az ? 'asc' : (params.get('order') as 'asc' | 'desc') || (sort === 'title' ? 'asc' : 'desc');
  const genre = params.get('genre') || '';
  const year = params.get('year') || '';
  const played = params.get('played') || '';
  const fav = params.get('fav') === '1';
  const letter = params.get('letter') || '';
  /** Music only: albums (default) or artists. */
  const musicView = params.get('view') || '';
  /** Book series (audiobooks): sorted by series order unless a sort is picked. */
  const series = params.get('series') || '';
  const seriesOrder = !!series && !params.get('sort') && !az;
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<number | null>(null);
  const reqId = useRef(0);

  const genres = useAsync(() => api.items.genres(libraryId).catch(() => [] as string[]), [libraryId]);

  const artists = isMusic && musicView === 'artists';
  const type = isMusic ? (artists ? 'artist' : 'album') : library ? libraryItemTypes(library.type) : undefined;

  const set = (k: string, v: string | null) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p, { replace: true });
  };
  /** Drop the filters only: sort, order, the view and the music view (albums / artists) stay. */
  const clearFilters = () => {
    const p = new URLSearchParams(params);
    for (const k of ['genre', 'year', 'played', 'fav', 'letter', 'series']) p.delete(k);
    setParams(p, { replace: true });
  };

  const query = useCallback(
    (offset: number): ItemQuery => ({
      libraryId,
      type,
      sort: seriesOrder ? undefined : sort,
      order: seriesOrder ? undefined : order,
      series: series || undefined,
      genre: genre || undefined,
      year: year ? Number(year) : undefined,
      played: played === 'played' ? true : played === 'unplayed' ? false : undefined,
      favorite: fav || undefined,
      letter: letter || undefined,
      limit: PAGE,
      offset,
    }),
    [libraryId, type, sort, order, genre, year, played, fav, letter, series, seriesOrder],
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
    if (!ready) return;
    setItems([]);
    setTotal(0);
    void load(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, ready]);

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
  const shape = isMusic || isPhotos || library?.type === 'audiobooks' || library?.type === 'podcasts' ? 'square' : library?.type === 'videos' ? 'landscape' : 'poster';

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

  const listen = isMusic || library?.type === 'audiobooks' || library?.type === 'podcasts';
  const filtered = !!(genre || year || played || fav || letter || series);
  const scanning = scanProgress != null || !!library?.scanning;
  const countLabel = loading && !items.length ? 'Loading…' : `${total.toLocaleString()} ${nounFor(library, artists, total)}${filtered ? ' match' : ''}`;
  const showJump = sort === 'title' && !seriesOrder && order === 'asc';
  const skeletons = loading ? Array.from({ length: items.length ? 6 : 18 }).map((_, i) => <CardSkeleton key={`s${i}`} shape={shape} />) : null;

  const grid = (list: Item[], key?: string) => (
    <div className={`grid grid-${shape}`} key={key}>
      {list.map((it) => <PosterCard key={it.id} item={it} shape={shape} width="100%" />)}
      {!key && skeletons}
    </div>
  );

  let body;
  if (error && !items.length) body = <ErrorState message={error} onRetry={() => load(true)} />;
  else if (!loading && ready && !items.length) {
    body = (
      <EmptyState
        icon="filter"
        title={filtered ? 'No matches' : 'Nothing here yet'}
        message={filtered ? 'Try clearing some filters.' : 'This library is empty. Items appear here once a scan finds them.'}
        action={filtered ? <Button icon="x" onClick={clearFilters}>Clear filters</Button> : undefined}
      />
    );
  } else if (view === 'list') {
    body = (
      <>
        <ul className="lib-list" aria-label={`${library?.name ?? 'Library'} titles`}>
          {items.map((it) => <ListRow key={it.id} item={it} />)}
        </ul>
        {loading && <div className="lib-list-loading">{Array.from({ length: items.length ? 3 : 10 }).map((_, i) => <div key={i} className="skeleton lib-list-skeleton" />)}</div>}
      </>
    );
  } else if (az) {
    // Letter sections over the loaded pages (the server sorts by title; paging continues across letters).
    const groups: { letter: string; items: Item[] }[] = [];
    for (const it of items) {
      const l = letterOf(it);
      const last = groups[groups.length - 1];
      if (last && last.letter === l) last.items.push(it);
      else groups.push({ letter: l, items: [it] });
    }
    body = (
      <>
        {groups.map((g, i) => (
          <Fragment key={`${g.letter}-${i}`}>
            <h2 className="lib-letter" id={`letter-${g.letter === '#' ? 'num' : g.letter}`}>{g.letter}</h2>
            {grid(g.items, `${g.letter}-${i}`)}
          </Fragment>
        ))}
        {loading && <div className={`grid grid-${shape}`}>{skeletons}</div>}
      </>
    );
  } else body = grid(items);

  return (
    <div className="page library-page">
      <header className="page-header lib-header">
        <div className="page-header-text">
          <span className="page-header-eyebrow">Library</span>
          <h1 className="page-header-title">
            {library && <Icon name={libraryIcon(library.type)} size={26} />}
            {library?.name ?? 'Library'}
            {library && isIptvLibrary(library.type) && <Badge tone="accent">IPTV</Badge>}
          </h1>
          <p className="page-header-sub" aria-live="polite">
            <span className="tabular">{countLabel}</span>
            {scanning && <span className="lib-scanning"><Icon name="refresh" size={13} className="spin" /> Scanning{scanProgress != null ? ` ${Math.round(scanProgress)}%` : '…'}</span>}
          </p>
        </div>
        <div className="page-header-actions">
          <LibraryDecideButtons library={library} genre={genre} />
          {isMusic && library && (
            <Button variant="secondary" icon="music" title="Play this library as one continuous mix, in a smart order (tempo, key, energy)"
              onClick={() => void music.playAsMix(genre ? { label: genre, source: { type: 'genre', id: genre, libraryId: library.id } } : { label: library.name, source: { type: 'library', id: library.id } })}>
              Mix
            </Button>
          )}
          {isMusic && library && (
            <IconButton icon="filter" label="Play rules for mixes and Your DJ" onClick={() => openPlayRules()} />
          )}
          {user?.isAdmin && (
            <Button variant="ghost" icon="refresh" onClick={scan} disabled={scanProgress != null} title="Scan this library for new files">
              {scanProgress != null ? `Scanning ${Math.round(scanProgress)}%` : 'Scan'}
            </Button>
          )}
        </div>
      </header>

      {isMusic && djAvailable && !genre && !series && <YourDjCard compact />}

      <div className="lib-toolbar" role="toolbar" aria-label="View, sort and filter">
        <div className="lib-filters">
          {isMusic && (
            <Segmented
              label="Show"
              value={artists ? 'artists' : 'albums'}
              onChange={(v) => set('view', v === 'artists' ? 'artists' : null)}
              options={[{ value: 'albums', label: 'Albums' }, { value: 'artists', label: 'Artists' }]}
            />
          )}
          {series && (
            <Chip active icon="book" onRemove={() => set('series', null)} title="Show the whole library">
              Series: {series}
            </Chip>
          )}
          {!isPhotos && (
            <>
              <Chip active={played === 'unplayed'} onClick={() => set('played', played === 'unplayed' ? null : 'unplayed')}>{listen ? 'Unplayed' : 'Unwatched'}</Chip>
              <Chip active={played === 'played'} onClick={() => set('played', played === 'played' ? null : 'played')}>{listen ? 'Played' : 'Watched'}</Chip>
            </>
          )}
          <Chip active={fav} icon={fav ? 'heartFill' : 'heart'} onClick={() => set('fav', fav ? null : '1')}>Favourites</Chip>
          <label className={`chip chip-select ${genre ? 'active' : ''}`}>
            <span className="sr-only">Genre</span>
            <select value={genre} onChange={(e) => set('genre', e.target.value || null)}>
              <option value="">Genre</option>
              {(genres.data ?? []).map((g) => <option key={g} value={g}>{g}</option>)}
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
          <label className={`chip chip-select ${year ? 'active' : ''}`}>
            <span className="sr-only">Year</span>
            <select value={year} onChange={(e) => set('year', e.target.value || null)}>
              <option value="">Year</option>
              {years.map((y) => <option key={y} value={y}>{y}</option>)}
            </select>
            <Icon name="chevronDown" size={14} />
          </label>
          {letter && <Chip active onRemove={() => set('letter', null)} title="Show every letter">Starts with {letter}</Chip>}
          {filtered && (
            <button type="button" className="btn btn-ghost btn-sm lib-clear" onClick={clearFilters}>
              Clear all
            </button>
          )}
        </div>
        <div className="lib-view-tools">
          {!az && (
            <div className="lib-sort">
              <label className="chip chip-select chip-plain">
                <Icon name="sort" size={14} />
                <span className="sr-only">Sort by</span>
                <select value={seriesOrder ? '' : sort} onChange={(e) => set('sort', e.target.value || null)}>
                  {series && <option value="">Series order</option>}
                  {SORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                </select>
                <Icon name="chevronDown" size={14} />
              </label>
              <button
                type="button"
                className="btn-icon btn-icon-sm"
                disabled={seriesOrder}
                onClick={() => set('order', order === 'asc' ? 'desc' : 'asc')}
                aria-label={order === 'asc' ? 'Ascending, switch to descending' : 'Descending, switch to ascending'}
                title={order === 'asc' ? 'Ascending' : 'Descending'}
              >
                <Icon name={order === 'asc' ? 'chevronUp' : 'chevronDown'} size={16} />
              </button>
            </div>
          )}
          {!isPhotos && (
            <Segmented
              label="View"
              className="lib-view-toggle"
              value={view}
              onChange={(v) => set('layout', v === 'grid' ? null : v)}
              options={[
                { value: 'grid', label: 'Posters', icon: 'grid', iconOnly: true },
                { value: 'list', label: 'List', icon: 'list', iconOnly: true },
                { value: 'az', label: 'A–Z', title: 'A–Z index' },
              ]}
            />
          )}
        </div>
      </div>

      {isMusic && !filtered && <ListenBrainzRow />}

      <div className="library-body">
        <div className="library-grid-wrap">
          {body}
          <div ref={sentinel} className="sentinel" />
        </div>
        {showJump && (
          <nav className="jumpbar" aria-label="Jump to letter">
            <button className={!letter ? 'active' : ''} onClick={() => set('letter', null)} title="All letters" aria-label="All letters" aria-pressed={!letter}>•</button>
            {LETTERS.map((l) => (
              <button key={l} className={letter === l ? 'active' : ''} aria-pressed={letter === l} onClick={() => set('letter', letter === l ? null : l)}>
                {l}
              </button>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}
