import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

export function ProgressBar({ value, height, style, color, track }: { value: number; height?: number; style?: StyleProp<ViewStyle>; color?: string; track?: string }) {
  const t = useTheme();
  const h = height ?? (t.isTV ? t.s(5) : 3);
  return (
    <View style={[{ height: h, borderRadius: h, backgroundColor: track ?? t.alpha('#ffffff', 0.25), overflow: 'hidden' }, style]}>
      <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: '100%', backgroundColor: color ?? t.colors.primary, borderRadius: h }} />
    </View>
  );
}
