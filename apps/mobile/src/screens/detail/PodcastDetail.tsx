/** Podcast show: header + episodes newest first (date, duration, played state). */
import { router } from 'expo-router';
import React, { useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { T } from '@/components/Text';
import { useMusic } from '@/state/music';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDate, formatDuration, progressFraction } from '@/utils/format';
import { RatingStars, useUserDataActions } from './common';
import { Header } from './MusicDetail';

export function PodcastDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const api = useApi();
  const music = useMusic();
  const episodes = useQuery(`children:${item.id}:newest`, (a) => a.children(item.id, { sort: 'releaseDate', order: 'desc', limit: 500 }));
  const { toggleFavorite, togglePlayed, setRating } = useUserDataActions(item, onUserData);
  const [resuming, setResuming] = useState(false);
  const list = episodes.data?.items ?? [];
  const inProgress = list.some((e) => !e.userData.played && progressFraction(e) > 0.01);

  const playEpisode = (ep: Item) => music.playQueue([ep], 0);
  /** GET /items/:id/next = the in-progress or newest unplayed episode. */
  const play = async () => {
    setResuming(true);
    try {
      const next = await api.next(item.id).catch(() => null);
      const ep = next ?? list.find((e) => !e.userData.played) ?? list[0];
      if (ep) playEpisode(ep);
    } finally {
      setResuming(false);
    }
  };

  const setEpisodePlayed = async (ep: Item) => {
    const played = !ep.userData.played;
    const patch = (ud: UserItemData) => episodes.setData((prev) => (prev ? { ...prev, items: prev.items.map((x) => (x.id === ep.id ? { ...x, userData: ud } : x)) } : prev));
    patch({ ...ep.userData, played, positionMs: played ? 0 : ep.userData.positionMs });
    try {
      patch(await api.setPlayed(ep.id, played));
    } catch {
      patch(ep.userData);
    }
  };

  return (
    <FlatList
      data={list}
      keyExtractor={(x) => x.id}
      contentContainerStyle={{ paddingBottom: t.space.xxl * 3 }}
      ListHeaderComponent={
        <Header item={item} subtitle={[item.parentTitle, `${episodes.data?.total ?? item.childCount} episodes`].filter(Boolean).join(' · ')}>
          <View style={{ flexDirection: 'row', gap: t.space.sm, marginTop: t.space.sm, flexWrap: 'wrap', justifyContent: t.isTV ? 'flex-start' : 'center' }}>
            <Button label={inProgress ? 'Resume' : 'Play latest'} icon="play" onPress={() => void play()} loading={resuming} disabled={!list.length} hasTVPreferredFocus />
            <Button icon={item.userData.favorite ? 'heart' : 'heart-outline'} variant="secondary" onPress={toggleFavorite} accessibilityLabel="Favourite" />
            <Button icon={item.userData.played ? 'checkmark-done-circle' : 'checkmark-circle-outline'} variant="secondary" onPress={() => void togglePlayed().then(() => episodes.refresh())} accessibilityLabel={item.userData.played ? 'Mark all unplayed' : 'Mark all played'} />
            <Button icon="settings-outline" label={t.isTV ? 'Subscriptions' : undefined} variant="secondary" onPress={() => router.push('/podcasts' as never)} accessibilityLabel="Manage podcast subscriptions" />
          </View>
          <RatingStars rating={item.userData.rating} onRate={setRating} />
          {item.overview ? (
            <T tone="muted" numberOfLines={t.isTV ? 3 : 4} center={!t.isTV} style={{ maxWidth: t.isTV ? t.width * 0.55 : undefined }}>
              {item.overview}
            </T>
          ) : null}
        </Header>
      }
      ListEmptyComponent={episodes.loading ? <ActivityIndicator color={t.colors.primary} /> : <T tone="muted" center>No episodes yet.</T>}
      renderItem={({ item: ep }) => {
        const p = progressFraction(ep);
        const playing = music.current?.id === ep.id;
        return (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, paddingHorizontal: t.space.gutter - t.space.sm }}>
            <Focusable
              onPress={() => playEpisode(ep)}
              containerStyle={{ flex: 1 }}
              focusScale={t.isTV ? 1.02 : 1}
              style={{ flexDirection: 'row', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: playing ? t.alpha(t.colors.primary, 0.12) : 'transparent' }}
            >
              <View style={{ width: t.s(10), paddingTop: t.isTV ? t.s(10) : 8 }}>
                {!ep.userData.played && p <= 0.01 ? <View style={{ width: t.s(8), height: t.s(8), borderRadius: t.s(4), backgroundColor: t.colors.primary }} accessibilityLabel="Unplayed" /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T variant="caption" tone="muted" style={{ letterSpacing: 0 }}>
                  {[formatDate(ep.releaseDate ?? ep.addedAt), formatDuration(ep.durationMs)].filter(Boolean).join(' · ')}
                </T>
                <T weight={ep.userData.played ? '500' : '700'} tone={playing ? 'primary' : ep.userData.played ? 'muted' : 'default'} numberOfLines={2}>
                  {ep.title}
                </T>
                {ep.overview ? (
                  <T variant="small" tone="muted" numberOfLines={2}>
                    {ep.overview.replace(/<[^>]+>/g, '')}
                  </T>
                ) : null}
                {!ep.userData.played && p > 0.01 ? (
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, marginTop: 4 }}>
                    <View style={{ width: t.s(80), height: 3, borderRadius: 2, backgroundColor: t.alpha(t.colors.text, 0.2), overflow: 'hidden' }}>
                      <View style={{ width: `${p * 100}%`, height: '100%', backgroundColor: t.colors.primary }} />
                    </View>
                    <T variant="caption" tone="muted" style={{ letterSpacing: 0 }}>
                      {formatDuration((ep.durationMs ?? 0) - ep.userData.positionMs)} left
                    </T>
                  </View>
                ) : null}
              </View>
            </Focusable>
            <Focusable onPress={() => void setEpisodePlayed(ep)} ringRadius={999} accessibilityLabel={ep.userData.played ? `Mark ${ep.title} unplayed` : `Mark ${ep.title} played`} style={{ padding: t.isTV ? t.s(10) : 8, borderRadius: 999 }}>
              {({ focused }) => <Icon name={ep.userData.played ? 'checkmark-circle' : 'checkmark-circle-outline'} size={t.isTV ? t.s(24) : 22} color={ep.userData.played ? t.colors.primary : focused ? t.colors.primary : t.colors.textMuted} />}
            </Focusable>
          </View>
        );
      }}
    />
  );
}
