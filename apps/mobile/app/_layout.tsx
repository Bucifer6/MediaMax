import { Stack, router, useRootNavigationState, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import React, { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { BrandSplash } from '@/components/BrandSplash';
import { DownloadsProvider } from '@/state/downloads';
import { MusicProvider } from '@/state/music';
import { SessionProvider, useSession } from '@/state/session';
import { ThemeProvider, resolveTheme, useTheme } from '@/theme';

SplashScreen.preventAutoHideAsync().catch(() => undefined);

export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <SessionProvider>
        <ThemedApp />
      </SessionProvider>
    </SafeAreaProvider>
  );
}

function ThemedApp() {
  const { branding, user } = useSession();
  const theme = useMemo(() => resolveTheme(branding, user?.preferences?.themeId), [branding, user?.preferences?.themeId]);
  return (
    <ThemeProvider theme={theme}>
      <DownloadsProvider>
        <MusicProvider>
          <Navigation />
        </MusicProvider>
      </DownloadsProvider>
    </ThemeProvider>
  );
}

/** Screens reachable without being signed in. */
const PUBLIC = new Set(['connect', 'login']);

function useAuthGuard() {
  const { status } = useSession();
  const segments = useSegments();
  const nav = useRootNavigationState();
  const first = segments[0] as string | undefined;

  useEffect(() => {
    if (!nav?.key || status === 'booting') return;
    const atRoot = !first || first === 'index';
    if (status === 'no-server') {
      if (first !== 'connect') router.replace('/connect');
    } else if (status === 'signed-out') {
      if (!first || !PUBLIC.has(first)) router.replace('/login');
    } else if (status === 'signed-in') {
      if (atRoot || first === 'login') router.replace('/(tabs)');
    } else if (status === 'offline') {
      if (atRoot || first === 'login') router.replace('/(tabs)/downloads');
    }
  }, [status, first, nav?.key]);
}

function Navigation() {
  const t = useTheme();
  useAuthGuard();

  useEffect(() => {
    SystemUI.setBackgroundColorAsync(t.colors.background).catch(() => undefined);
  }, [t.colors.background]);

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <StatusBar style={t.dark ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: t.colors.background },
          animation: t.isTV ? 'fade' : Platform.OS === 'android' ? 'fade_from_bottom' : 'default',
        }}
      >
        <Stack.Screen name="index" />
        <Stack.Screen name="connect" options={{ animation: 'fade' }} />
        <Stack.Screen name="login" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="player/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', orientation: t.isTV ? undefined : 'all' }} />
        <Stack.Screen name="live/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', orientation: t.isTV ? undefined : 'all' }} />
        <Stack.Screen name="music" options={{ presentation: t.isTV ? 'fullScreenModal' : 'modal', animation: t.isTV ? 'fade' : 'slide_from_bottom' }} />
        <Stack.Screen name="photo/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
      </Stack>
      <BrandSplash />
    </View>
  );
}
