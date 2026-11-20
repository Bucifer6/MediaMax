/**
 * EPG guide grid.
 *
 * Performance notes: one horizontal ScrollView holds a vertically virtualised
 * FlatList (fixed row height + getItemLayout). Channel cells and the time
 * header corner stay pinned by translating them with the native-driven
 * horizontal scroll offset, so horizontal scrolling never re-renders React.
 * On TV every programme is a focusable cell; the native focus engine scrolls
 * both axes to keep the focused programme on screen.
 */
import { useLocalSearchParams } from 'expo-router';
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, FlatList, View, type LayoutChangeEvent } from 'react-native';
import type { Channel, Program } from '@/api/types';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { ProgramSheet } from '@/components/ProgramSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState } from '@/components/States';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDay, formatTime } from '@/utils/format';
import { playChannel } from '@/utils/nav';
import { on } from '@/utils/events';

const WINDOW_H = 6;
const PAGE = 60;
const HALF_HOUR = 30 * 60000;

function floorHalfHour(ms: number) {
  return Math.floor(ms / HALF_HOUR) * HALF_HOUR;
}

export default function GuideScreen() {
  const t = useTheme();
  const api = useApi();
  const params = useLocalSearchParams<{ category?: string }>();
  const [favOnly, setFavOnly] = useState(false);
  const [windowStart, setWindowStart] = useState(() => floorHalfHour(Date.now() - HALF_HOUR));
  const windowEnd = windowStart + WINDOW_H * 3600000;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [programs, setPrograms] = useState<Map<string, Program[]>>(new Map());
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [selected, setSelected] = useState<{ p: Program; c: Channel } | null>(null);
  const [focused, setFocused] = useState<{ p: Program; c: Channel } | null>(null);
  const [height, setHeight] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [nonce, setNonce] = useState(0);
  const loadingMore = useRef(false);
  const scrollX = useRef(new Animated.Value(0)).current;
  const hRef = useRef<ScrollViewLike>(null);

  const PX = t.isTV ? t.s(7) : 4.5; // pixels per minute
  const ROW = t.isTV ? t.s(78) : 62;
  const CH_W = t.isTV ? t.s(210) : 104;
  const HEAD = t.isTV ? t.s(44) : 34;
  const timelineW = WINDOW_H * 60 * PX;

  const fetchPage = useCallback(
    async (offset: number) => {
      const r = await api.guide({ start: new Date(windowStart).toISOString(), end: new Date(windowEnd).toISOString(), categoryId: params.category, favorite: favOnly || undefined, offset, limit: PAGE });
      const map = new Map<string, Program[]>();
      for (const p of r.programs) {
        const list = map.get(p.channelId) ?? [];
        list.push(p);
        map.set(p.channelId, list);
      }
      for (const list of map.values()) list.sort((a, b) => a.start.localeCompare(b.start));
      return { channels: r.channels, programs: map };
    },
    [api, windowStart, windowEnd, params.category, favOnly],
  );

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchPage(0)
      .then((r) => {
        if (!alive) return;
        setChannels(r.channels);
        setPrograms(r.programs);
        setHasMore(r.channels.length >= PAGE);
      })
      .catch((e) => alive && setError(e))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [fetchPage, nonce]);

  // Keep recording dots current.
  useEffect(
    () =>
      on('recording', (rec) => {
        if (!rec.programId) return;
        setPrograms((prev) => {
          const list = prev.get(rec.channelId);
          if (!list) return prev;
          const next = new Map(prev);
          next.set(rec.channelId, list.map((p) => (p.id === rec.programId ? { ...p, recordingId: rec.status === 'cancelled' ? null : rec.id } : p)));
          return next;
        });
      }),
    [],
  );

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const loadMore = async () => {
    if (loadingMore.current || !hasMore) return;
    loadingMore.current = true;
    try {
      const r = await fetchPage(channels.length);
      setChannels((prev) => [...prev, ...r.channels.filter((c) => !prev.some((p) => p.id === c.id))]);
      setPrograms((prev) => new Map([...prev, ...r.programs]));
      setHasMore(r.channels.length >= PAGE);
    } catch {
      /* retry on next scroll */
    } finally {
      loadingMore.current = false;
    }
  };

  // Scroll so "now" is near the left edge.
  const scrollToNow = useCallback(() => {
    const x = Math.max(0, ((Date.now() - windowStart) / 60000) * PX - 30 * PX);
    hRef.current?.scrollTo({ x, animated: false });
  }, [windowStart, PX]);
  useEffect(() => {
    if (!loading) setTimeout(scrollToNow, 50);
  }, [loading, scrollToNow]);

  const updateProgram = useCallback((p: Program) => {
    setPrograms((prev) => {
      const list = prev.get(p.channelId);
      if (!list) return prev;
      const next = new Map(prev);
      next.set(p.channelId, list.map((x) => (x.id === p.id ? p : x)));
      return next;
    });
  }, []);

  const onSelect = useCallback((p: Program, c: Channel) => setSelected({ p, c }), []);
  const onFocusProgram = useCallback((p: Program, c: Channel) => setFocused({ p, c }), []);

  const hours = useMemo(() => {
    const out: number[] = [];
    for (let ms = windowStart; ms < windowEnd; ms += HALF_HOUR) out.push(ms);
    return out;
  }, [windowStart, windowEnd]);

  const nowX = ((now - windowStart) / 60000) * PX;
  const renderRow = useCallback(
    ({ item, index }: { item: Channel; index: number }) => (
      <GuideRow channel={item} programs={programs.get(item.id) ?? []} windowStart={windowStart} windowEnd={windowEnd} px={PX} rowH={ROW} chW={CH_W} scrollX={scrollX} onSelect={onSelect} onFocusProgram={onFocusProgram} preferred={index === 0} now={now} />
    ),
    [programs, windowStart, windowEnd, PX, ROW, CH_W, scrollX, onSelect, onFocusProgram, now],
  );

  return (
    <Screen>
      <ScreenHeader
        title="TV Guide"
        subtitle={`${formatDay(new Date(windowStart))} · ${formatTime(new Date(windowStart))} – ${formatTime(new Date(windowEnd))}`}
        right={
          <View style={{ flexDirection: 'row', gap: t.space.xs }}>
            <Chip label="Earlier" icon="chevron-back" onPress={() => setWindowStart((s) => s - 3 * 3600000)} />
            <Chip label="Now" onPress={() => (windowStart === floorHalfHour(Date.now() - HALF_HOUR) ? scrollToNow() : setWindowStart(floorHalfHour(Date.now() - HALF_HOUR)))} />
            <Chip label="Later" icon="chevron-forward" onPress={() => setWindowStart((s) => s + 3 * 3600000)} />
            <Chip label="Favourites" icon="star" selected={favOnly} onPress={() => setFavOnly((f) => !f)} />
          </View>
        }
      />
      {t.isTV ? <TVPreview focused={focused} /> : null}
      <View style={{ flex: 1 }} onLayout={(e: LayoutChangeEvent) => setHeight(e.nativeEvent.layout.height)}>
        {loading && !channels.length ? (
          <ActivityIndicator style={{ marginTop: t.space.xl }} color={t.colors.primary} size="large" />
        ) : error && !channels.length ? (
          <ErrorState error={error} onRetry={() => setNonce((n) => n + 1)} />
        ) : !channels.length ? (
          <EmptyState icon="grid-outline" title="No guide data" message={favOnly ? 'You have no favourite channels yet.' : 'No programme information is available for this time.'} />
        ) : (
          <Animated.ScrollView
            ref={hRef as never}
            horizontal
            showsHorizontalScrollIndicator={false}
            scrollEventThrottle={16}
            onScroll={Animated.event([{ nativeEvent: { contentOffset: { x: scrollX } } }], { useNativeDriver: true })}
            bounces={false}
          >
            <View style={{ width: CH_W + timelineW }}>
              {/* Time header */}
              <View style={{ height: HEAD, flexDirection: 'row' }}>
                <Animated.View style={{ width: CH_W, height: HEAD, backgroundColor: t.colors.background, zIndex: 3, transform: [{ translateX: scrollX }], justifyContent: 'center', paddingLeft: t.space.sm }}>
                  <T variant="caption" tone="muted">
                    {formatDay(new Date(windowStart))}
                  </T>
                </Animated.View>
                <View style={{ width: timelineW, height: HEAD }}>
                  {hours.map((ms) => (
                    <View key={ms} style={{ position: 'absolute', left: ((ms - windowStart) / 60000) * PX, top: 0, bottom: 0, justifyContent: 'center', paddingLeft: 6, borderLeftWidth: 1, borderLeftColor: t.colors.border }}>
                      <T variant="small" tone="muted" weight="700">
                        {formatTime(new Date(ms))}
                      </T>
                    </View>
                  ))}
                </View>
              </View>
              <FlatList
                style={{ height: Math.max(0, height - HEAD) }}
                data={channels}
                keyExtractor={(c) => c.id}
                renderItem={renderRow}
                getItemLayout={(_, index) => ({ length: ROW, offset: ROW * index, index })}
                initialNumToRender={Math.ceil(height / ROW) + 2}
                maxToRenderPerBatch={12}
                windowSize={t.isTV ? 5 : 9}
                removeClippedSubviews={!t.isTV}
                onEndReached={loadMore}
                onEndReachedThreshold={2}
                showsVerticalScrollIndicator={false}
                ListFooterComponent={hasMore ? <ActivityIndicator color={t.colors.primary} style={{ margin: t.space.md, alignSelf: 'flex-start', marginLeft: CH_W }} /> : undefined}
              />
              {/* Now line */}
              {nowX > 0 && nowX < timelineW ? (
                <View pointerEvents="none" style={{ position: 'absolute', top: HEAD - 6, bottom: 0, left: CH_W + nowX - 1, width: 2, backgroundColor: t.colors.danger }}>
                  <View style={{ position: 'absolute', top: 0, left: -4, width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.danger }} />
                </View>
              ) : null}
            </View>
          </Animated.ScrollView>
        )}
      </View>
      <ProgramSheet program={selected?.p ?? null} channel={selected?.c} onClose={() => setSelected(null)} onChanged={updateProgram} />
    </Screen>
  );
}

type ScrollViewLike = { scrollTo: (o: { x: number; animated?: boolean }) => void };

function TVPreview({ focused }: { focused: { p: Program; c: Channel } | null }) {
  const t = useTheme();
  return (
    <View style={{ height: t.s(110), paddingHorizontal: t.space.gutter, paddingBottom: t.space.sm, justifyContent: 'flex-end' }}>
      {focused ? (
        <>
          <T variant="caption" tone="primary" style={{ textTransform: 'uppercase' }}>
            {focused.c.name} · {formatTime(focused.p.start)} – {formatTime(focused.p.end)}
            {focused.p.recordingId ? '  ● REC' : ''}
          </T>
          <T variant="heading" numberOfLines={1}>
            {focused.p.title}
          </T>
          <T tone="muted" numberOfLines={2} style={{ maxWidth: t.width * 0.7 }}>
            {focused.p.description ?? focused.p.subtitle ?? ''}
          </T>
        </>
      ) : null}
    </View>
  );
}

const GuideRow = memo(function GuideRow({
  channel,
  programs,
  windowStart,
  windowEnd,
  px,
  rowH,
  chW,
  scrollX,
  onSelect,
  onFocusProgram,
  preferred,
  now,
}: {
  channel: Channel;
  programs: Program[];
  windowStart: number;
  windowEnd: number;
  px: number;
  rowH: number;
  chW: number;
  scrollX: Animated.Value;
  onSelect: (p: Program, c: Channel) => void;
  onFocusProgram: (p: Program, c: Channel) => void;
  preferred: boolean;
  now: number;
}) {
  const t = useTheme();
  const pad = 2;
  return (
    <View style={{ height: rowH, flexDirection: 'row' }}>
      <Animated.View style={{ width: chW, height: rowH, zIndex: 3, transform: [{ translateX: scrollX }], backgroundColor: t.colors.background, paddingRight: pad, paddingBottom: pad }}>
        <Focusable onPress={() => playChannel(channel)} focusScale={1} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 6, backgroundColor: t.colors.surface, borderRadius: t.radius / 2 }}>
          {channel.logoUrl ? <Img path={channel.logoUrl} width={chW * 0.4} contentFit="contain" style={{ width: chW * 0.38, height: rowH * 0.6 }} /> : null}
          <View style={{ flex: 1 }}>
            <T variant="caption" tone="muted">
              {channel.number ?? ''}
            </T>
            <T variant="small" weight="700" numberOfLines={2}>
              {channel.name}
            </T>
          </View>
          {channel.favorite ? <Icon name="star" size={t.isTV ? t.s(14) : 11} color={t.colors.warning} /> : null}
        </Focusable>
      </Animated.View>
      <View style={{ flex: 1, height: rowH }}>
        {programs.length === 0 ? (
          <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: pad, backgroundColor: t.alpha(t.colors.surface, 0.5), borderRadius: t.radius / 2, justifyContent: 'center', paddingHorizontal: t.space.sm }}>
            <T variant="small" tone="muted">
              No information
            </T>
          </View>
        ) : null}
        {programs.map((p, i) => {
          const s = Math.max(new Date(p.start).getTime(), windowStart);
          const e = Math.min(new Date(p.end).getTime(), windowEnd);
          if (e <= s) return null;
          const left = ((s - windowStart) / 60000) * px;
          const width = Math.max(4, ((e - s) / 60000) * px - pad);
          const airing = new Date(p.start).getTime() <= now && new Date(p.end).getTime() > now;
          const past = new Date(p.end).getTime() <= now;
          return (
            <Focusable
              key={p.id}
              containerStyle={{ position: 'absolute', left, top: 0, width, height: rowH - pad }}
              focusScale={1.02}
              hasTVPreferredFocus={preferred && airing}
              onPress={() => onSelect(p, channel)}
              onFocus={() => onFocusProgram(p, channel)}
              ringRadius={t.radius / 2}
              style={{ flex: 1, borderRadius: t.radius / 2, paddingHorizontal: t.isTV ? t.s(10) : 6, justifyContent: 'center', backgroundColor: airing ? t.alpha(t.colors.primary, 0.22) : past ? t.alpha(t.colors.surface, 0.55) : t.colors.surface, overflow: 'hidden' }}
            >
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                {p.recordingId ? <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: t.colors.danger }} /> : null}
                <T variant="small" weight="700" numberOfLines={1} tone={past ? 'muted' : 'default'} style={{ flexShrink: 1 }}>
                  {p.title}
                </T>
              </View>
              {width > 70 ? (
                <T variant="caption" tone="muted" weight="500" numberOfLines={1}>
                  {formatTime(p.start)} – {formatTime(p.end)}
                  {p.isNew ? '  NEW' : ''}
                </T>
              ) : null}
              {i === 0 && new Date(p.start).getTime() < windowStart ? <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 3, backgroundColor: t.colors.border }} /> : null}
            </Focusable>
          );
        })}
      </View>
    </View>
  );
});
