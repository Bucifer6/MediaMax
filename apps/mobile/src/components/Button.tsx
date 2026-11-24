import { ActivityIndicator, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';
import { Focusable } from './Focusable';
import { Icon, type IconName } from './Icon';
import { T } from './Text';

export interface ButtonProps {
  label?: string;
  icon?: IconName;
  onPress?: () => void;
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  hasTVPreferredFocus?: boolean;
  onFocus?: () => void;
  /** Make the button stretch to its container width. */
  block?: boolean;
  accessibilityLabel?: string;
}

export function Button({ label, icon, onPress, variant = 'primary', size = 'md', loading, disabled, style, hasTVPreferredFocus, onFocus, block, accessibilityLabel }: ButtonProps) {
  const t = useTheme();
  const pad = { sm: [8, 14], md: [12, 20], lg: [16, 28] }[size].map((v) => (t.isTV ? t.s(v) : v));
  const bg = {
    primary: t.colors.primary,
    secondary: t.alpha(t.colors.text, t.dark ? 0.12 : 0.08),
    ghost: 'transparent',
    danger: t.colors.danger,
  }[variant];
  const fg = variant === 'primary' ? t.colors.primaryText : variant === 'danger' ? '#fff' : t.colors.text;
  const iconOnly = !label && !!icon;
  const radius = t.theme.posterShape === 'pill' ? 999 : t.radius;
  return (
    <Focusable
      onPress={disabled || loading ? undefined : onPress}
      hasTVPreferredFocus={hasTVPreferredFocus}
      onFocus={onFocus}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      focusScale={t.isTV ? 1.06 : 1}
      ringRadius={radius}
      containerStyle={[block ? { alignSelf: 'stretch' } : { alignSelf: 'flex-start' }, style]}
      style={{
        backgroundColor: bg,
        borderRadius: radius,
        paddingVertical: pad[0],
        paddingHorizontal: iconOnly ? pad[0] : pad[1],
        opacity: disabled ? 0.5 : 1,
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.space.sm,
        borderWidth: variant === 'ghost' ? 1 : 0,
        borderColor: t.colors.border,
      }}
    >
      {({ focused }) => (
        <>
          {loading ? (
            <ActivityIndicator color={fg} />
          ) : icon ? (
            <Icon name={icon} color={focused && variant !== 'primary' ? t.colors.primary : fg} size={size === 'sm' ? (t.isTV ? t.s(20) : 16) : undefined} />
          ) : null}
          {label ? (
            <T variant={size === 'sm' ? 'small' : 'body'} weight="700" color={fg}>
              {label}
            </T>
          ) : null}
          {!label && !icon && !loading ? <View /> : null}
        </>
      )}
    </Focusable>
  );
}
