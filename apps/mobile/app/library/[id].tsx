import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, ScrollView } from 'react-native';
import type { Item, ItemQuery, ItemSort } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Chip } from '@/components/Chip';
import { MediaCard, cardVariantFor } from '@/components/MediaCard';
import { OptionSheet } from '@/components/OptionSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { browseTypes } from '@/utils/library';
import { openDj } from '@/utils/nav';

const SORTS: { key: ItemSort; label: string; order: 'asc' | 'desc' }[] = [
  { key: 'title', label: 'Title', order: 'asc' },
  { key: 'addedAt', label: 'Date added', order: 'desc' },
  { key: 'releaseDate', label: 'Release date', order: 'desc' },
  { key: 'year', label: 'Year', order: 'desc' },
  { key: 'rating', label: 'Rating', order: 'desc' },
  { key: 'lastPlayed', label: 'Last played', order: 'desc' },
  { key: 'random', label: 'Random', order: 'asc' },
];

const PAGE = 60;
type Filter = 'all' | 'unplayed' | 'played' | 'favorites';

export default function LibraryScreen() {
  const t = useTheme();
  const api = useApi();
  const params = useLocalSearchParams<{ id: string; sort?: ItemSort; genre?: string }>();
  const libs = useQuery('libraries', (a) => a.libraries());
  const lib = libs.data?.find((l) => l.id === params.id);
  const tabs = lib ? browseTypes(lib) : [];
  const [tab, setTab] = useState(0);
  const [sort, setSort] = useState<ItemSort>(params.sort ?? 'title');
  const [order, setOrder] = useState<'asc' | 'desc'>(SORTS.find((s) => s.key === (params.sort ?? 'title'))?.order ?? 'asc');
  const [genre, setGenre] = useState<string | null>(params.genre ?? null);
  const [filter, setFilter] = useState<Filter>('all');
  const [sheet, setSheet] = useState<'sort' | 'genre' | 'filter' | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [nonce, setNonce] = useState(0);
  const loadingMore = useRef(false);
  const genres = useQuery(lib ? `genres:${lib.id}` : null, (a) => a.genres(lib!.id), { staleMs: 300000 });

  const type = tabs[tab]?.type;
  const query = useMemo<ItemQuery | null>(
    () =>
      lib && type
        ? {
            libraryId: lib.id,
            type,
            sort,
            order,
            genre: genre ?? undefined,
            played: filter === 'played' ? true : filter === 'unplayed' ? false : undefined,
            favorite: filter === 'favorites' ? true : undefined,
          }
        : null,
    [lib, type, sort, order, genre, filter],
  );

  useEffect(() => {
    if (!query) return;
    const ctrl = new AbortController();
    setLoading(true);
    setError(null);
    api
      .items({ ...query, limit: PAGE, offset: 0 }, ctrl.signal)
      .then((r) => {
        setItems(r.items);
        setTotal(r.total);
      })
      .catch((e) => !ctrl.signal.aborted && setError(e))
      .finally(() => !ctrl.signal.aborted && setLoading(false));
    return () => ctrl.abort();
  }, [api, query, nonce]);

  const loadMore = useCallback(async () => {
    if (!query || loadingMore.current || items.length >= total) return;
    loadingMore.current = true;
    try {
      const r = await api.items({ ...query, limit: PAGE, offset: items.length });
      setItems((prev) => [...prev, ...r.items.filter((i) => !prev.some((p) => p.id === i.id))]);
      setTotal(r.total);
    } catch {
      /* ignore; user can scroll again */
    } finally {
      loadingMore.current = false;
    }
  }, [api, query, items.length, total]);

  if (libs.loading && !libs.data) return <Loading />;
  if (!lib) return <ErrorState error="Library not found" />;

  const variant = type ? cardVariantFor({ type } as Item) : 'poster';
  const minCard = variant === 'landscape' ? t.card.landscapeWidth : variant === 'square' ? t.card.squareSize : t.card.posterWidth;
  const avail = t.width - t.space.gutter * 2;
  const cols = Math.max(2, Math.floor((avail + t.card.gap) / (minCard + t.card.gap)));
  const cardW = Math.floor((avail - t.card.gap * (cols - 1)) / cols);
  const sortLabel = SORTS.find((s) => s.key === sort)?.label ?? 'Sort';

  return (
    <Screen>
      <ScreenHeader title={lib.name} subtitle={total ? `${total.toLocaleString()} ${tabs[tab]?.label.toLowerCase() ?? 'items'}` : undefined} />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm }} style={{ flexGrow: 0 }}>
        {tabs.length > 1 ? tabs.map((tb, i) => <Chip key={tb.key} label={tb.label} selected={i === tab} onPress={() => setTab(i)} hasTVPreferredFocus={i === 0} />) : null}
        <Chip label={`${sortLabel} ${order === 'asc' ? '↑' : '↓'}`} icon="swap-vertical" onPress={() => setSheet('sort')} hasTVPreferredFocus={tabs.length <= 1} />
        <Chip label={genre ?? 'All genres'} icon="pricetags-outline" selected={!!genre} onPress={() => setSheet('genre')} />
        <Chip label={{ all: 'All', unplayed: 'Unwatched', played: 'Watched', favorites: 'Favourites' }[filter]} icon="filter" selected={filter !== 'all'} onPress={() => setSheet('filter')} />
        {lib.type === 'music' ? <Chip label="DJ" icon="disc-outline" onPress={() => openDj()} /> : null}
      </ScrollView>

      {loading && !items.length ? (
        <Loading />
      ) : error ? (
        <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />
      ) : !items.length ? (
        <EmptyState title="Nothing matches" message="Try another filter or genre." action="Clear filters" onAction={() => { setGenre(null); setFilter('all'); }} />
      ) : (
        <FlatList
          key={`${cols}-${variant}`}
          data={items}
          numColumns={cols}
          keyExtractor={(i) => i.id}
          columnWrapperStyle={{ gap: t.card.gap }}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, gap: t.isTV ? t.space.lg : t.space.md, paddingTop: t.space.sm }}
          renderItem={({ item }) => <MediaCard item={item} width={cardW} />}
          onEndReached={loadMore}
          onEndReachedThreshold={1.5}
          initialNumToRender={cols * 4}
          windowSize={7}
          removeClippedSubviews={!t.isTV}
          ListFooterComponent={items.length < total ? <ActivityIndicator style={{ margin: t.space.lg }} color={t.colors.primary} /> : undefined}
        />
      )}

      <OptionSheet
        visible={sheet === 'sort'}
        title="Sort by"
        options={SORTS.map((s) => ({ key: s.key, label: s.label, selected: s.key === sort, description: s.key === sort ? (order === 'asc' ? 'Ascending — tap to reverse' : 'Descending — tap to reverse') : undefined }))}
        onSelect={(k) => {
          if (k === sort) setOrder((o) => (o === 'asc' ? 'desc' : 'asc'));
          else {
            setSort(k);
            setOrder(SORTS.find((s) => s.key === k)?.order ?? 'asc');
          }
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'genre'}
        title="Genre"
        options={[{ key: '__all', label: 'All genres', selected: !genre }, ...(genres.data ?? []).map((g) => ({ key: g, label: g, selected: g === genre }))]}
        onSelect={(k) => {
          setGenre(k === '__all' ? null : k);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet<Filter>
        visible={sheet === 'filter'}
        title="Show"
        options={[
          { key: 'all', label: 'Everything', selected: filter === 'all', icon: 'apps-outline' },
          { key: 'unplayed', label: 'Unwatched', selected: filter === 'unplayed', icon: 'eye-off-outline' },
          { key: 'played', label: 'Watched', selected: filter === 'played', icon: 'checkmark-done-outline' },
          { key: 'favorites', label: 'Favourites', selected: filter === 'favorites', icon: 'heart-outline' },
        ]}
        onSelect={(k) => {
          setFilter(k);
          setSheet(null);
        }}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}
