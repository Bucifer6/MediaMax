import { Tabs } from 'expo-router';
import React from 'react';
import { View } from 'react-native';
import { MiniPlayer } from '@/components/MiniPlayer';
import { TabBar } from '@/components/TabBar';
import { useTheme } from '@/theme';

export default function TabsLayout() {
  const t = useTheme();
  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        screenOptions={{
          headerShown: false,
          tabBarPosition: t.isTV ? 'top' : 'bottom',
          sceneStyle: { backgroundColor: t.colors.background },
          animation: 'fade',
        }}
      >
        <Tabs.Screen name="index" />
        <Tabs.Screen name="libraries" />
        <Tabs.Screen name="live" />
        <Tabs.Screen name="search" />
        <Tabs.Screen name="downloads" />
        <Tabs.Screen name="settings" />
      </Tabs>
      {t.isTV ? (
        <View style={{ position: 'absolute', right: t.space.gutter, bottom: t.space.lg }}>
          <MiniPlayer />
        </View>
      ) : null}
    </View>
  );
}
