import React from 'react';
import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export function Loading({ style, label }: { style?: StyleProp<ViewStyle>; label?: string }) {
  const t = useTheme();
  return (
    <View style={[{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.xl, gap: t.space.md }, style]}>
      <ActivityIndicator size="large" color={t.colors.primary} />
      {label ? <T tone="muted">{label}</T> : null}
    </View>
  );
}

export function EmptyState({ icon = 'albums-outline', title, message, action, onAction }: { icon?: IconName; title: string; message?: string; action?: string; onAction?: () => void }) {
  const t = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.xl, gap: t.space.md }}>
      <View style={{ width: t.s(84), height: t.s(84), borderRadius: t.s(42), backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
        <Icon name={icon} size={t.isTV ? t.s(40) : 36} color={t.colors.textMuted} />
      </View>
      <T variant="heading" center>
        {title}
      </T>
      {message ? (
        <T tone="muted" center style={{ maxWidth: t.s(420) }}>
          {message}
        </T>
      ) : null}
      {action && onAction ? <Button label={action} onPress={onAction} style={{ alignSelf: 'center' }} hasTVPreferredFocus /> : null}
    </View>
  );
}

export function ErrorState({ error, onRetry }: { error: Error | string; onRetry?: () => void }) {
  return <EmptyState icon="cloud-offline-outline" title="Something went wrong" message={typeof error === 'string' ? error : error.message} action={onRetry ? 'Try again' : undefined} onAction={onRetry} />;
}
