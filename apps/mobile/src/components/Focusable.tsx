/**
 * The building block for anything interactive. On TV it gets a spring scale
 * and a glowing primary-coloured ring when focused by the remote; on phones it
 * gives a soft press-in.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

export interface FocusableProps extends Omit<PressableProps, 'children' | 'style'> {
  style?: StyleProp<ViewStyle>;
  /** Style applied to the animated wrapper (margins/position live here). */
  containerStyle?: StyleProp<ViewStyle>;
  children: React.ReactNode | ((state: { focused: boolean; pressed: boolean }) => React.ReactNode);
  /** Scale when focused on TV. */
  focusScale?: number;
  /** Draw the focus ring (default true on TV). */
  ring?: boolean;
  ringRadius?: number;
  hasTVPreferredFocus?: boolean;
}

export function Focusable({
  style,
  containerStyle,
  children,
  focusScale,
  ring = true,
  ringRadius,
  onFocus,
  onBlur,
  onPressIn,
  onPressOut,
  ...rest
}: FocusableProps) {
  const t = useTheme();
  const scale = useRef(new Animated.Value(1)).current;
  const [focused, setFocused] = useState(false);
  const [pressed, setPressed] = useState(false);
  const target = focusScale ?? (t.isTV ? 1.08 : 1);

  const animate = useCallback(
    (to: number) => {
      Animated.spring(scale, { toValue: to, useNativeDriver: true, friction: 7, tension: 90 }).start();
    },
    [scale],
  );

  return (
    <Animated.View style={[containerStyle, { transform: [{ scale }] }, focused && t.isTV ? { zIndex: 10 } : null]}>
      <Pressable
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          animate(target);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          animate(1);
          onBlur?.(e);
        }}
        onPressIn={(e) => {
          setPressed(true);
          if (!t.isTV) animate(0.97);
          onPressIn?.(e);
        }}
        onPressOut={(e) => {
          setPressed(false);
          if (!t.isTV) animate(1);
          onPressOut?.(e);
        }}
        style={[
          style,
          focused && ring && t.isTV
            ? {
                borderColor: t.colors.primary,
                borderWidth: t.s(3),
                shadowColor: t.colors.primary,
                shadowOpacity: 0.7,
                shadowRadius: t.s(18),
                shadowOffset: { width: 0, height: 0 },
                elevation: 12,
                borderRadius: ringRadius ?? t.radius,
              }
            : null,
          pressed && !t.isTV ? { opacity: 0.85 } : null,
        ]}
      >
        {typeof children === 'function' ? children({ focused, pressed }) : children}
      </Pressable>
    </Animated.View>
  );
}
