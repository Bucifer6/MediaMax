import { Link } from 'react-router-dom';
import { api } from '../api/endpoints';
import { useAsync, useServerEvent } from '../hooks';
import { CardSkeleton, PosterCard } from '../components/Cards';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { Icon } from '../components/Icon';
import '../styles/screens-browse.css';

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
      <PageHeader
        title="My List"
        subtitle={list.data && list.data.total > 0 ? <span className="tabular">{list.data.total} title{list.data.total === 1 ? '' : 's'} saved for later</span> : 'Saved for later'}
      />
      {list.loading && !list.data ? (
        <div className="grid grid-poster" aria-busy="true">{Array.from({ length: 12 }).map((_, i) => <CardSkeleton key={i} />)}</div>
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
