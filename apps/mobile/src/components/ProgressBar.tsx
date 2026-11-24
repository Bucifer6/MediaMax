import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, View, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from '@/theme';

export function ProgressBar({
  value,
  height,
  style,
  color,
  track,
  indeterminate,
}: {
  value: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  color?: string;
  track?: string;
  /** Unknown total: show a sliding segment instead of a fill. */
  indeterminate?: boolean;
}) {
  const t = useTheme();
  const h = height ?? (t.isTV ? t.s(5) : 3);
  const [w, setW] = useState(0);
  const anim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (!indeterminate) return;
    const loop = Animated.loop(Animated.timing(anim, { toValue: 1, duration: 1200, easing: Easing.inOut(Easing.ease), useNativeDriver: true }));
    anim.setValue(0);
    loop.start();
    return () => loop.stop();
  }, [indeterminate, anim]);
  return (
    <View onLayout={indeterminate ? (e) => setW(e.nativeEvent.layout.width) : undefined} style={[{ height: h, borderRadius: h, backgroundColor: track ?? t.alpha('#ffffff', 0.25), overflow: 'hidden' }, style]}>
      {indeterminate ? (
        <Animated.View style={{ width: '35%', height: '100%', backgroundColor: color ?? t.colors.primary, borderRadius: h, transform: [{ translateX: anim.interpolate({ inputRange: [0, 1], outputRange: [-w * 0.35, w] }) }] }} />
      ) : (
        <View style={{ width: `${Math.max(0, Math.min(1, value)) * 100}%`, height: '100%', backgroundColor: color ?? t.colors.primary, borderRadius: h }} />
      )}
    </View>
  );
}
