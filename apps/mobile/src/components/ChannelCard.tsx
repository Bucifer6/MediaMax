import React, { memo } from 'react';
import { View } from 'react-native';
import type { Channel } from '@/api/types';
import { useTheme } from '@/theme';
import { formatTime, programProgress } from '@/utils/format';
import { playChannel } from '@/utils/nav';
import { Focusable } from './Focusable';
import { Img } from './Img';
import { ProgressBar } from './ProgressBar';
import { T } from './Text';

export const ChannelCard = memo(function ChannelCard({ channel, onFocusChannel, hasTVPreferredFocus }: { channel: Channel; onFocusChannel?: (c: Channel) => void; hasTVPreferredFocus?: boolean }) {
  const t = useTheme();
  const w = t.card.channelWidth;
  const h = t.card.channelHeight;
  const radius = t.shapeRadius(w, h);
  const now = channel.nowPlaying;
  return (
    <View style={{ width: w }}>
      <Focusable
        onPress={() => playChannel(channel)}
        onFocus={() => onFocusChannel?.(channel)}
        hasTVPreferredFocus={hasTVPreferredFocus}
        ringRadius={radius}
        accessibilityLabel={channel.name}
        style={{ width: w, height: h, borderRadius: radius, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, padding: t.space.md, justifyContent: 'space-between' }}
      >
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {channel.logoUrl ? (
            <Img path={channel.logoUrl} width={w * 0.6} contentFit="contain" style={{ width: '70%', height: '70%' }} />
          ) : (
            <T variant="heading" center numberOfLines={2}>
              {channel.name}
            </T>
          )}
        </View>
        {now ? <ProgressBar value={programProgress(now)} /> : null}
        {channel.number != null ? (
          <View style={{ position: 'absolute', top: 6, left: 8 }}>
            <T variant="caption" tone="muted">
              {channel.number}
            </T>
          </View>
        ) : null}
      </Focusable>
      <View style={{ marginTop: t.space.xs + 2, paddingHorizontal: 2 }}>
        <T variant="small" weight="600" numberOfLines={1}>
          {now?.title ?? channel.name}
        </T>
        <T variant="caption" tone="muted" weight="500" numberOfLines={1}>
          {now ? `${formatTime(now.start)}–${formatTime(now.end)} · ${channel.name}` : channel.categoryName ?? 'Live'}
        </T>
      </View>
    </View>
  );
});
