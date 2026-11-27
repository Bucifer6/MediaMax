import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useRef, useState } from 'react';
import { Animated, FlatList, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import type { Item } from '@/api/types';
import { useTheme } from '@/theme';
import { formatDuration, itemSubtitle, progressFraction } from '@/utils/format';
import { openItem, playItem } from '@/utils/nav';
import { Button } from './Button';
import { Img } from './Img';
import { ProgressBar } from './ProgressBar';
import { T } from './Text';

export function isDirectlyPlayable(item: Item) {
  return item.type === 'movie' || item.type === 'episode' || item.type === 'video';
}

export function playOrOpen(item: Item) {
  if (isDirectlyPlayable(item)) {
    const p = progressFraction(item);
    playItem(item.id, { startMs: p > 0.01 && p < 0.95 ? item.userData.positionMs : undefined });
  } else openItem(item);
}

export function MetaLine({ item, center }: { item: Item; center?: boolean }) {
  const t = useTheme();
  const parts = [
    item.type === 'episode' ? itemSubtitle(item) : item.year ? String(item.year) : null,
    item.contentRating,
    item.durationMs && item.type !== 'show' ? formatDuration(item.durationMs) : null,
    item.communityRating ? `★ ${item.communityRating.toFixed(1)}` : null,
    item.genres?.slice(0, 2).join(', ') || null,
  ].filter(Boolean);
  return (
    <T variant="small" weight="600" color={t.alpha(t.colors.text, 0.85)} center={center} numberOfLines={1}>
      {parts.join('  •  ')}
    </T>
  );
}

function TitleOrLogo({ item, maxWidth, maxHeight, center }: { item: Item; maxWidth: number; maxHeight: number; center?: boolean }) {
  if (item.logoUrl) {
    return <Img path={item.logoUrl} width={maxWidth} contentFit="contain" style={{ width: maxWidth, height: maxHeight, alignSelf: center ? 'center' : 'flex-start' }} transition={400} />;
  }
  return (
    <T variant="hero" numberOfLines={2} center={center} style={{ maxWidth, textShadowColor: 'rgba(0,0,0,0.5)', textShadowRadius: 12 }}>
      {item.type === 'episode' ? item.grandparentTitle ?? item.title : item.title}
    </T>
  );
}

/** Phone/tablet hero: paged, auto-advancing carousel (or a single static slide). */
export function HeroCarousel({ items, style }: { items: Item[]; style: 'carousel' | 'static' }) {
  const t = useTheme();
  const list = style === 'static' ? items.slice(0, 1) : items.slice(0, 8);
  const width = t.width;
  const height = Math.round(Math.min(width * (t.wide ? 0.56 : 1.3), t.height * 0.7));
  const ref = useRef<FlatList<Item>>(null);
  const [index, setIndex] = useState(0);
  const touching = useRef(false);

  useEffect(() => {
    if (list.length < 2) return;
    const timer = setInterval(() => {
      if (touching.current) return;
      const next = (index + 1) % list.length;
      ref.current?.scrollToIndex({ index: next, animated: true });
      setIndex(next);
    }, 7000);
    return () => clearInterval(timer);
  }, [index, list.length]);

  const onMomentumEnd = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    touching.current = false;
    setIndex(Math.round(e.nativeEvent.contentOffset.x / width));
  };

  if (!list.length) return null;
  return (
    <View style={{ height, marginBottom: t.space.lg }}>
      <FlatList
        ref={ref}
        horizontal
        pagingEnabled
        data={list}
        keyExtractor={(i) => i.id}
        showsHorizontalScrollIndicator={false}
        onScrollBeginDrag={() => (touching.current = true)}
        onMomentumScrollEnd={onMomentumEnd}
        getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
        renderItem={({ item }) => (
          <View style={{ width, height }}>
            <Img path={t.wide ? item.backdropUrl ?? item.posterUrl : item.posterUrl ?? item.backdropUrl} width={width} style={{ position: 'absolute', width: '100%', height: '100%' }} priority="high" />
            <LinearGradient colors={['transparent', t.alpha(t.colors.overlay, 0.55), t.colors.background]} locations={[0.35, 0.7, 1]} style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: '75%' }} />
            <LinearGradient colors={[t.alpha(t.colors.background, 0.7), 'transparent']} style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 120 }} />
            <View style={{ position: 'absolute', left: t.space.gutter, right: t.space.gutter, bottom: t.space.xl, alignItems: t.wide ? 'flex-start' : 'center', gap: t.space.sm }}>
              <TitleOrLogo item={item} maxWidth={Math.min(width * 0.7, 420)} maxHeight={90} center={!t.wide} />
              <MetaLine item={item} center={!t.wide} />
              {t.wide && item.overview ? (
                <T tone="muted" numberOfLines={3} style={{ maxWidth: 560 }}>
                  {item.overview}
                </T>
              ) : null}
              <View style={{ flexDirection: 'row', gap: t.space.sm, marginTop: t.space.xs }}>
                <Button label={progressFraction(item) > 0.01 ? 'Resume' : 'Play'} icon="play" onPress={() => playOrOpen(item)} />
                <Button label="Info" icon="information-circle-outline" variant="secondary" onPress={() => openItem(item)} />
              </View>
            </View>
          </View>
        )}
      />
      {list.length > 1 ? (
        <View style={{ position: 'absolute', bottom: 10, alignSelf: 'center', flexDirection: 'row', gap: 6 }}>
          {list.map((i, n) => (
            <View key={i.id} style={{ width: n === index ? 18 : 6, height: 6, borderRadius: 3, backgroundColor: n === index ? t.colors.primary : t.alpha(t.colors.text, 0.35) }} />
          ))}
        </View>
      ) : null}
    </View>
  );
}

/**
 * TV: full-screen backdrop that cross-fades to whatever card is focused, with
 * the focused title's logo, metadata and synopsis in the top-left — the
 * "10-foot" cinematic look.
 */
export function TVSpotlightBackground({ item }: { item: Item | null }) {
  const t = useTheme();
  return (
    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} pointerEvents="none">
      {item ? <Img path={item.backdropUrl ?? item.thumbUrl ?? item.posterUrl} width={t.width} style={{ position: 'absolute', top: 0, right: 0, width: '78%', height: '78%' }} transition={350} priority="high" /> : null}
      <LinearGradient
        colors={[t.colors.background, t.alpha(t.colors.background, 0.85), 'transparent']}
        locations={[0, 0.35, 0.75]}
        start={{ x: 0, y: 0.5 }}
        end={{ x: 1, y: 0.5 }}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      <LinearGradient colors={['transparent', t.alpha(t.colors.background, 0.9), t.colors.background]} locations={[0.3, 0.62, 0.8]} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
    </View>
  );
}

export function TVSpotlightInfo({ item, height, children }: { item: Item | null; height: number; children?: React.ReactNode }) {
  const t = useTheme();
  const fade = useRef(new Animated.Value(1)).current;
  const [shown, setShown] = useState(item);
  useEffect(() => {
    if (item?.id === shown?.id) return;
    Animated.timing(fade, { toValue: 0, duration: 120, useNativeDriver: true }).start(() => {
      setShown(item);
      Animated.timing(fade, { toValue: 1, duration: 260, useNativeDriver: true }).start();
    });
  }, [item, shown, fade]);
  const p = shown ? progressFraction(shown) : 0;
  return (
    <View style={{ height, justifyContent: 'flex-end', paddingHorizontal: t.space.gutter, paddingBottom: t.space.lg }}>
      {shown ? (
        <Animated.View style={{ opacity: fade, gap: t.space.sm, maxWidth: t.width * 0.48 }}>
          <TitleOrLogo item={shown} maxWidth={t.s(420)} maxHeight={t.s(120)} />
          <MetaLine item={shown} />
          {shown.overview ? (
            <T tone="muted" numberOfLines={3}>
              {shown.overview}
            </T>
          ) : null}
          {p > 0.01 ? <ProgressBar value={p} style={{ width: t.s(260), marginTop: t.space.xs }} /> : null}
        </Animated.View>
      ) : null}
      {children}
    </View>
  );
}
