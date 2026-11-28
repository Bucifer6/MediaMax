import { router } from 'expo-router';
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, View } from 'react-native';
import type { Channel } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useApi, useCapabilities } from '@/state/session';
import { useTheme } from '@/theme';
import { formatTime, programProgress } from '@/utils/format';
import { playChannel } from '@/utils/nav';

const PAGE = 100;
/** 'radio': the radio stations (a tuner's audio-only services); everything else lists TV channels. */
type Cat = 'all' | 'fav' | 'radio' | string;

export default function LiveScreen() {
  const t = useTheme();
  const api = useApi();
  const caps = useCapabilities();
  const bottom = useTabBarSpace();
  const cats = useQuery('livetv:categories', (a) => a.categories(), { staleMs: 300000 });
  const [cat, setCat] = useState<Cat>('all');
  const radio = useQuery('livetv:radio-count', (a) => a.channels({ kind: 'radio', limit: 1, withEpg: false }).then((r) => r.total), { staleMs: 300000 });
  const hasRadio = (radio.data ?? 0) > 0;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const loadingMore = useRef(false);
  const [, setTick] = useState(0);

  const query = useCallback(
    (offset: number) =>
      api.channels({
        categoryId: cat !== 'all' && cat !== 'fav' && cat !== 'radio' ? cat : undefined, favorite: cat === 'fav' ? true : undefined, limit: PAGE, offset, withEpg: true,
        kind: cat === 'radio' ? 'radio' : 'tv',
      }),
    [api, cat],
  );

  const reload = useCallback(async () => {
    setError(null);
    try {
      const r = await query(0);
      setChannels(r.items);
      setTotal(r.total);
    } catch (e) {
      setError(e as Error);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [query]);

  useEffect(() => {
    setLoading(true);
    void reload();
  }, [reload]);

  // Re-render progress bars every 30 s; refresh now/next every 5 min.
  useEffect(() => {
    const a = setInterval(() => setTick((n) => n + 1), 30000);
    const b = setInterval(() => void reload(), 300000);
    return () => {
      clearInterval(a);
      clearInterval(b);
    };
  }, [reload]);

  const loadMore = async () => {
    if (loadingMore.current || channels.length >= total) return;
    loadingMore.current = true;
    try {
      const r = await query(channels.length);
      setChannels((prev) => [...prev, ...r.items.filter((c) => !prev.some((p) => p.id === c.id))]);
    } finally {
      loadingMore.current = false;
    }
  };

  const toggleFav = useCallback(
    async (c: Channel) => {
      setChannels((list) => (cat === 'fav' && c.favorite ? list.filter((x) => x.id !== c.id) : list.map((x) => (x.id === c.id ? { ...x, favorite: !x.favorite } : x))));
      try {
        await api.setChannelFavorite(c.id, !c.favorite);
      } catch {
        void reload();
      }
    },
    [api, cat, reload],
  );

  // A tuner's own "Radio" group is the Radio chip.
  const categories = (cats.data ?? []).filter((c) => !c.hidden && !(hasRadio && /^radio$/i.test(c.name))).sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
  const categoryId = cat !== 'all' && cat !== 'fav' && cat !== 'radio' ? cat : undefined;

  return (
    <Screen padTop={!t.isTV}>
      <ScreenHeader
        title="Live TV"
        back={false}
        right={
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Button icon="grid-outline" label={t.isTV || t.wide ? 'Guide' : undefined} variant="secondary" size="sm" onPress={() => router.push(`/live/guide${categoryId ? `?category=${categoryId}` : ''}` as never)} accessibilityLabel="TV guide" />
            {caps.dvr ? <Button icon="recording-outline" label={t.isTV || t.wide ? 'Recordings' : undefined} variant="secondary" size="sm" onPress={() => router.push('/live/recordings' as never)} accessibilityLabel="Recordings" /> : null}
          </View>
        }
      />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm }}>
        <Chip label="All channels" selected={cat === 'all'} onPress={() => setCat('all')} hasTVPreferredFocus />
        <Chip label="Favourites" icon="star" selected={cat === 'fav'} onPress={() => setCat('fav')} />
        {hasRadio ? <Chip label="Radio" icon="radio-outline" selected={cat === 'radio'} onPress={() => setCat('radio')} /> : null}
        {categories.map((c) => (
          <Chip key={c.id} label={c.name} selected={cat === c.id} onPress={() => setCat(c.id)} />
        ))}
      </ScrollView>

      {loading && !channels.length ? (
        <Loading />
      ) : error && !channels.length ? (
        <ErrorState error={error} onRetry={reload} />
      ) : !channels.length ? (
        <EmptyState icon="tv-outline" title={cat === 'fav' ? 'No favourites yet' : cat === 'radio' ? 'No radio stations' : 'No channels'} message={cat === 'fav' ? 'Tap the star on a channel to pin it here.' : 'Your administrator has not added any live TV sources yet.'} />
      ) : (
        <FlatList
          data={channels}
          keyExtractor={(c) => c.id}
          renderItem={({ item }) => <ChannelListRow channel={item} onToggleFav={toggleFav} categoryId={categoryId} />}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: bottom, gap: t.isTV ? t.space.sm : 2 }}
          onEndReached={loadMore}
          onEndReachedThreshold={1}
          initialNumToRender={14}
          windowSize={9}
          removeClippedSubviews={!t.isTV}
          refreshControl={t.isTV ? undefined : <RefreshControl refreshing={refreshing} onRefresh={() => { setRefreshing(true); void reload(); }} tintColor={t.colors.primary} />}
          ListFooterComponent={channels.length < total ? <ActivityIndicator color={t.colors.primary} style={{ margin: t.space.lg }} /> : undefined}
        />
      )}
    </Screen>
  );
}

const ChannelListRow = memo(function ChannelListRow({ channel, onToggleFav, categoryId }: { channel: Channel; onToggleFav: (c: Channel) => void; categoryId?: string }) {
  const t = useTheme();
  const now = channel.nowPlaying;
  const logo = t.isTV ? t.s(80) : 56;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
      <Focusable
        onPress={() => playChannel(channel, { categoryId })}
        containerStyle={{ flex: 1 }}
        focusScale={t.isTV ? 1.02 : 1}
        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: t.isTV ? t.alpha(t.colors.surface, 0.7) : 'transparent' }}
      >
        <T variant="small" tone="muted" style={{ width: t.s(34), textAlign: 'right' }}>
          {channel.number ?? ''}
        </T>
        <View style={{ width: logo, height: logo * 0.66, borderRadius: t.radius / 2, backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center', padding: 4 }}>
          {channel.logoUrl ? <Img path={channel.logoUrl} width={logo} contentFit="contain" style={{ width: '100%', height: '100%' }} /> : <Icon name="tv-outline" color={t.colors.textMuted} />}
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <T weight="700" numberOfLines={1} style={{ flexShrink: 1 }}>
              {channel.name}
            </T>
            {channel.hasArchive ? <Icon name="time-outline" size={t.isTV ? t.s(16) : 13} color={t.colors.accent} /> : null}
          </View>
          {now ? (
            <>
              <T variant="small" tone="muted" numberOfLines={1}>
                {formatTime(now.start)} {now.title}
              </T>
              <ProgressBar value={programProgress(now)} style={{ maxWidth: t.s(320) }} track={t.alpha(t.colors.text, 0.12)} />
            </>
          ) : (
            <T variant="small" tone="muted">
              {channel.categoryName ?? 'No guide data'}
            </T>
          )}
          {channel.next && (t.isTV || t.wide) ? (
            <T variant="caption" tone="muted" weight="500" numberOfLines={1}>
              Next · {formatTime(channel.next.start)} {channel.next.title}
            </T>
          ) : null}
        </View>
      </Focusable>
      <Focusable onPress={() => onToggleFav(channel)} ringRadius={999} style={{ padding: t.space.sm, borderRadius: 999 }} accessibilityLabel={channel.favorite ? 'Remove favourite' : 'Add favourite'}>
        <Icon name={channel.favorite ? 'star' : 'star-outline'} color={channel.favorite ? t.colors.warning : t.colors.textMuted} />
      </Focusable>
    </View>
  );
});
