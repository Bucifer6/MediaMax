import { router } from 'expo-router';
import React from 'react';
import { ScrollView, View } from 'react-native';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { ItemRow } from '@/components/Row';
import { useTheme } from '@/theme';
import { progressFraction } from '@/utils/format';
import { playItem } from '@/utils/nav';
import { ActionBar, CastRow, DetailBackdrop, Overview, ResumeInfo, TVDetailBackground, TitleBlock, useUserDataActions } from './common';

export function VideoDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const similar = useQuery(item.type !== 'episode' ? `similar:${item.id}` : null, (api) => api.similar(item.id, 16), { staleMs: 300000 });
  const siblings = useQuery(item.type === 'episode' && item.parentId ? `children:${item.parentId}` : null, (api) => api.children(item.parentId!, { sort: 'index', order: 'asc', limit: 200 }));
  const { togglePlayed, toggleFavorite, setRating } = useUserDataActions(item, onUserData);
  const p = progressFraction(item);
  const resumable = p > 0.01 && p < 0.95;
  const play = () => playItem(item.id, { startMs: resumable ? item.userData.positionMs : 0 });
  const restart = resumable ? () => playItem(item.id, { restart: true }) : undefined;

  const showLink =
    item.type === 'episode' && item.grandparentId ? (
      <Button icon="tv-outline" label={t.isTV ? 'Go to show' : undefined} variant="secondary" size="lg" onPress={() => router.push(`/item/${item.grandparentId}` as never)} accessibilityLabel="Go to show" />
    ) : null;

  const actions = (
    <ActionBar item={item} onPlay={play} onRestart={restart} playLabel={resumable ? 'Resume' : 'Play'} togglePlayed={togglePlayed} toggleFavorite={toggleFavorite} downloadable extra={showLink} onRate={setRating} playlistItems />
  );

  const below = (
    <>
      {siblings.data?.items.length ? <ItemRow title={item.parentTitle ?? 'Episodes'} items={siblings.data.items} variant="landscape" /> : null}
      <CastRow people={item.people} />
      {similar.data?.length ? <ItemRow title="More like this" items={similar.data} /> : null}
    </>
  );

  if (t.isTV) {
    return (
      <View style={{ flex: 1 }}>
        <TVDetailBackground item={item} />
        <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl }}>
          <View style={{ minHeight: t.height * 0.72, justifyContent: 'flex-end', paddingHorizontal: t.space.gutter, paddingBottom: t.space.xl, gap: t.space.md, maxWidth: t.width * 0.62 }}>
            <TitleBlock item={item} />
            <Overview text={item.overview} />
            <ResumeInfo item={item} />
            {actions}
          </View>
          {below}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl * 2 }} showsVerticalScrollIndicator={false}>
      <DetailBackdrop item={item} height={Math.round(Math.min(t.width * 0.75, t.height * 0.5))} />
      <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.md, marginTop: -t.space.xxl, marginBottom: t.space.xl }}>
        <TitleBlock item={item} />
        <ResumeInfo item={item} />
        {actions}
        <Overview text={item.overview} />
      </View>
      {below}
    </ScrollView>
  );
}
