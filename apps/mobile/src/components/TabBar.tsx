import { BlurView } from 'expo-blur';
import type { Tabs } from 'expo-router';
import React, { useEffect, useRef, useState } from 'react';
import { Platform, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatTime } from '@/utils/format';
import { setTabBarFocused } from '@/tv/focusGate';
import { Focusable, type FocusableRef } from './Focusable';
import { Icon, type IconName } from './Icon';
import { BrandWordmark } from './BrandWordmark';
import { NotificationBell } from './NotificationBell';
import { Img } from './Img';
import { MiniPlayer } from './MiniPlayer';
import { T } from './Text';

type BottomTabBarProps = Parameters<NonNullable<React.ComponentProps<typeof Tabs>['tabBar']>>[0];

export const TAB_META: Record<string, { label: string; icon: IconName; iconActive: IconName }> = {
  index: { label: 'Home', icon: 'home-outline', iconActive: 'home' },
  libraries: { label: 'Library', icon: 'albums-outline', iconActive: 'albums' },
  live: { label: 'Live TV', icon: 'tv-outline', iconActive: 'tv' },
  search: { label: 'Search', icon: 'search-outline', iconActive: 'search' },
  discover: { label: 'Discover', icon: 'compass-outline', iconActive: 'compass' },
  downloads: { label: 'Downloads', icon: 'download-outline', iconActive: 'download' },
  settings: { label: 'Settings', icon: 'settings-outline', iconActive: 'settings' },
};

export function useVisibleTabs() {
  const caps = useCapabilities();
  return (name: string) => {
    if (caps.offline) return name === 'downloads' || name === 'settings';
    if (name === 'live') return caps.liveTv;
    if (name === 'discover') return caps.requests;
    // Keep the phone bar to five tabs: while online, Downloads lives under Settings → Downloads
    // (it becomes a tab again in offline mode, when it's the main thing you can use).
    if (name === 'downloads') return false;
    // Search is reachable from Home's header; when Discover is on, drop the tab on phones to stay at five.
    if (name === 'search' && caps.requests && !Platform.isTV) return false;
    return name in TAB_META;
  };
}

function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15000);
    return () => clearInterval(timer);
  }, []);
  return <T variant="heading" tone="muted">{formatTime(now)}</T>;
}

export function TabBar({ state, emitter, navigateToTab }: BottomTabBarProps) {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const visible = useVisibleTabs();
  const { branding, user } = useSession();
  const routes = state.routes.filter((r) => visible(r.name));
  const itemRefs = useRef<Record<string, FocusableRef | null>>({});
  const lastSwitch = useRef(0);
  const go = (key: string, focused: boolean) => {
    const event = emitter.emit({ type: 'tabPress', target: key, canPreventDefault: true });
    if (!focused && !event.defaultPrevented) navigateToTab(key);
  };

  if (t.isTV) {
    const logo = branding?.logoWideUrl ?? branding?.logoUrl;
    return (
      <View style={{ flexDirection: 'row', alignItems: 'center', paddingHorizontal: t.space.gutter, paddingTop: t.s(24), paddingBottom: t.s(8), gap: t.space.lg, backgroundColor: 'transparent' }}>
        {logo ? <Img path={logo} width={t.s(160)} contentFit="contain" style={{ width: t.s(150), height: t.s(40) }} /> : <BrandWordmark name={branding?.serverName} width={t.s(150)} textVariant="heading" />}
        <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'center', gap: t.s(8) }}>
          {routes.map((route) => {
            const focused = state.routes[state.index]?.key === route.key;
            const meta = TAB_META[route.name];
            return (
              <Focusable
                key={route.key}
                ref={(v: FocusableRef | null) => {
                  itemRefs.current[route.key] = v;
                }}
                onPress={() => {
                  lastSwitch.current = Date.now();
                  go(route.key, focused);
                }}
                // Tabs open on OK (not on resting focus: passing over them loaded each screen and felt janky).
                // A screen that just opened can make Android drop focus onto another tab (often Home); right
                // after a switch, focus landing on a tab that isn't the open one goes back to the open one.
                onFocus={() => {
                  setTabBarFocused(true);
                  if (!focused && Date.now() - lastSwitch.current < 1200) {
                    const active = state.routes[state.index]?.key;
                    (active ? itemRefs.current[active] : null)?.requestTVFocus?.();
                  }
                }}
                onBlur={() => setTabBarFocused(false)}
                ringRadius={999}
                focusScale={1.06}
                style={{ paddingHorizontal: t.s(20), paddingVertical: t.s(10), borderRadius: 999, backgroundColor: focused ? t.alpha(t.colors.text, 0.14) : 'transparent', flexDirection: 'row', alignItems: 'center', gap: t.s(8) }}
              >
                {route.name === 'search' ? <Icon name="search" size={t.s(22)} color={focused ? t.colors.text : t.colors.textMuted} /> : null}
                {route.name !== 'search' ? (
                  <T variant="body" weight={focused ? '800' : '600'} tone={focused ? 'default' : 'muted'}>
                    {meta.label}
                  </T>
                ) : null}
              </Focusable>
            );
          })}
        </View>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md }}>
          <NotificationBell />
          <Clock />
          {user?.avatarUrl ? <Img path={user.avatarUrl} width={t.s(40)} style={{ width: t.s(40), height: t.s(40), borderRadius: t.s(20) }} /> : null}
        </View>
      </View>
    );
  }

  const bar = (
    <View style={{ flexDirection: 'row', paddingBottom: Math.max(insets.bottom, 8), paddingTop: 8, paddingHorizontal: t.space.sm }}>
      {routes.map((route) => {
        const focused = state.routes[state.index]?.key === route.key;
        const meta = TAB_META[route.name];
        return (
          <Focusable
            key={route.key}
            onPress={() => go(route.key, focused)}
            containerStyle={{ flex: 1 }}
            accessibilityRole="tab"
            accessibilityState={{ selected: focused }}
            accessibilityLabel={meta.label}
            style={{ alignItems: 'center', gap: 3, paddingVertical: 2 }}
          >
            <Icon name={focused ? meta.iconActive : meta.icon} size={24} color={focused ? t.colors.primary : t.colors.textMuted} />
            <T variant="caption" weight="700" color={focused ? t.colors.primary : t.colors.textMuted} style={{ letterSpacing: 0 }}>
              {meta.label}
            </T>
          </Focusable>
        );
      })}
    </View>
  );

  return (
    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
      <MiniPlayer />
      <View style={{ borderTopWidth: 0.5, borderTopColor: t.colors.border, overflow: 'hidden' }}>
        {Platform.OS === 'ios' ? (
          <BlurView intensity={80} tint={t.dark ? 'dark' : 'light'} style={{ backgroundColor: t.alpha(t.colors.background, 0.55) }}>
            {bar}
          </BlurView>
        ) : (
          <View style={{ backgroundColor: t.alpha(t.colors.surface, 0.97) }}>{bar}</View>
        )}
      </View>
    </View>
  );
}

/** Bottom padding phone screens need so content clears the floating tab bar + mini player. */
export function useTabBarSpace() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  if (t.isTV) return t.space.xl;
  return 64 + Math.max(insets.bottom, 8) + 72;
}
