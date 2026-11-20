import React from 'react';
import { Text as RNText, type TextProps, type TextStyle } from 'react-native';
import { useTheme } from '@/theme';

type Variant = 'hero' | 'title' | 'heading' | 'body' | 'small' | 'caption';
type Tone = 'default' | 'muted' | 'primary' | 'accent' | 'danger' | 'success' | 'onPrimary' | 'warning';

export interface TProps extends TextProps {
  variant?: Variant;
  tone?: Tone;
  weight?: TextStyle['fontWeight'];
  center?: boolean;
  color?: string;
}

const WEIGHTS: Record<Variant, TextStyle['fontWeight']> = {
  hero: '800',
  title: '800',
  heading: '700',
  body: '400',
  small: '500',
  caption: '600',
};

export function T({ variant = 'body', tone = 'default', weight, center, color, style, ...rest }: TProps) {
  const t = useTheme();
  const toneColor = {
    default: t.colors.text,
    muted: t.colors.textMuted,
    primary: t.colors.primary,
    accent: t.colors.accent,
    danger: t.colors.danger,
    success: t.colors.success,
    warning: t.colors.warning,
    onPrimary: t.colors.primaryText,
  }[tone];
  const size = t.text[variant];
  return (
    <RNText
      {...rest}
      style={[
        {
          color: color ?? toneColor,
          fontSize: size,
          lineHeight: Math.round(size * (variant === 'hero' || variant === 'title' ? 1.15 : 1.4)),
          fontWeight: weight ?? WEIGHTS[variant],
          fontFamily: t.font,
          letterSpacing: variant === 'caption' ? 0.6 : variant === 'hero' ? -0.5 : 0,
          textAlign: center ? 'center' : undefined,
        },
        style,
      ]}
    />
  );
}
