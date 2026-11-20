import Ionicons from '@expo/vector-icons/Ionicons';
import React from 'react';
import type { StyleProp, TextStyle } from 'react-native';
import { useTheme } from '@/theme';

export type IconName = React.ComponentProps<typeof Ionicons>['name'];

export function Icon({ name, size, color, style }: { name: IconName; size?: number; color?: string; style?: StyleProp<TextStyle> }) {
  const t = useTheme();
  return <Ionicons name={name} size={size ?? (t.isTV ? t.s(26) : 22)} color={color ?? t.colors.text} style={style} />;
}
