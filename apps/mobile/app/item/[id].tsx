import { router, useLocalSearchParams } from 'expo-router';
import React, { useCallback, useEffect } from 'react';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Screen } from '@/components/Screen';
import { ErrorState, Loading } from '@/components/States';
import { CollectionDetail } from '@/screens/detail/CollectionDetail';
import { ArtistDetail, TrackListDetail } from '@/screens/detail/MusicDetail';
import { ShowDetail } from '@/screens/detail/ShowDetail';
import { VideoDetail } from '@/screens/detail/VideoDetail';
import { on } from '@/utils/events';

export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const q = useQuery(`item:${id}`, (api) => api.item(id), { staleMs: 10000 });
  const item = q.data;
  // Seasons render inside their show with that season selected.
  const parentShow = useQuery(item?.type === 'season' && item.parentId ? `item:${item.parentId}` : null, (api) => api.item(item!.parentId!));

  const setUserData = useCallback((ud: UserItemData) => q.setData((prev) => (prev ? { ...prev, userData: ud } : prev)), [q]);
  useEffect(() => on('userdata', (e) => e.itemId === id && setUserData(e.userData)), [id, setUserData]);

  // A track opens its album.
  useEffect(() => {
    if (item?.type === 'track' && item.parentId) router.replace(`/item/${item.parentId}` as never);
  }, [item]);

  return <Screen padTop={false}>{render()}</Screen>;

  function render() {
    if (q.loading && !item) return <Loading />;
    if (q.error && !item) return <ErrorState error={q.error} onRetry={q.refresh} />;
    if (!item) return null;
    switch (item.type) {
      case 'show':
        return <ShowDetail show={item} onUserData={setUserData} />;
      case 'season':
        return parentShow.data ? <ShowDetail show={parentShow.data as Item} initialSeasonId={item.id} onUserData={() => undefined} /> : <Loading />;
      case 'album':
      case 'playlist':
        return <TrackListDetail item={item} onUserData={setUserData} />;
      case 'artist':
        return <ArtistDetail item={item} onUserData={setUserData} />;
      case 'collection':
        return <CollectionDetail item={item} onUserData={setUserData} />;
      case 'track':
        return <Loading />;
      default:
        return <VideoDetail item={item} onUserData={setUserData} />;
    }
  }
}
