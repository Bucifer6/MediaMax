import { router } from 'expo-router';
import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { T } from './Text';

export function Screen({ children, style, padTop = true }: { children: React.ReactNode; style?: StyleProp<ViewStyle>; padTop?: boolean }) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  return <View style={[{ flex: 1, backgroundColor: t.colors.background, paddingTop: padTop ? (t.isTV ? t.s(28) : insets.top) : 0 }, style]}>{children}</View>;
}

export function BackButton({ onPress, floating }: { onPress?: () => void; floating?: boolean }) {
  const t = useTheme();
  if (t.isTV) return null; // the remote's Back/Menu button handles this
  return (
    <Focusable
      onPress={onPress ?? (() => (router.canGoBack() ? router.back() : router.replace('/')))}
      accessibilityLabel="Back"
      style={{
        width: 38,
        height: 38,
        borderRadius: 19,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: floating ? 'rgba(0,0,0,0.45)' : 'transparent',
      }}
    >
      <Icon name="chevron-back" color={floating ? '#fff' : t.colors.text} />
    </Focusable>
  );
}

export function ScreenHeader({ title, subtitle, right, back = true }: { title: string; subtitle?: string; right?: React.ReactNode; back?: boolean }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.isTV ? t.space.gutter : t.space.sm, paddingVertical: t.space.sm, gap: t.space.sm, minHeight: 52 }}>
      {back ? <BackButton /> : <View style={{ width: t.isTV ? 0 : t.space.sm }} />}
      <View style={{ flex: 1 }}>
        <T variant={t.isTV ? 'title' : 'heading'} numberOfLines={1}>
          {title}
        </T>
        {subtitle ? (
          <T variant="small" tone="muted" numberOfLines={1}>
            {subtitle}
          </T>
        ) : null}
      </View>
      {right}
    </View>
  );
}
