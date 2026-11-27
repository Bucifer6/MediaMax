/**
 * Coming soon: upcoming episodes of the viewer's shows by air date (TMDB), then what was added recently
 * (GET /calendar: the last 7 days to 30 days ahead). The "See all" of the home "Coming soon" row.
 */
import { router } from 'expo-router';
import { useMemo, useState } from 'react';
import { SectionList, View } from 'react-native';
import type { CalendarEntry } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Img } from '@/components/Img';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';
import { itemHref } from '@/utils/nav';

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** "Today", "Tomorrow", "Yesterday", else "Mon 1 Dec". */
export function dayLabel(date: string, now = new Date()): string {
  const today = ymd(now);
  const t = new Date(now);
  t.setDate(t.getDate() + 1);
  const y = new Date(now);
  y.setDate(y.getDate() - 1);
  if (date === today) return 'Today';
  if (date === ymd(t)) return 'Tomorrow';
  if (date === ymd(y)) return 'Yesterday';
  const [yy, mm, dd] = date.split('-').map(Number);
  return new Date(yy!, mm! - 1, dd!).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

const epCode = (e: CalendarEntry) => (e.seasonNumber != null && e.episodeNumber != null ? `S${e.seasonNumber} · E${e.episodeNumber}` : null);

export default function CalendarScreen() {
  const t = useTheme();
  const [followingOnly, setFollowingOnly] = useState(false);
  const { data, error, loading, refresh } = useQuery('calendar', (api, signal) => api.calendar({}, signal), { staleMs: 300000 });

  const sections = useMemo(() => {
    const today = ymd(new Date());
    const entries = (data?.entries ?? []).filter((e) => !followingOnly || e.following);
    const group = (list: CalendarEntry[], kind: 'upcoming' | 'added') => {
      const byDay = new Map<string, CalendarEntry[]>();
      for (const e of list) byDay.set(e.date, [...(byDay.get(e.date) ?? []), e]);
      const days = [...byDay.keys()].sort();
      if (kind === 'added') days.reverse();
      return days.map((d) => ({ title: kind === 'added' ? `Added ${dayLabel(d).toLowerCase() === 'today' ? 'today' : dayLabel(d)}` : dayLabel(d), data: byDay.get(d)! }));
    };
    return [
      ...group(entries.filter((e) => e.kind === 'upcoming' && e.date >= today), 'upcoming'),
      ...group(entries.filter((e) => e.kind === 'added'), 'added'),
    ];
  }, [data, followingOnly]);

  const thumbW = t.isTV ? t.s(150) : 96;
  return (
    <Screen>
      <ScreenHeader title="Coming soon" subtitle={data && !data.tmdbConfigured ? 'Upcoming episodes need a TMDB key on the server: showing recently added only' : undefined} />
      <View style={{ flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingVertical: t.space.sm }}>
        <Chip label="All shows" selected={!followingOnly} onPress={() => setFollowingOnly(false)} hasTVPreferredFocus />
        <Chip label="Shows I follow" icon="heart-outline" selected={followingOnly} onPress={() => setFollowingOnly(true)} />
      </View>
      {loading && !data ? (
        <Loading />
      ) : error && !data ? (
        <ErrorState error={error} onRetry={refresh} />
      ) : !sections.length ? (
        <EmptyState icon="calendar-outline" title="Nothing coming up" message={followingOnly ? 'No new episodes of the shows you follow in the next month.' : 'No upcoming or recently added episodes.'} />
      ) : (
        <SectionList
          sections={sections}
          keyExtractor={(e, i) => `${e.kind}:${e.show.id}:${e.date}:${e.episodeNumber ?? ''}:${i}`}
          stickySectionHeadersEnabled={!t.isTV}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2 }}
          renderSectionHeader={({ section }) => (
            <T variant="heading" style={{ paddingTop: t.space.lg, paddingBottom: t.space.sm, backgroundColor: t.colors.background }}>{section.title}</T>
          )}
          renderItem={({ item: e }) => {
            const target = e.episode ?? e.show;
            const art = e.episode?.thumbUrl ?? e.show.backdropUrl ?? e.show.posterUrl;
            return (
              <Focusable
                onPress={() => router.push(itemHref(target) as never)}
                focusScale={t.isTV ? 1.02 : 1}
                style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, marginBottom: t.space.xs }}
                accessibilityLabel={`${e.show.title}${epCode(e) ? `, ${epCode(e)}` : ''}${e.title ? `, ${e.title}` : ''}`}
              >
                <View style={{ width: thumbW, height: Math.round(thumbW * 9 / 16), borderRadius: t.radius * 0.6, overflow: 'hidden', backgroundColor: t.colors.surface }}>
                  {art ? <Img path={art} width={thumbW * 2} style={{ width: '100%', height: '100%' }} /> : null}
                </View>
                <View style={{ flex: 1, gap: 2 }}>
                  <T weight="700" numberOfLines={1}>{e.show.title}</T>
                  <T variant="small" tone="muted" numberOfLines={1}>{[epCode(e), e.title].filter(Boolean).join(' · ') || (e.kind === 'added' ? 'New episodes' : 'New episode')}</T>
                  {e.overview && !t.isTV ? <T variant="small" tone="muted" numberOfLines={2}>{e.overview}</T> : null}
                </View>
                {e.kind === 'added' ? <T variant="caption" tone="primary" weight="800">NEW</T> : e.following ? <T variant="caption" tone="muted">Following</T> : null}
              </Focusable>
            );
          }}
        />
      )}
    </Screen>
  );
}
