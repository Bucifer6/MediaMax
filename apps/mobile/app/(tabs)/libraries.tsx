import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';
import type { Item, Library } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { ItemRow, RowHeader } from '@/components/Row';
import { SmartPlaylistSheet } from '@/components/SmartPlaylistSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { mix, useTheme } from '@/theme';
import { LIBRARY_ICON } from '@/utils/library';
import { openDj, openItem } from '@/utils/nav';

export default function LibrariesScreen() {
  const t = useTheme();
  const { features } = useSession();
  const bottom = useTabBarSpace();
  const libs = useQuery('libraries', (api) => api.libraries());
  const collections = useQuery('collections', (api) => api.collections());
  const playlists = useQuery('playlists', (api) => api.playlists());
  const [smartSheet, setSmartSheet] = useState(false);

  const visible = useMemo(
    () =>
      (libs.data ?? [])
        .filter((l) => {
          if (l.type === 'music' && !features.music) return false;
          if (l.type === 'photos' && !features.photos) return false;
          if ((l.type === 'iptv-movies' || l.type === 'iptv-shows') && !features.iptvVod) return false;
          return true;
        })
        .sort((a, b) => a.sortOrder - b.sortOrder),
    [libs.data, features],
  );

  if (libs.loading && !libs.data) return <Loading />;
  if (libs.error && !libs.data) return <ErrorState error={libs.error} onRetry={libs.refresh} />;

  const cols = t.isTV ? 4 : t.wide ? 3 : 2;
  const gap = t.card.gap;
  const tileW = (t.width - t.space.gutter * 2 - gap * (cols - 1)) / cols;

  return (
    <Screen padTop={!t.isTV}>
      <ScrollView
        contentContainerStyle={{ paddingBottom: bottom }}
        refreshControl={t.isTV ? undefined : <RefreshControl refreshing={libs.refreshing} onRefresh={() => { void libs.refresh(); void collections.refresh(); void playlists.refresh(); }} tintColor={t.colors.primary} />}
      >
        <ScreenHeader
          title="Library"
          back={false}
          right={
            <View style={{ flexDirection: 'row', gap: t.space.sm }}>
              {features.music ? <Button label="DJ" icon="disc-outline" size="sm" variant="secondary" onPress={() => openDj()} accessibilityLabel="DJ mode" /> : null}
              <Button label="Podcasts" icon="mic-outline" size="sm" variant="secondary" onPress={() => router.push('/podcasts' as never)} />
            </View>
          }
        />
        {!visible.length ? <EmptyState title="No libraries" message="Your administrator hasn't shared any libraries with you yet." /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap, paddingHorizontal: t.space.gutter, marginBottom: t.space.xl }}>
          {visible.map((lib, i) => (
            <LibraryTile key={lib.id} lib={lib} width={tileW} index={i} />
          ))}
        </View>
        {collections.data?.length ? <ItemRow title="Collections" items={collections.data} variant="poster" /> : null}
        {playlists.data?.length ? (
          <ItemRow title="Playlists" items={playlists.data as Item[]} variant="square" />
        ) : (
          <RowHeader title="Playlists" />
        )}
        <View style={{ paddingHorizontal: t.space.gutter, marginTop: playlists.data?.length ? -t.space.sm : 0, marginBottom: t.space.lg }}>
          <Button label="New smart playlist" icon="sparkles-outline" size="sm" variant="secondary" onPress={() => setSmartSheet(true)} />
        </View>
      </ScrollView>
      <SmartPlaylistSheet visible={smartSheet} onClose={() => setSmartSheet(false)} onSaved={(pl) => { void playlists.refresh(); openItem(pl); }} />
    </Screen>
  );
}

function LibraryTile({ lib, width, index }: { lib: Library; width: number; index: number }) {
  const t = useTheme();
  const height = Math.round(width * 0.56);
  const tint = index % 2 ? t.colors.accent : t.colors.primary;
  return (
    <Focusable
      onPress={() => router.push(`/library/${lib.id}` as never)}
      hasTVPreferredFocus={index === 0}
      ringRadius={t.radius}
      style={{ width, height, borderRadius: t.shapeRadius(width, height) > height / 2 ? height / 2 : t.radius, overflow: 'hidden' }}
    >
      <LinearGradient colors={[mix(tint, t.colors.surface, 0.25), mix(tint, t.colors.background, 0.75)]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ flex: 1, padding: t.space.md, justifyContent: 'space-between' }}>
        <Icon name={LIBRARY_ICON[lib.type] ?? 'albums'} size={t.isTV ? t.s(34) : 28} color="#fff" />
        <View>
          <T variant="heading" color="#fff" numberOfLines={1}>
            {lib.name}
          </T>
          <T variant="caption" color="rgba(255,255,255,0.8)">
            {lib.itemCount.toLocaleString()} items{lib.scanning ? ' · scanning…' : ''}
          </T>
        </View>
      </LinearGradient>
    </Focusable>
  );
}
