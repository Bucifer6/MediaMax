/**
 * My List: the films and shows the viewer saved (GET /watchlist, newest first), the "See all" of the home row.
 * Add or remove from a film's or show's page (the My List button).
 */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList } from 'react-native';
import type { Item } from '@/api/types';
import { useApi } from '@/state/session';
import { MediaCard } from '@/components/MediaCard';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { useTheme } from '@/theme';
import { on } from '@/utils/events';

const PAGE = 60;

export default function MyListScreen() {
  const t = useTheme();
  const api = useApi();
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .watchlist({ limit: PAGE, offset: 0 })
      .then((r) => {
        if (!alive) return;
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => alive && setError(e instanceof Error ? e : new Error(String(e))))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, nonce]);

  // Coming back from an item page where it was removed: refresh.
  useEffect(() => on('userdata', () => setNonce((n) => n + 1)), []);

  const loadMore = useCallback(() => {
    if (loading || items.length >= total) return;
    void api.watchlist({ limit: PAGE, offset: items.length }).then((r) => setItems((cur) => [...cur, ...r.items])).catch(() => undefined);
  }, [api, loading, items.length, total]);

  const avail = t.width - t.space.gutter * 2;
  const cols = Math.max(2, Math.floor((avail + t.card.gap) / (t.card.posterWidth + t.card.gap)));
  const cardW = Math.floor((avail - t.card.gap * (cols - 1)) / cols);

  return (
    <Screen>
      <ScreenHeader title="My List" subtitle={total ? `${total.toLocaleString()} saved` : undefined} />
      {loading && !items.length ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : !items.length ? (
        <EmptyState icon="add-circle-outline" title="Nothing saved yet" message="Use the My List button on a film or show to save it for later." />
      ) : (
        <FlatList
          key={cols}
          data={items}
          numColumns={cols}
          keyExtractor={(i) => i.id}
          columnWrapperStyle={{ gap: t.card.gap }}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, gap: t.isTV ? t.space.lg : t.space.md, paddingTop: t.space.sm }}
          renderItem={({ item, index }) => <MediaCard item={item} width={cardW} hasTVPreferredFocus={index === 0} />}
          onEndReached={loadMore}
          onEndReachedThreshold={1.5}
          initialNumToRender={cols * 4}
          windowSize={7}
          removeClippedSubviews={!t.isTV}
          ListFooterComponent={items.length < total ? <ActivityIndicator style={{ margin: t.space.lg }} color={t.colors.primary} /> : undefined}
        />
      )}
    </Screen>
  );
}
