/** "Smart" marker for smart collections / playlists (items whose `smart` filter is set). */
import React from 'react';
import { View } from 'react-native';
import type { Item } from '@/api/types';
import { useTheme } from '@/theme';
import { Icon } from './Icon';
import { T } from './Text';

export const isSmart = (item: Pick<Item, 'smart'> | null | undefined) => !!item?.smart;

export function SmartBadge({ overlay }: { /** Compact solid pill for drawing on top of artwork. */ overlay?: boolean }) {
  const t = useTheme();
  const size = overlay ? (t.isTV ? t.s(12) : 10) : t.isTV ? t.s(15) : 13;
  return (
    <View
      accessibilityLabel="Smart list"
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 3,
        alignSelf: 'flex-start',
        paddingHorizontal: overlay ? 6 : t.isTV ? t.s(10) : 8,
        paddingVertical: overlay ? 1 : t.isTV ? t.s(3) : 2,
        borderRadius: 999,
        backgroundColor: overlay ? t.alpha(t.colors.primary, 0.92) : t.alpha(t.colors.primary, 0.16),
      }}
    >
      <Icon name="sparkles" size={size} color={overlay ? t.colors.primaryText : t.colors.primary} />
      <T variant="caption" color={overlay ? t.colors.primaryText : t.colors.primary} style={{ letterSpacing: 0.2, fontSize: overlay ? size : undefined, lineHeight: overlay ? size * 1.4 : undefined }}>
        Smart
      </T>
    </View>
  );
}
