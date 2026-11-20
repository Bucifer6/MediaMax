import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React from 'react';
import { FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { EmptyState } from '@/components/States';
import { T } from '@/components/Text';
import { Scrubber } from '@/player/Scrubber';
import { useMusic } from '@/state/music';
import { useTheme } from '@/theme';
import { useTVRemote } from '@/tv';
import { formatClock } from '@/utils/format';

export default function NowPlaying() {
  const t = useTheme();
  const m = useMusic();
  const insets = useSafeAreaInsets();
  useTVRemote((e) => {
    if (e.eventType === 'playPause') m.toggle();
    if (e.eventType === 'fastForward') m.next();
    if (e.eventType === 'rewind') m.previous();
  });
  const cur = m.current;
  if (!cur) return <View style={{ flex: 1, backgroundColor: t.colors.background }}><EmptyState icon="musical-notes-outline" title="Nothing playing" action="Close" onAction={() => router.back()} /></View>;

  const art = cur.posterUrl ?? cur.thumbUrl;
  const size = t.isTV ? t.s(420) : Math.min(t.width - 64, t.height * 0.42, 420);
  const transportIcon = t.isTV ? t.s(34) : 32;

  const controls = (
    <View style={{ width: t.isTV ? t.s(520) : '100%', gap: t.space.lg }}>
      <View style={{ gap: 4 }}>
        <T variant={t.isTV ? 'title' : 'heading'} color="#fff" numberOfLines={2}>{cur.title}</T>
        <Focusable onPress={() => cur.grandparentId && router.push(`/item/${cur.grandparentId}` as never)} focusScale={1}>
          <T color="rgba(255,255,255,0.75)" numberOfLines={1}>{[cur.grandparentTitle, cur.parentTitle].filter(Boolean).join(' — ')}</T>
        </Focusable>
      </View>
      <Scrubber positionMs={m.positionMs} durationMs={m.durationMs} onSeek={m.seek} />
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Focusable onPress={() => m.setShuffle(!m.shuffle)} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Shuffle">
          <Icon name="shuffle" size={t.isTV ? t.s(26) : 24} color={m.shuffle ? t.colors.primary : 'rgba(255,255,255,0.7)'} />
        </Focusable>
        <Focusable onPress={m.previous} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Previous">
          <Icon name="play-skip-back" size={transportIcon} color="#fff" />
        </Focusable>
        <Focusable onPress={m.toggle} hasTVPreferredFocus ringRadius={999} style={{ width: t.s(76), height: t.s(76), borderRadius: t.s(38), backgroundColor: '#fff', alignItems: 'center', justifyContent: 'center' }} accessibilityLabel={m.playing ? 'Pause' : 'Play'}>
          <Icon name={m.playing ? 'pause' : 'play'} size={t.s(38)} color="#000" />
        </Focusable>
        <Focusable onPress={m.next} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Next">
          <Icon name="play-skip-forward" size={transportIcon} color="#fff" />
        </Focusable>
        <Focusable onPress={m.cycleRepeat} ringRadius={999} style={{ padding: 10, borderRadius: 999 }} accessibilityLabel="Repeat">
          <View>
            <Icon name="repeat" size={t.isTV ? t.s(26) : 24} color={m.repeat !== 'off' ? t.colors.primary : 'rgba(255,255,255,0.7)'} />
            {m.repeat === 'one' ? <T variant="caption" color={t.colors.primary} style={{ position: 'absolute', right: -6, top: -6 }}>1</T> : null}
          </View>
        </Focusable>
      </View>
      {m.error ? <T tone="danger">{m.error}</T> : null}
    </View>
  );

  const queue = (
    <FlatList
      data={m.queue}
      keyExtractor={(x, i) => `${x.id}-${i}`}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + t.space.lg }}
      ListHeaderComponent={<T variant="heading" color="#fff" style={{ marginBottom: t.space.sm }}>Up next</T>}
      renderItem={({ item, index }) => (
        <Focusable onPress={() => m.jumpTo(index)} focusScale={t.isTV ? 1.02 : 1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: index === m.index ? 'rgba(255,255,255,0.12)' : 'transparent' }}>
          {index === m.index ? <Icon name="volume-high" size={16} color={t.colors.primary} /> : <T variant="small" color="rgba(255,255,255,0.6)" style={{ width: 16 }}>{index + 1}</T>}
          <View style={{ flex: 1 }}>
            <T weight={index === m.index ? '800' : '600'} color="#fff" numberOfLines={1}>{item.title}</T>
            <T variant="caption" color="rgba(255,255,255,0.6)" numberOfLines={1}>{item.grandparentTitle ?? item.parentTitle ?? ''}</T>
          </View>
          <T variant="small" color="rgba(255,255,255,0.6)">{item.durationMs ? formatClock(item.durationMs) : ''}</T>
        </Focusable>
      )}
    />
  );

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      {art ? <Img path={art} width={400} blurRadius={50} style={{ position: 'absolute', width: '100%', height: '100%', opacity: 0.7 }} /> : null}
      <LinearGradient colors={['rgba(0,0,0,0.3)', 'rgba(0,0,0,0.85)']} style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }} />
      {!t.isTV ? (
        <View style={{ paddingTop: insets.top + 6, paddingHorizontal: t.space.sm, flexDirection: 'row', alignItems: 'center' }}>
          <Focusable onPress={() => router.back()} style={{ padding: 8 }} accessibilityLabel="Close">
            <Icon name="chevron-down" color="#fff" size={28} />
          </Focusable>
          <T variant="caption" color="rgba(255,255,255,0.7)" style={{ flex: 1, textAlign: 'center', textTransform: 'uppercase' }}>Now playing</T>
          <Focusable onPress={() => { m.stop(); router.back(); }} style={{ padding: 8 }} accessibilityLabel="Stop">
            <Icon name="stop-circle-outline" color="#fff" size={26} />
          </Focusable>
        </View>
      ) : null}
      {t.isTV || t.wide ? (
        <View style={{ flex: 1, flexDirection: 'row', padding: t.space.gutter, gap: t.space.xxl, alignItems: 'center' }}>
          <View style={{ gap: t.space.xl, alignItems: 'flex-start' }}>
            <View style={{ width: size, height: size, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#222', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30 }}>
              {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : null}
            </View>
            {controls}
          </View>
          <View style={{ flex: 1, alignSelf: 'stretch' }}>{queue}</View>
        </View>
      ) : (
        <View style={{ flex: 1, paddingHorizontal: 32, gap: t.space.xl, paddingTop: t.space.lg }}>
          <View style={{ alignSelf: 'center', width: size, height: size, borderRadius: t.radius, overflow: 'hidden', backgroundColor: '#222', shadowColor: '#000', shadowOpacity: 0.6, shadowRadius: 30, elevation: 16 }}>
            {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : null}
          </View>
          {controls}
          {queue}
        </View>
      )}
    </View>
  );
}
