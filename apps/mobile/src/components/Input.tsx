import React, { useState } from 'react';
import { TextInput, View, type TextInputProps } from 'react-native';
import { useTheme } from '@/theme';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export type TextInputRef = React.ComponentRef<typeof TextInput>;

export function Input({ label, icon, style, onFocus, onBlur, ref, ...rest }: TextInputProps & { label?: string; icon?: IconName; ref?: React.Ref<TextInputRef> }) {
  const t = useTheme();
  const [focused, setFocused] = useState(false);
  return (
    <View style={{ gap: t.space.xs }}>
      {label ? (
        <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
          {label}
        </T>
      ) : null}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: t.space.sm,
          backgroundColor: t.alpha(t.colors.text, t.dark ? 0.08 : 0.05),
          borderRadius: t.radius,
          borderWidth: focused ? 2 : 1,
          borderColor: focused ? t.colors.primary : t.colors.border,
          paddingHorizontal: t.space.md,
        }}
      >
        {icon ? <Icon name={icon} color={t.colors.textMuted} size={t.isTV ? t.s(22) : 18} /> : null}
        <TextInput
          ref={ref}
          placeholderTextColor={t.colors.textMuted}
          selectionColor={t.colors.primary}
          onFocus={(e) => {
            setFocused(true);
            onFocus?.(e);
          }}
          onBlur={(e) => {
            setFocused(false);
            onBlur?.(e);
          }}
          style={[{ flex: 1, color: t.colors.text, fontSize: t.text.body, paddingVertical: t.isTV ? t.s(14) : 13, fontFamily: t.font }, style]}
          {...rest}
        />
      </View>
    </View>
  );
}
