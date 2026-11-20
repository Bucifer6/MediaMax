import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { useDj } from '@/state/dj';
import { useMusic } from '@/state/music';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { Img } from './Img';
import { ProgressBar } from './ProgressBar';
import { T } from './Text';

/** Persistent now-playing bar shown above the tab bar (phones) / bottom-right (TV). */
export function MiniPlayer() {
  const t = useTheme();
  const m = useMusic();
  const dj = useDj();
  if (dj.active) return <DjMiniPlayer />;
  if (!m.current) return null;
  const art = m.current.posterUrl ?? m.current.thumbUrl;
  const size = t.isTV ? t.s(56) : 44;
  return (
    <View
      style={{
        marginHorizontal: t.isTV ? 0 : t.space.sm,
        marginBottom: t.isTV ? 0 : t.space.xs,
        borderRadius: t.radius,
        backgroundColor: t.colors.surfaceAlt,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: t.colors.border,
        width: t.isTV ? t.s(420) : undefined,
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 16,
        elevation: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.sm }}>
        <Focusable onPress={() => router.push('/music')} focusScale={1.03} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <View style={{ width: size, height: size, borderRadius: t.radius / 2, overflow: 'hidden', backgroundColor: t.colors.surface }}>
            {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : <Icon name="musical-notes" />}
          </View>
          <View style={{ flex: 1 }}>
            <T variant="small" weight="700" numberOfLines={1}>
              {m.current.title}
            </T>
            <T variant="caption" tone="muted" numberOfLines={1}>
              {m.current.grandparentTitle ?? m.current.parentTitle ?? ''}
            </T>
          </View>
        </Focusable>
        <Focusable onPress={m.toggle} accessibilityLabel={m.playing ? 'Pause' : 'Play'} ringRadius={999} style={{ padding: t.space.xs, borderRadius: 999 }}>
          <Icon name={m.playing ? 'pause' : 'play'} size={t.isTV ? t.s(28) : 26} />
        </Focusable>
        <Focusable onPress={m.next} accessibilityLabel="Next" ringRadius={999} style={{ padding: t.space.xs, borderRadius: 999 }}>
          <Icon name="play-forward" size={t.isTV ? t.s(26) : 22} />
        </Focusable>
      </View>
      <ProgressBar value={m.durationMs ? m.positionMs / m.durationMs : 0} height={2} style={{ borderRadius: 0 }} track="transparent" />
    </View>
  );
}

/** While DJ mode plays: the audible deck's track, pause/resume and a way back to the booth. */
function DjMiniPlayer() {
  const t = useTheme();
  const dj = useDj();
  const deck = dj.decks[dj.mixing ? (dj.crossfader >= 0.5 ? 'B' : 'A') : dj.liveDeck];
  const it = deck.track?.item;
  const art = it?.posterUrl ?? it?.thumbUrl;
  const size = t.isTV ? t.s(56) : 44;
  return (
    <View
      style={{
        marginHorizontal: t.isTV ? 0 : t.space.sm,
        marginBottom: t.isTV ? 0 : t.space.xs,
        borderRadius: t.radius,
        backgroundColor: t.colors.surfaceAlt,
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: t.colors.primary,
        width: t.isTV ? t.s(420) : undefined,
        shadowColor: '#000',
        shadowOpacity: 0.35,
        shadowRadius: 16,
        elevation: 10,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.sm }}>
        <Focusable onPress={() => router.push('/dj' as never)} focusScale={1.03} style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <View style={{ width: size, height: size, borderRadius: t.radius / 2, overflow: 'hidden', backgroundColor: t.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
            {art ? <Img path={art} width={size} style={{ width: '100%', height: '100%' }} /> : <Icon name="disc-outline" />}
          </View>
          <View style={{ flex: 1 }}>
            <T variant="small" weight="700" numberOfLines={1}>
              {it?.title ?? 'Building your mix…'}
            </T>
            <T variant="caption" tone="primary" numberOfLines={1}>
              {dj.mixing ? 'DJ mode · mixing' : `DJ mode${it ? ` · ${it.grandparentTitle ?? it.parentTitle ?? ''}` : ''}`}
            </T>
          </View>
        </Focusable>
        <Focusable onPress={dj.toggle} accessibilityLabel={dj.phase === 'paused' ? 'Resume DJ mix' : 'Pause DJ mix'} ringRadius={999} style={{ padding: t.space.xs, borderRadius: 999 }}>
          <Icon name={dj.phase === 'paused' ? 'play' : 'pause'} size={t.isTV ? t.s(28) : 26} />
        </Focusable>
        <Focusable onPress={dj.stop} accessibilityLabel="Stop DJ mix" ringRadius={999} style={{ padding: t.space.xs, borderRadius: 999 }}>
          <Icon name="stop" size={t.isTV ? t.s(24) : 20} />
        </Focusable>
      </View>
      <ProgressBar value={deck.durationMs ? deck.positionMs / deck.durationMs : 0} height={2} style={{ borderRadius: 0 }} track="transparent" />
    </View>
  );
}
