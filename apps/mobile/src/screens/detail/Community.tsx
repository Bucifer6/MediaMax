/**
 * Detail-page additions on phones and TVs (same data as the web's components/Community.tsx):
 * multi-source rating chips (OMDb / MDBList), the season × episode ratings grid and Trakt comments
 * (spoilers hidden until tapped). Each renders nothing when there is nothing to show.
 */
import { useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { EpisodeRatings, Item, TraktComment } from '@/api/types';
import { Focusable } from '@/components/Focusable';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { openItem } from '@/utils/nav';

export function RatingChips({ item }: { item: Item }) {
  const t = useTheme();
  const r = item.ratings;
  if (!r) return null;
  const chips: [string, string][] = [];
  if (r.imdb != null) chips.push(['IMDb', r.imdb.toFixed(1)]);
  if (r.rottenTomatoes != null) chips.push(['RT', `${r.rottenTomatoes}%`]);
  if (r.audience != null) chips.push(['🍿', `${r.audience}%`]);
  if (r.metacritic != null) chips.push(['MC', String(r.metacritic)]);
  if (r.trakt != null) chips.push(['Trakt', `${r.trakt}%`]);
  if (r.letterboxd != null) chips.push(['LB', r.letterboxd.toFixed(1)]);
  if (r.mal != null) chips.push(['MAL', r.mal.toFixed(1)]);
  if (r.tmdb != null && r.imdb == null) chips.push(['TMDB', r.tmdb.toFixed(1)]);
  if (!chips.length) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: t.space.sm }}>
      {chips.map(([src, v]) => (
        <View key={src} style={{ flexDirection: 'row', gap: 4, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: t.colors.surfaceAlt }}>
          <T variant="caption" tone="muted" weight="700">{src}</T>
          <T variant="caption" weight="700">{v}</T>
        </View>
      ))}
    </View>
  );
}

const BAND = (r: number | null) => (r == null ? 'rgba(255,255,255,0.12)' : r >= 9 ? '#3fb950' : r >= 8 ? '#8bd450' : r >= 7 ? '#e3c44c' : r >= 6 ? '#f0883e' : '#f85149');

export function EpisodeRatingsGrid({ showId }: { showId: string }) {
  const t = useTheme();
  const api = useApi();
  const [data, setData] = useState<EpisodeRatings | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    api.episodeRatings(showId, ctrl.signal).then(setData).catch(() => setData(null));
    return () => ctrl.abort();
  }, [api, showId]);
  if (!data?.seasons.some((s) => s.episodes.some((e) => e.rating != null))) return null;
  const cell = t.isTV ? t.s(54) : 36;
  // Cells are placed by episode number, so a season with gaps still shows its last episodes.
  const maxEp = Math.min(60, Math.max(...data.seasons.flatMap((s) => s.episodes.map((e) => e.episode))));
  return (
    <View style={{ paddingHorizontal: t.space.gutter, marginBottom: t.space.xl, gap: t.space.sm }}>
      <T variant="heading">Episode ratings <T variant="caption" tone="muted">{data.source === 'imdb' ? 'IMDb' : 'TMDB'}</T></T>
      <ScrollView horizontal showsHorizontalScrollIndicator={false}>
        <View style={{ gap: 3 }}>
          {data.seasons.map((s) => (
            <View key={s.season} style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
              <T variant="caption" tone="muted" style={{ width: 28 }}>S{s.season}</T>
              {Array.from({ length: maxEp }, (_, i) => {
                const e = s.episodes.find((x) => x.episode === i + 1);
                if (!e) return <View key={i} style={{ width: cell, height: cell * 0.75 }} />;
                const label = `Season ${s.season} episode ${e.episode}${e.title ? `, ${e.title}` : ''}: ${e.rating != null ? e.rating.toFixed(1) : 'no rating'}`;
                return (
                  <Focusable key={i} onPress={e.itemId ? () => openItem({ id: e.itemId!, type: 'episode' } as Item) : undefined} accessibilityLabel={label}
                    style={{ width: cell, height: cell * 0.75, borderRadius: 5, backgroundColor: BAND(e.rating), alignItems: 'center', justifyContent: 'center' }}>
                    <T variant="caption" weight="700" color={e.rating == null ? undefined : '#0b0b0f'}>{e.rating != null ? e.rating.toFixed(1) : '–'}</T>
                  </Focusable>
                );
              })}
            </View>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

export function TraktComments({ item }: { item: Item }) {
  const t = useTheme();
  const api = useApi();
  const [list, setList] = useState<TraktComment[]>([]);
  const [shown, setShown] = useState<Set<number>>(new Set());
  useEffect(() => {
    const ctrl = new AbortController();
    api.comments(item.id, ctrl.signal).then(setList).catch(() => setList([]));
    return () => ctrl.abort();
  }, [api, item.id]);
  if (!list.length) return null;
  return (
    <View style={{ paddingHorizontal: t.space.gutter, marginBottom: t.space.xl, gap: t.space.sm }}>
      <T variant="heading">Comments on Trakt</T>
      {list.slice(0, 8).map((c) => {
        const hidden = c.spoiler && !shown.has(c.id);
        return (
          <Focusable key={c.id} onPress={hidden ? () => setShown((s) => new Set(s).add(c.id)) : undefined} style={{ padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, gap: 4 }}>
            <T variant="small" weight="700">{c.user}{c.rating != null ? `  ★ ${c.rating}/10` : ''}{c.review ? '  · Review' : ''}</T>
            <T variant="small" tone={hidden ? 'muted' : 'default'} numberOfLines={hidden ? 1 : 8}>{hidden ? 'Contains spoilers · tap to show' : c.comment}</T>
            <T variant="caption" tone="muted">{c.likes} likes</T>
          </Focusable>
        );
      })}
    </View>
  );
}
