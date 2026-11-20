import React from 'react';
import { ScrollView, View } from 'react-native';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { MediaCard } from '@/components/MediaCard';
import { Loading } from '@/components/States';
import { useTheme } from '@/theme';
import { openItem } from '@/utils/nav';
import { ActionBar, DetailBackdrop, Overview, TVDetailBackground, TitleBlock, useUserDataActions } from './common';
import { playOrOpen } from '@/components/Hero';

export function CollectionDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const children = useQuery(`children:${item.id}`, (api) => api.children(item.id, { sort: 'releaseDate', order: 'asc', limit: 500 }));
  const { togglePlayed, toggleFavorite } = useUserDataActions(item, onUserData);
  const list = children.data?.items ?? [];
  const firstUnplayed = list.find((i) => !i.userData.played) ?? list[0];
  const cols = t.isTV ? 6 : t.wide ? 5 : 3;
  const w = Math.floor((t.width - t.space.gutter * 2 - t.card.gap * (cols - 1)) / cols);

  const header = (
    <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.md, marginTop: t.isTV ? t.height * 0.25 : -t.space.xxl, marginBottom: t.space.xl, maxWidth: t.isTV ? t.width * 0.6 : undefined }}>
      <TitleBlock item={item} />
      <ActionBar item={item} onPlay={firstUnplayed ? () => playOrOpen(firstUnplayed) : undefined} playLabel="Play" togglePlayed={togglePlayed} toggleFavorite={toggleFavorite} />
      <Overview text={item.overview} />
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      {t.isTV ? <TVDetailBackground item={item} /> : null}
      <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl * 2 }}>
        {!t.isTV ? <DetailBackdrop item={item} height={Math.round(Math.min(t.width * 0.7, t.height * 0.45))} /> : null}
        {header}
        {children.loading && !list.length ? <Loading /> : null}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.card.gap, rowGap: t.space.lg, paddingHorizontal: t.space.gutter }}>
          {list.map((c) => (
            <MediaCard key={c.id} item={c} width={w} onPress={openItem} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
