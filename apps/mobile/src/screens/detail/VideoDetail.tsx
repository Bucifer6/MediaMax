import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { Item, UserItemData } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { ItemRow } from '@/components/Row';
import { RecapCard } from '@/components/RecapCard';
import { useTheme } from '@/theme';
import { progressFraction } from '@/utils/format';
import { playItem } from '@/utils/nav';
import { prepareVideo } from '@/player/warmup';
import { useApi, useSession } from '@/state/session';
import { ActionBar, CastRow, DetailBackdrop, Overview, ResumeInfo, TVDetailBackground, TitleBlock, useUserDataActions } from './common';

export function VideoDetail({ item, onUserData }: { item: Item; onUserData: (ud: UserItemData) => void }) {
  const t = useTheme();
  const similar = useQuery(item.type !== 'episode' ? `similar:${item.id}` : null, (api) => api.similar(item.id, 16), { staleMs: 300000 });
  const siblings = useQuery(item.type === 'episode' && item.parentId ? `children:${item.parentId}` : null, (api) => api.children(item.parentId!, { sort: 'index', order: 'asc', limit: 200 }));
  const extras = useQuery(item.type === 'movie' ? `extras:${item.id}` : null, (api) => api.extras(item.id), { staleMs: 300000 });
  // Editions / versions: "Director's Cut", "Extended", or 4K vs 1080p copies of the same movie.
  const versions = item.media ?? [];
  const [mediaId, setMediaId] = useState<string | undefined>(undefined);
  const versionLabel = (m: (typeof versions)[number]) => [m.edition, m.resolutionLabel, m.hdr ? 'HDR' : null].filter(Boolean).join(' · ') || m.container?.toUpperCase() || 'Version';
  const { togglePlayed, toggleFavorite, setRating } = useUserDataActions(item, onUserData);
  // Instant play: the server decides and starts the stream while the user reads the page.
  const api = useApi();
  const { user } = useSession();
  useEffect(() => {
    void prepareVideo(api, item, user?.preferences, mediaId);
  }, [api, item.id, mediaId]); // eslint-disable-line react-hooks/exhaustive-deps
  const p = progressFraction(item);
  const resumable = p > 0.01 && p < 0.95;
  const play = () => playItem(item.id, { startMs: resumable ? item.userData.positionMs : 0, mediaId });
  const restart = resumable ? () => playItem(item.id, { restart: true, mediaId }) : undefined;

  const showLink =
    item.type === 'episode' && item.grandparentId ? (
      <Button icon="tv-outline" label={t.isTV ? 'Go to show' : undefined} variant="secondary" size="lg" onPress={() => router.push(`/item/${item.grandparentId}` as never)} accessibilityLabel="Go to show" />
    ) : null;

  const actions = (
    <ActionBar item={item} onPlay={play} onRestart={restart} playLabel={resumable ? 'Resume' : 'Play'} togglePlayed={togglePlayed} toggleFavorite={toggleFavorite} downloadable extra={showLink} onRate={setRating} playlistItems playOn={{ itemId: item.id, positionMs: resumable ? item.userData.positionMs : undefined, title: item.title }} />
  );

  const versionPicker = versions.length > 1 ? (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }} accessibilityRole="radiogroup" accessibilityLabel="Version">
      {versions.map((m, i) => {
        const on = (mediaId ?? versions[0].id) === m.id;
        return <Button key={m.id} label={versionLabel(m) + (versions.filter((x) => versionLabel(x) === versionLabel(m)).length > 1 ? ` (${i + 1})` : '')} size="sm" variant={on ? 'primary' : 'secondary'} onPress={() => setMediaId(m.id)} accessibilityLabel={`${versionLabel(m)}${on ? ', selected' : ''}`} />;
      })}
    </View>
  ) : null;

  const below = (
    <>
      {extras.data?.length ? <ItemRow title="Extras" items={extras.data} variant="landscape" /> : null}
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
            {versionPicker}
            {actions}
            {item.type === 'episode' ? <RecapCard itemId={item.id} /> : null}
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
        {versionPicker}
        {actions}
        {item.type === 'episode' ? <RecapCard itemId={item.id} /> : null}
        <Overview text={item.overview} />
      </View>
      {below}
    </ScrollView>
  );
}
