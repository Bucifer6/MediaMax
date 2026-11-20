import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useAsync, useServerEvent } from '../hooks';
import { PosterCard } from '../components/Cards';
import { EmptyState, ErrorState, Skeleton } from '../components/ui';
import { Icon } from '../components/Icon';

export default function MyListPage() {
  const list = useAsync(() => api.discovery.watchlist({ limit: 500 }), []);
  useServerEvent((ev) => {
    if (ev.type !== 'userdata.updated') return;
    if (!ev.userData.inWatchlist) list.setData((d) => d && { ...d, items: d.items.filter((i) => i.id !== ev.itemId), total: d.items.some((i) => i.id === ev.itemId) ? d.total - 1 : d.total });
    else if (!list.data?.items.some((i) => i.id === ev.itemId)) list.reload();
    else list.setData((d) => d && { ...d, items: d.items.map((i) => (i.id === ev.itemId ? { ...i, userData: ev.userData } : i)) });
  });
  const items = list.data?.items ?? [];
  return (
    <div className="page mylist-page">
      <header className="page-head">
        <div className="page-title-wrap">
          <Icon name="plus" size={28} className="page-icon" />
          <h1>My List</h1>
          {list.data && list.data.total > 0 && <span className="muted">{list.data.total} title{list.data.total === 1 ? '' : 's'}</span>}
        </div>
      </header>
      {list.loading && !list.data ? (
        <div className="grid grid-poster">{Array.from({ length: 12 }).map((_, i) => <Skeleton key={i} className="grid-skeleton" h={260} />)}</div>
      ) : list.error && !list.data ? (
        <ErrorState message={list.error} onRetry={list.reload} />
      ) : !items.length ? (
        <EmptyState
          icon="plus"
          title="Your list is empty"
          message="Add movies and shows you want to watch later with the + My List button. They'll wait for you here and on the home screen."
          action={<Link to="/" className="btn btn-primary"><Icon name="home" size={16} /> Browse home</Link>}
        />
      ) : (
        <div className="grid grid-poster">
          {items.map((it) => (
            <div key={it.id} className="grid-cell">
              <PosterCard item={it} width="100%" />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
