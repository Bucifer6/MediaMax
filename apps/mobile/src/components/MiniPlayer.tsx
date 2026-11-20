import { router } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
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
