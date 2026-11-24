import { Stack, router, useCanGoBack, useRootNavigationState, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as SystemUI from 'expo-system-ui';
import { useEffect, useMemo } from 'react';
import { Platform, View } from 'react-native';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { CarBridge } from '@/car/CarBridge';
import { CastProvider } from '@/cast';
import { BrandSplash } from '@/components/BrandSplash';
import { MiniPlayer } from '@/components/MiniPlayer';
import { T } from '@/components/Text';
import { DjProvider } from '@/state/dj';
import { DownloadsProvider } from '@/state/downloads';
import { MusicProvider } from '@/state/music';
import { RemoteProvider, useRemote } from '@/state/remote';
import { SessionProvider, useSession } from '@/state/session';
import { SyncPlayProvider } from '@/state/syncplay';
import { ThemeProvider, resolveTheme, useTheme } from '@/theme';
import { useTVMenuKeyManager } from '@/tv';

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
      <CastProvider>
        <DownloadsProvider>
          <MusicProvider>
            {/* DJ mode: two-deck automatic mixes (phone / TV; CarPlay and Android Auto stay on MusicProvider) */}
            <DjProvider>
              {/* CarPlay / Android Auto (renders nothing; absent in Expo Go and TV builds) */}
              <CarBridge />
              {/* Remote control ("Play on…"): reports player state, applies commands from your other devices */}
              <RemoteProvider>
                <SyncPlayProvider>
                  <Navigation />
                </SyncPlayProvider>
              </RemoteProvider>
            </DjProvider>
          </MusicProvider>
        </DownloadsProvider>
      </CastProvider>
    </ThemeProvider>
  );
}

/** Screens reachable without being signed in. */
const PUBLIC = new Set(['connect', 'login']);

function useAuthGuard() {
  const { status, needsProfilePick } = useSession();
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
      if (needsProfilePick) {
        if (first !== 'profiles') router.replace('/profiles');
      } else if (atRoot || first === 'login' || first === 'profiles') router.replace('/(tabs)');
    } else if (status === 'offline') {
      if (atRoot || first === 'login') router.replace('/(tabs)/downloads');
    }
  }, [status, first, nav?.key, needsProfilePick]);
}

function Navigation() {
  const t = useTheme();
  useAuthGuard();
  useTVMenuKeyManager(useCanGoBack());

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
        <Stack.Screen name="profiles" options={{ animation: 'fade' }} />
        <Stack.Screen name="(tabs)" options={{ animation: 'fade' }} />
        <Stack.Screen name="player/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', orientation: t.isTV ? undefined : 'all' }} />
        <Stack.Screen name="live/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade', orientation: t.isTV ? undefined : 'all' }} />
        <Stack.Screen name="music" options={{ presentation: t.isTV ? 'fullScreenModal' : 'modal', animation: t.isTV ? 'fade' : 'slide_from_bottom' }} />
        <Stack.Screen name="photo/[id]" options={{ presentation: 'fullScreenModal', animation: 'fade' }} />
        <Stack.Screen name="settings/wrapped" options={{ presentation: 'fullScreenModal', animation: 'fade', orientation: t.isTV ? undefined : 'all' }} />
      </Stack>
      <FloatingMiniPlayer />
      <RemoteNotice />
      <BrandSplash />
    </View>
  );
}

const ACTION_TEXT: Record<string, string> = {
  play: 'Play',
  pause: 'Pause',
  togglePause: 'Play / pause',
  stop: 'Stop',
  seek: 'Seek',
  next: 'Next',
  previous: 'Previous',
  setVolume: 'Volume',
  playItem: 'Playing',
  playChannel: 'Playing channel',
};

/** Brief notice when another of your devices sends a command (the video player shows its own). */
function RemoteNotice() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { lastCommand } = useRemote();
  const segments = useSegments() as string[];
  const inVideo = segments[0] === 'player' || (segments[0] === 'live' && segments[1] === '[id]');
  if (!lastCommand || inVideo) return null;
  return (
    <View pointerEvents="none" style={{ position: 'absolute', top: t.isTV ? t.space.lg : insets.top + 8, alignSelf: 'center', backgroundColor: t.alpha(t.colors.surface, 0.95), borderColor: t.colors.border, borderWidth: 1, paddingHorizontal: t.space.lg, paddingVertical: t.space.sm, borderRadius: 999 }}>
      <T variant="small" weight="700">
        {ACTION_TEXT[lastCommand.action] ?? lastCommand.action} · from {lastCommand.from}
      </T>
    </View>
  );
}

/** Mini player on stack screens outside the tabs (the tab bar hosts its own). */
function FloatingMiniPlayer() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const segments = useSegments() as string[];
  const first = segments[0];
  const hidden =
    !first ||
    first === '(tabs)' ||
    first === 'index' ||
    PUBLIC.has(first) ||
    first === 'player' ||
    first === 'music' ||
    first === 'dj' ||
    first === 'photo' ||
    (first === 'settings' && segments[1] === 'wrapped') ||
    (first === 'live' && segments[1] === '[id]');
  if (hidden) return null;
  return (
    <View pointerEvents="box-none" style={{ position: 'absolute', left: 0, right: 0, bottom: t.isTV ? t.space.lg : insets.bottom + 4, alignItems: t.isTV ? 'flex-end' : 'stretch', paddingRight: t.isTV ? t.space.gutter : 0 }}>
      <MiniPlayer />
    </View>
  );
}
