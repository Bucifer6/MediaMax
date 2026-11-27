/**
 * The building block for anything interactive. On TV it gets a spring scale
 * and a glowing primary-coloured ring when focused by the remote; on phones it
 * gives a soft press-in.
 */
import React, { useCallback, useRef, useState } from 'react';
import { Animated, Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';
import { usePreferredFocus } from '@/tv/focusGate';

/** The view behind a Focusable; on TV builds it also has `requestTVFocus()`. */
export type FocusableRef = React.ComponentRef<typeof Pressable> & { requestTVFocus?: () => void };

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
  /** The underlying view (e.g. to call `requestTVFocus()`). */
  ref?: React.Ref<FocusableRef>;
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
  hasTVPreferredFocus,
  ...rest
}: FocusableProps) {
  const t = useTheme();
  const preferred = usePreferredFocus(hasTVPreferredFocus);
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
        hasTVPreferredFocus={preferred}
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
          // The ring's border is always there (transparent until focused) so moving focus never
          // changes layout. No elevation/shadow: on Fire TV / Android TV GPUs re-rasterising a
          // shadow on every focus move costs frames, and the border + scale already show focus.
          ring && t.isTV
            ? {
                borderColor: focused ? t.colors.primary : 'transparent',
                borderWidth: t.s(3),
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
