import React, { useEffect, useMemo, useState } from 'react';
import { FlatList, ScrollView, View } from 'react-native';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Img } from '@/components/Img';
import { MediaCard } from '@/components/MediaCard';
import { ProgressBar } from '@/components/ProgressBar';
import { ItemRow } from '@/components/Row';
import { T } from '@/components/Text';
import { Icon } from '@/components/Icon';
import { useDownloads } from '@/state/downloads';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDuration, progressFraction } from '@/utils/format';
import { openItem, playItem } from '@/utils/nav';
import { ActionBar, CastRow, DetailBackdrop, Overview, TVDetailBackground, TitleBlock, useUserDataActions } from './common';

export function ShowDetail({ show, initialSeasonId, onUserData }: { show: Item; initialSeasonId?: string; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const api = useApi();
  const seasons = useQuery(`children:${show.id}`, (a) => a.children(show.id, { sort: 'index', order: 'asc', limit: 200 }));
  const nextUp = useQuery(`next:${show.id}`, (a) => a.next(show.id));
  const similar = useQuery(`similar:${show.id}`, (a) => a.similar(show.id, 16), { staleMs: 300000 });
  const [seasonId, setSeasonId] = useState<string | undefined>(initialSeasonId);
  const seasonList = seasons.data?.items ?? [];

  useEffect(() => {
    if (seasonId || !seasonList.length) return;
    // Default to the season holding "next up", else the first non-specials season.
    const target = nextUp.data?.parentId && seasonList.find((s) => s.id === nextUp.data?.parentId);
    setSeasonId((target || seasonList.find((s) => (s.index ?? 0) > 0) || seasonList[0]).id);
  }, [seasonList, seasonId, nextUp.data]);

  const episodes = useQuery(seasonId ? `children:${seasonId}` : null, (a) => a.children(seasonId!, { sort: 'index', order: 'asc', limit: 500 }));
  const eps = episodes.data?.items ?? [];
  const { togglePlayed, toggleFavorite } = useUserDataActions(show, onUserData);

  const next = useMemo(() => nextUp.data ?? eps.find((e) => !e.userData.played) ?? eps[0] ?? null, [nextUp.data, eps]);
  const nextP = next ? progressFraction(next) : 0;
  const playLabel = next ? `${nextP > 0.01 ? 'Resume' : 'Play'} S${next.parentIndex ?? '?'}E${next.index ?? '?'}` : 'Play';
  const play = next ? () => playItem(next.id, { startMs: nextP > 0.01 && nextP < 0.95 ? next.userData.positionMs : 0 }) : undefined;

  const seasonChips = seasonList.length > 1 ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={{ gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm }}>
      {seasonList.map((s) => (
        <Chip key={s.id} label={s.title || `Season ${s.index}`} selected={s.id === seasonId} onPress={() => setSeasonId(s.id)} onFocus={t.isTV ? () => setSeasonId(s.id) : undefined} />
      ))}
    </ScrollView>
  ) : null;

  const actions = (
    <ActionBar
      item={show}
      onPlay={play}
      playLabel={playLabel}
      togglePlayed={togglePlayed}
      toggleFavorite={toggleFavorite}
      downloadable={!!seasonId}
      downloadItems={async () => (await api.children(seasonId!, { sort: 'index', order: 'asc', limit: 500 })).items}
    />
  );

  if (t.isTV) {
    return (
      <View style={{ flex: 1 }}>
        <TVDetailBackground item={show} />
        <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl }}>
          <View style={{ minHeight: t.height * 0.6, justifyContent: 'flex-end', paddingHorizontal: t.space.gutter, paddingBottom: t.space.lg, gap: t.space.md, maxWidth: t.width * 0.62 }}>
            <TitleBlock item={show} />
            <Overview text={show.overview} />
            {actions}
          </View>
          {seasonChips}
          <FlatList
            horizontal
            data={eps}
            keyExtractor={(e) => e.id}
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ paddingHorizontal: t.space.gutter, gap: t.card.gap, paddingVertical: t.s(16) }}
            renderItem={({ item }) => <MediaCard item={item} variant="landscape" onPress={(e) => openItem(e)} />}
          />
          <CastRow people={show.people} />
          {similar.data?.length ? <ItemRow title="More like this" items={similar.data} /> : null}
        </ScrollView>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={{ paddingBottom: t.space.xxl * 2 }} showsVerticalScrollIndicator={false}>
      <DetailBackdrop item={show} height={Math.round(Math.min(t.width * 0.75, t.height * 0.5))} />
      <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.md, marginTop: -t.space.xxl, marginBottom: t.space.md }}>
        <TitleBlock item={show} />
        {actions}
        <Overview text={show.overview} />
      </View>
      {seasonChips}
      <View style={{ paddingHorizontal: t.space.gutter, gap: t.space.md, marginBottom: t.space.xl }}>
        {eps.map((e) => (
          <EpisodeRow key={e.id} ep={e} />
        ))}
      </View>
      <CastRow people={show.people} />
      {similar.data?.length ? <ItemRow title="More like this" items={similar.data} /> : null}
    </ScrollView>
  );
}

function EpisodeRow({ ep }: { ep: Item }) {
  const t = useTheme();
  const downloads = useDownloads();
  const rec = downloads.get(ep.id);
  const p = progressFraction(ep);
  const w = t.wide ? 200 : 140;
  const h = Math.round((w * 9) / 16);
  return (
    <Focusable onPress={() => openItem(ep)} style={{ flexDirection: 'row', gap: t.space.md }}>
      <View style={{ width: w, height: h, borderRadius: t.shapeRadius(w, h), overflow: 'hidden', backgroundColor: t.colors.surfaceAlt }}>
        <Img path={ep.thumbUrl ?? ep.backdropUrl} width={w} style={{ width: '100%', height: '100%' }} />
        <Focusable onPress={() => playItem(ep.id, { startMs: p > 0.01 && p < 0.95 ? ep.userData.positionMs : 0 })} containerStyle={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={`Play ${ep.title}`}>
          <View style={{ backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, padding: 8 }}>
            <Icon name="play" size={18} color="#fff" />
          </View>
        </Focusable>
        {p > 0 ? <ProgressBar value={p} style={{ position: 'absolute', left: 6, right: 6, bottom: 6 }} /> : null}
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <T variant="small" weight="700" numberOfLines={2}>
          {ep.index != null ? `${ep.index}. ` : ''}
          {ep.title}
        </T>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <T variant="caption" tone="muted">
            {formatDuration(ep.durationMs)}
          </T>
          {ep.userData.played ? <Icon name="checkmark-circle" size={14} color={t.colors.primary} /> : null}
          {rec?.state === 'done' ? <Icon name="arrow-down-circle" size={14} color={t.colors.success} /> : null}
        </View>
        <T variant="caption" tone="muted" weight="400" numberOfLines={3} style={{ letterSpacing: 0 }}>
          {ep.overview ?? ''}
        </T>
      </View>
    </Focusable>
  );
}
