/**
 * Runtime ("dynamic") splash: the native splash is fixed at build time, so as
 * soon as the cached server branding is known we cover it with the server's own
 * splash colour + logo and fade into the app.
 */
import * as SplashScreen from 'expo-splash-screen';
import React, { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet } from 'react-native';
import { useSession } from '@/state/session';
import { isValidColor, useTheme } from '@/theme';
import { Img } from './Img';
import { T } from './Text';

export function BrandSplash() {
  const t = useTheme();
  const { status, branding } = useSession();
  const opacity = useRef(new Animated.Value(1)).current;
  const scale = useRef(new Animated.Value(0.92)).current;
  const [gone, setGone] = useState(false);
  const booting = status === 'booting';

  useEffect(() => {
    if (branding || !booting) SplashScreen.hideAsync().catch(() => undefined);
  }, [branding, booting]);

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(scale, { toValue: 1, duration: 900, useNativeDriver: true }),
        Animated.timing(scale, { toValue: 0.94, duration: 900, useNativeDriver: true }),
      ]),
    ).start();
  }, [scale]);

  useEffect(() => {
    if (booting) {
      setGone(false);
      opacity.setValue(1);
      return;
    }
    Animated.timing(opacity, { toValue: 0, duration: 450, delay: 150, useNativeDriver: true }).start(() => setGone(true));
  }, [booting, opacity]);

  if (gone) return null;
  const bg = isValidColor(branding?.splash?.backgroundColor) ? branding!.splash.backgroundColor : t.colors.background;
  const logo = branding?.splash?.logoUrl ?? branding?.logoUrl ?? null;
  return (
    <Animated.View pointerEvents={booting ? 'auto' : 'none'} style={[StyleSheet.absoluteFill, { backgroundColor: bg, alignItems: 'center', justifyContent: 'center', opacity }]}>
      <Animated.View style={{ transform: [{ scale }], alignItems: 'center', gap: t.space.lg }}>
        {logo ? (
          <Img path={logo} width={t.s(240)} contentFit="contain" style={{ width: t.isTV ? t.s(320) : 200, height: t.isTV ? t.s(160) : 100 }} transition={0} />
        ) : (
          <T variant="hero">{branding?.serverName ?? 'MediaMax'}</T>
        )}
        <ActivityIndicator color={t.colors.primary} />
      </Animated.View>
    </Animated.View>
  );
}
