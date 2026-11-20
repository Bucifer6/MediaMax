import { LinearGradient } from 'expo-linear-gradient';
import React from 'react';
import { ActivityIndicator, FlatList, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { MediaCard } from '@/components/MediaCard';
import { ItemRow } from '@/components/Row';
import { BackButton } from '@/components/Screen';
import { T } from '@/components/Text';
import { useDownloads } from '@/state/downloads';
import { useMusic } from '@/state/music';
import { useApi, useCapabilities } from '@/state/session';
import { useTheme } from '@/theme';
import { formatClock, formatDuration } from '@/utils/format';
import { openItem, playItem } from '@/utils/nav';
import { useUserDataActions } from './common';

function Header({ item, subtitle, children }: { item: Item; subtitle: string; children?: React.ReactNode }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const art = t.isTV ? t.s(260) : Math.min(t.width * 0.6, 260);
  const round = item.type === 'artist';
  return (
    <View style={{ paddingTop: t.isTV ? t.space.xl : insets.top + 8, paddingHorizontal: t.space.gutter, paddingBottom: t.space.lg, alignItems: t.isTV ? 'flex-start' : 'center', flexDirection: t.isTV ? 'row' : 'column', gap: t.space.xl }}>
      <Img path={item.posterUrl ?? item.thumbUrl} width={t.width} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, opacity: 0.35 }} blurRadius={40} />
      <LinearGradient colors={['transparent', t.colors.background]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      {!t.isTV ? (
        <View style={{ position: 'absolute', top: insets.top + 6, left: 8 }}>
          <BackButton />
        </View>
      ) : null}
      <View style={{ width: art, height: art, borderRadius: round ? art / 2 : t.shapeRadius(art, art), overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, shadowColor: '#000', shadowOpacity: 0.5, shadowRadius: 24, elevation: 12, marginTop: t.isTV ? 0 : 40, alignItems: 'center', justifyContent: 'center' }}>
        {item.posterUrl || item.thumbUrl ? <Img path={item.posterUrl ?? item.thumbUrl} width={art} style={{ width: '100%', height: '100%' }} /> : <Icon name="musical-notes" size={art / 3} color={t.colors.textMuted} />}
      </View>
      <View style={{ gap: t.space.sm, alignItems: t.isTV ? 'flex-start' : 'center', flex: t.isTV ? 1 : undefined, justifyContent: 'flex-end', alignSelf: t.isTV ? 'stretch' : undefined }}>
        <T variant="caption" tone="primary" style={{ textTransform: 'uppercase' }}>
          {item.type}
        </T>
        <T variant={t.isTV ? 'hero' : 'title'} center={!t.isTV}>
          {item.title}
        </T>
        <T tone="muted" center={!t.isTV}>
          {subtitle}
        </T>
        {children}
      </View>
    </View>
  );
}

function TrackRow({ track, index, onPress, showArt, playingId }: { track: Item; index: number; onPress: () => void; showArt?: boolean; playingId?: string }) {
  const t = useTheme();
  const downloads = useDownloads();
  const active = playingId === track.id;
  const isVideo = track.type !== 'track';
  return (
    <Focusable onPress={onPress} focusScale={t.isTV ? 1.02 : 1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: active ? t.alpha(t.colors.primary, 0.12) : 'transparent' }}>
      {showArt ? (
        <Img path={track.posterUrl ?? track.thumbUrl} width={44} style={{ width: t.s(44), height: t.s(44), borderRadius: 6 }} />
      ) : (
        <View style={{ width: t.s(28), alignItems: 'center' }}>{active ? <Icon name="volume-high" size={t.isTV ? t.s(18) : 16} color={t.colors.primary} /> : <T tone="muted" variant="small">{track.index ?? index + 1}</T>}</View>
      )}
      <View style={{ flex: 1 }}>
        <T weight={active ? '800' : '600'} tone={active ? 'primary' : 'default'} numberOfLines={1}>
          {track.title}
        </T>
        <T variant="caption" tone="muted" weight="500" numberOfLines={1} style={{ letterSpacing: 0 }}>
          {isVideo ? track.type : track.grandparentTitle ?? track.parentTitle ?? ''}
        </T>
      </View>
      {downloads.get(track.id)?.state === 'done' ? <Icon name="arrow-down-circle" size={16} color={t.colors.success} /> : null}
      <T variant="small" tone="muted">
        {track.durationMs ? formatClock(track.durationMs) : ''}
      </T>
    </Focusable>
  );
}

/** Album and playlist: header + track list. */
export function TrackListDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const music = useMusic();
  const caps = useCapabilities();
  const downloads = useDownloads();
  const children = useQuery(`children:${item.id}`, (api) => api.children(item.id, { sort: item.type === 'album' ? 'index' : undefined, order: 'asc', limit: 1000 }));
  const similar = useQuery(item.type === 'album' ? `similar:${item.id}` : null, (api) => api.similar(item.id, 12), { staleMs: 300000 });
  const { toggleFavorite } = useUserDataActions(item, onUserData);
  const tracks = children.data?.items ?? [];
  const audio = tracks.filter((x) => x.type === 'track');
  const total = tracks.reduce((n, x) => n + (x.durationMs ?? 0), 0);
  const subtitle = [item.type === 'album' ? item.parentTitle : null, item.year, `${tracks.length} ${audio.length === tracks.length ? 'songs' : 'items'}`, formatDuration(total)].filter(Boolean).join(' · ');

  const playAt = (i: number, shuffle = false) => {
    const tr = tracks[i];
    if (!tr) return;
    if (tr.type === 'track') music.playQueue(audio, Math.max(0, audio.indexOf(tr)), { shuffle });
    else playItem(tr.id);
  };

  return (
    <FlatList
      data={tracks}
      keyExtractor={(x) => x.id}
      contentContainerStyle={{ paddingBottom: t.space.xxl * 3 }}
      ListHeaderComponent={
        <Header item={item} subtitle={subtitle}>
          <View style={{ flexDirection: 'row', gap: t.space.sm, marginTop: t.space.sm, flexWrap: 'wrap', justifyContent: t.isTV ? 'flex-start' : 'center' }}>
            <Button label="Play" icon="play" onPress={() => playAt(0)} disabled={!tracks.length} hasTVPreferredFocus />
            {audio.length > 1 ? <Button label="Shuffle" icon="shuffle" variant="secondary" onPress={() => playAt(Math.floor(Math.random() * tracks.length), true)} /> : null}
            <Button icon={item.userData.favorite ? 'heart' : 'heart-outline'} variant="secondary" onPress={toggleFavorite} accessibilityLabel="Favourite" />
            {caps.downloads && downloads.supported && audio.length ? <Button icon="arrow-down-circle-outline" variant="secondary" onPress={() => downloads.download(audio)} accessibilityLabel="Download all" /> : null}
          </View>
        </Header>
      }
      ListEmptyComponent={children.loading ? <ActivityIndicator color={t.colors.primary} /> : undefined}
      renderItem={({ item: tr, index }) => (
        <View style={{ paddingHorizontal: t.space.gutter - t.space.sm }}>
          <TrackRow track={tr} index={index} onPress={() => playAt(index)} showArt={item.type === 'playlist'} playingId={music.current?.id} />
        </View>
      )}
      ListFooterComponent={similar.data?.length ? <View style={{ marginTop: t.space.xl }}><ItemRow title="Similar albums" items={similar.data} variant="square" /></View> : undefined}
    />
  );
}

export function ArtistDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const api = useApi();
  const music = useMusic();
  const albums = useQuery(`children:${item.id}`, (a) => a.children(item.id, { sort: 'year', order: 'desc', limit: 200 }));
  const similar = useQuery(`similar:${item.id}`, (a) => a.similar(item.id, 12), { staleMs: 300000 });
  const { toggleFavorite } = useUserDataActions(item, onUserData);
  const list = albums.data?.items ?? [];

  const playAll = async (shuffle: boolean) => {
    const sets = await Promise.all(list.slice(0, 15).map((al) => api.children(al.id, { sort: 'index', order: 'asc', limit: 200 }).then((r) => r.items).catch(() => [] as Item[])));
    const tracks = sets.flat();
    if (tracks.length) music.playQueue(tracks, shuffle ? Math.floor(Math.random() * tracks.length) : 0, { shuffle });
  };

  const cols = t.isTV ? 6 : t.wide ? 4 : 2;
  const w = Math.floor((t.width - t.space.gutter * 2 - t.card.gap * (cols - 1)) / cols);
  return (
    <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl * 3 }}>
      <Header item={item} subtitle={`${list.length} albums`}>
        <View style={{ flexDirection: 'row', gap: t.space.sm, marginTop: t.space.sm }}>
          <Button label="Play" icon="play" onPress={() => playAll(false)} disabled={!list.length} hasTVPreferredFocus />
          <Button label="Shuffle" icon="shuffle" variant="secondary" onPress={() => playAll(true)} disabled={!list.length} />
          <Button icon={item.userData.favorite ? 'heart' : 'heart-outline'} variant="secondary" onPress={toggleFavorite} accessibilityLabel="Favourite" />
        </View>
      </Header>
      {item.overview ? (
        <T tone="muted" numberOfLines={5} style={{ paddingHorizontal: t.space.gutter, marginBottom: t.space.lg }}>
          {item.overview}
        </T>
      ) : null}
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.card.gap, paddingHorizontal: t.space.gutter, marginBottom: t.space.xl, rowGap: t.space.lg }}>
        {list.map((al) => (
          <MediaCard key={al.id} item={al} variant="square" width={w} onPress={openItem} />
        ))}
      </View>
      {similar.data?.length ? <ItemRow title="Similar artists" items={similar.data} variant="square" /> : null}
    </ScrollView>
  );
}
