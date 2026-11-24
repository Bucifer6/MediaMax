/**
 * Discover: trending titles (or search results) from TMDB with availability and
 * request state, and a sheet to request what isn't in the library yet.
 * Shown only when the server enables `features.requests`.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Keyboard, View } from 'react-native';
import type { DiscoverResult, MediaRequest, RequestMediaType } from '@/api/types';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { DiscoverCard, ErrorBanner, RequestSheet, describeRequestError } from '@/components/Requests';
import { Screen } from '@/components/Screen';
import { EmptyState } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useApi, useCapabilities } from '@/state/session';
import { useTheme } from '@/theme';

type Kind = RequestMediaType | 'all';
const KINDS: { key: Kind; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'movie', label: 'Movies' },
  { key: 'show', label: 'Shows' },
];
const keyOf = (r: DiscoverResult) => `${r.mediaType}:${r.tmdbId}`;

export default function DiscoverScreen() {
  const t = useTheme();
  const api = useApi();
  const caps = useCapabilities();
  const bottom = useTabBarSpace();
  const [q, setQ] = useState('');
  const [term, setTerm] = useState('');
  const [kind, setKind] = useState<Kind>('all');
  const [results, setResults] = useState<DiscoverResult[]>([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [moreError, setMoreError] = useState<unknown>(null);
  const [selected, setSelected] = useState<DiscoverResult | null>(null);
  const [retry, setRetry] = useState(0);
  const reqId = useRef(0);

  // Debounce typing.
  useEffect(() => {
    const timer = setTimeout(() => setTerm(q.trim()), 400);
    return () => clearTimeout(timer);
  }, [q]);

  const fetchPage = useCallback(
    async (p: number, signal?: AbortSignal) => api.discover({ q: term || undefined, type: kind, page: p }, signal),
    [api, term, kind],
  );

  // First page whenever the search or the type changes.
  useEffect(() => {
    if (!caps.requests) return;
    const ctrl = new AbortController();
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    setMoreError(null);
    fetchPage(1, ctrl.signal)
      .then((r) => {
        if (id !== reqId.current) return;
        setResults(r.results);
        setPage(r.page);
        setTotalPages(r.totalPages);
      })
      .catch((e) => {
        if (ctrl.signal.aborted || id !== reqId.current) return;
        setResults([]);
        setError(e);
      })
      .finally(() => id === reqId.current && setLoading(false));
    return () => ctrl.abort();
  }, [fetchPage, caps.requests, retry]);

  const loadMore = useCallback((force = false) => {
    if (loading || loadingMore || page >= totalPages || (moreError && !force)) return;
    const id = reqId.current;
    setMoreError(null);
    setLoadingMore(true);
    fetchPage(page + 1)
      .then((r) => {
        if (id !== reqId.current) return;
        setResults((prev) => {
          const seen = new Set(prev.map(keyOf));
          return [...prev, ...r.results.filter((x) => !seen.has(keyOf(x)))];
        });
        setPage(r.page);
        setTotalPages(r.totalPages);
      })
      .catch((e) => id === reqId.current && setMoreError(e))
      .finally(() => setLoadingMore(false));
  }, [loading, loadingMore, page, totalPages, moreError, fetchPage]);

  const onPress = useCallback((r: DiscoverResult) => {
    if (r.availableItemId) router.push(`/item/${r.availableItemId}` as never);
    else setSelected(r);
  }, []);

  const onRequested = useCallback((r: DiscoverResult, req: MediaRequest) => {
    const k = keyOf(r);
    setResults((prev) => prev.map((x) => (keyOf(x) === k ? { ...x, requestId: req.id, requestStatus: req.status, availableItemId: req.itemId ?? x.availableItemId } : x)));
    setSelected((s) => (s && keyOf(s) === k ? { ...s, requestId: req.id, requestStatus: req.status } : s));
  }, []);

  const openRequests = useCallback(() => {
    setSelected(null);
    router.push('/requests' as never);
  }, []);

  if (!caps.requests) {
    return (
      <Screen padTop={!t.isTV}>
        <EmptyState icon="compass-outline" title="Discover is off" message="Your server doesn't take media requests." />
      </Screen>
    );
  }

  const cols = t.isTV ? 7 : t.wide ? 5 : 3;
  const gap = t.card.gap;
  const cardW = Math.floor((t.width - t.space.gutter * 2 - gap * (cols - 1)) / cols);
  const errInfo = error ? describeRequestError(error) : null;

  return (
    <Screen padTop={!t.isTV}>
      <View style={{ paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm, gap: t.space.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          {!t.isTV ? (
            <T variant="title" style={{ flex: 1 }}>
              Discover
            </T>
          ) : null}
          {t.isTV ? (
            <View style={{ flex: 1 }}>
              <Input value={q} onChangeText={setQ} placeholder="Search movies and shows to request…" icon="search" autoCorrect={false} returnKeyType="search" />
            </View>
          ) : null}
          <Button label="My requests" icon="list-outline" size="sm" variant="secondary" onPress={openRequests} />
        </View>
        {!t.isTV ? (
          <Input value={q} onChangeText={setQ} placeholder="Search movies and shows to request…" icon="search" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => Keyboard.dismiss()} clearButtonMode="while-editing" />
        ) : null}
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          {KINDS.map((k) => (
            <Chip key={k.key} label={k.label} selected={kind === k.key} onPress={() => setKind(k.key)} />
          ))}
        </View>
      </View>

      {errInfo ? (
        <EmptyState icon={errInfo.icon} title={errInfo.title} message={errInfo.message} action="Try again" onAction={() => setRetry((n) => n + 1)} />
      ) : (
        <FlatList
          key={cols}
          data={results}
          keyExtractor={keyOf}
          numColumns={cols}
          renderItem={({ item }) => <DiscoverCard result={item} width={cardW} onPress={onPress} />}
          columnWrapperStyle={{ gap }}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingTop: t.isTV ? t.s(14) : t.space.xs, paddingBottom: bottom, rowGap: t.space.lg }}
          onEndReached={() => loadMore()}
          onEndReachedThreshold={0.6}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
          removeClippedSubviews={!t.isTV}
          ListHeaderComponent={
            !loading && results.length ? (
              <T variant="heading" style={{ marginBottom: t.space.xs }}>
                {term ? `Results for “${term}”` : 'Trending'}
              </T>
            ) : undefined
          }
          ListEmptyComponent={
            loading ? (
              <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xl }} />
            ) : (
              <EmptyState icon="sad-outline" title="Nothing found" message={term ? `No movies or shows matched “${term}”.` : 'Nothing is trending right now.'} />
            )
          }
          ListFooterComponent={
            loadingMore ? (
              <ActivityIndicator color={t.colors.primary} style={{ marginVertical: t.space.lg }} />
            ) : moreError ? (
              <View style={{ gap: t.space.sm, marginTop: t.space.md }}>
                <ErrorBanner error={moreError} />
                <Button label="Load more" icon="refresh" variant="secondary" onPress={() => loadMore(true)} />
              </View>
            ) : undefined
          }
        />
      )}

      <RequestSheet result={selected} onClose={() => setSelected(null)} onRequested={onRequested} onOpenRequests={openRequests} />
    </Screen>
  );
}
