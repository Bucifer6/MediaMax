import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { HomeRow, Item } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Focusable } from '@/components/Focusable';
import { HeroCarousel, TVSpotlightBackground, TVSpotlightInfo } from '@/components/Hero';
import { Icon } from '@/components/Icon';
import { BrandWordmark } from '@/components/BrandWordmark';
import { DecideChips } from '@/components/DecideChips';
import { Img } from '@/components/Img';
import type { CardVariant } from '@/components/MediaCard';
import { ChannelRow, ItemRow } from '@/components/Row';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { on } from '@/utils/events';

const DEFAULT_TITLES: Record<string, string> = {
  continue: 'Continue Watching',
  nextup: 'Next Up',
  recent: 'Recently Added',
  'library-recent': 'Recently Added',
  favorites: 'Favourites',
  'live-now': 'On Now',
  'favorite-channels': 'Favourite Channels',
  recordings: 'Recordings',
};

function variantFor(row: HomeRow): CardVariant {
  if (row.type === 'continue' || row.type === 'nextup') return 'landscape';
  return 'auto';
}

function seeAllFor(row: HomeRow): (() => void) | undefined {
  const l = row.link;
  if (!l) return undefined;
  if (l.libraryId) {
    const q = new URLSearchParams();
    if (l.sort) q.set('sort', l.sort);
    if (l.genre) q.set('genre', l.genre);
    const qs = q.toString();
    return () => router.push(`/library/${l.libraryId}${qs ? `?${qs}` : ''}` as never);
  }
  if (l.itemId) return () => router.push(`/item/${l.itemId}` as never);
  return undefined;
}

export default function HomeScreen() {
  const t = useTheme();
  const caps = useCapabilities();
  const { data, error, loading, refresh, refreshing } = useQuery('home', (api) => api.home(), { staleMs: 15000 });

  // Live-refresh when playback state changes elsewhere (continue watching etc.).
  // Debounced: progress reports during playback can emit many events.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = on('userdata', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 4000);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const rows = useMemo(
    () =>
      (data?.rows ?? []).filter((r) => {
        if ((r.type === 'live-now' || r.type === 'favorite-channels') && !caps.liveTv) return false;
        if (r.type === 'recordings' && !caps.dvr) return false;
        return r.type === 'live-now' || r.type === 'favorite-channels' ? !!r.channels?.length : r.items.length > 0;
      }),
    [data, caps.liveTv, caps.dvr],
  );

  if (loading && !data) return <Loading />;
  if (error && !data) return <ErrorState error={error} onRetry={refresh} />;
  if (!rows.length) return <EmptyState icon="film-outline" title="Nothing here yet" message="Once your libraries are scanned, movies, shows and music will show up here." action="Refresh" onAction={refresh} />;

  return t.isTV ? <TVHome rows={rows} /> : <PhoneHome rows={rows} refreshing={refreshing} onRefresh={refresh} />;
}

function PhoneHome({ rows, refreshing, onRefresh }: { rows: HomeRow[]; refreshing: boolean; onRefresh: () => void }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { branding, user } = useSession();
  const bottom = useTabBarSpace();
  const heroStyle = t.theme.heroStyle;
  const hero = heroStyle !== 'none' ? rows.find((r) => r.type === 'hero') : undefined;
  const logo = branding?.logoWideUrl ?? branding?.logoUrl;

  return (
    <View style={{ flex: 1 }}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottom, paddingTop: hero ? 0 : insets.top + 60 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={t.colors.primary} progressViewOffset={insets.top + 40} />}
        showsVerticalScrollIndicator={false}
      >
        {hero ? <HeroCarousel items={hero.items} style={heroStyle === 'static' ? 'static' : 'carousel'} /> : null}
        <DecideChips />
        {rows
          .filter((r) => r !== hero && r.type !== 'hero')
          .map((row) =>
            row.type === 'live-now' || row.type === 'favorite-channels' ? (
              <ChannelRow key={row.id} title={row.title || DEFAULT_TITLES[row.type]} channels={row.channels ?? []} onSeeAll={() => router.push('/(tabs)/live')} />
            ) : (
              <ItemRow key={row.id} title={row.title || DEFAULT_TITLES[row.type] || ''} items={row.items} variant={variantFor(row)} onSeeAll={seeAllFor(row)} />
            ),
          )}
      </ScrollView>
      {/* Floating translucent header */}
      <LinearGradient colors={[t.alpha(t.colors.background, 0.85), 'transparent']} pointerEvents="box-none" style={{ position: 'absolute', top: 0, left: 0, right: 0, paddingTop: insets.top + 6, paddingBottom: 18, paddingHorizontal: t.space.gutter, flexDirection: 'row', alignItems: 'center' }}>
        <View style={{ flex: 1 }}>
          {logo ? <Img path={logo} width={160} contentFit="contain" style={{ width: 140, height: 34 }} /> : <BrandWordmark name={branding?.serverName} width={140} textVariant="heading" />}
        </View>
        <Focusable onPress={() => router.push('/(tabs)/search')} style={{ padding: 8 }} accessibilityLabel="Search">
          <Icon name="search" />
        </Focusable>
        <Focusable onPress={() => router.push('/(tabs)/settings')} style={{ padding: 4 }} accessibilityLabel="Account">
          {user?.avatarUrl ? (
            <Img path={user.avatarUrl} width={32} style={{ width: 32, height: 32, borderRadius: 16 }} />
          ) : (
            <View style={{ width: 32, height: 32, borderRadius: 16, backgroundColor: t.colors.primary, alignItems: 'center', justifyContent: 'center' }}>
              <T variant="small" weight="800" color={t.colors.primaryText}>
                {user?.displayName?.slice(0, 1).toUpperCase() ?? '?'}
              </T>
            </View>
          )}
        </Focusable>
      </LinearGradient>
    </View>
  );
}

function TVHome({ rows }: { rows: HomeRow[] }) {
  const t = useTheme();
  const hero = rows.find((r) => r.type === 'hero');
  const firstItem = hero?.items[0] ?? rows.find((r) => r.items.length)?.items[0] ?? null;
  const [focused, setFocused] = useState<Item | null>(firstItem);
  const [userMoved, setUserMoved] = useState(false);

  // Until the user moves focus, gently rotate the spotlight through the hero items.
  useEffect(() => {
    if (userMoved || !hero || hero.items.length < 2 || t.theme.heroStyle !== 'carousel') return;
    let i = 0;
    const timer = setInterval(() => {
      i = (i + 1) % hero.items.length;
      setFocused(hero.items[i]);
    }, 8000);
    return () => clearInterval(timer);
  }, [hero, userMoved, t.theme.heroStyle]);

  const onFocusItem = useCallback((item: Item) => {
    setUserMoved(true);
    setFocused(item);
  }, []);

  const spotlightHeight = Math.round(t.height * (t.theme.heroStyle === 'none' ? 0.3 : 0.42));
  return (
    <View style={{ flex: 1 }}>
      {t.theme.heroStyle !== 'none' ? <TVSpotlightBackground item={focused} /> : null}
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl }} showsVerticalScrollIndicator={false}>
        <TVSpotlightInfo item={t.theme.heroStyle === 'none' ? null : focused} height={spotlightHeight} />
        <DecideChips />
        {rows.map((row, idx) =>
          row.type === 'live-now' || row.type === 'favorite-channels' ? (
            <ChannelRow key={row.id} title={row.title || DEFAULT_TITLES[row.type]} channels={row.channels ?? []} />
          ) : (
            <ItemRow
              key={row.id}
              title={row.type === 'hero' ? row.title || 'Featured' : row.title || DEFAULT_TITLES[row.type] || ''}
              items={row.items}
              variant={row.type === 'hero' ? 'landscape' : variantFor(row)}
              onSeeAll={seeAllFor(row)}
              onFocusItem={onFocusItem}
              firstPreferred={idx === 0}
            />
          ),
        )}
      </ScrollView>
    </View>
  );
}
