import React from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDay, formatTime } from '@/utils/format';

const ICONS = { ios: 'phone-portrait-outline', android: 'phone-portrait-outline', tvos: 'tv-outline', androidtv: 'tv-outline', roku: 'tv-outline', web: 'desktop-outline', other: 'hardware-chip-outline' } as const;

export default function DevicesScreen() {
  const t = useTheme();
  const api = useApi();
  const q = useQuery('devices', (a) => a.devices(), { staleMs: 0 });
  const revoke = (id: string, name: string) => {
    const go = async () => {
      q.setData((prev) => prev?.filter((d) => d.id !== id));
      await api.revokeDevice(id).catch(() => q.refresh());
    };
    if (t.isTV) return void go();
    Alert.alert('Sign out device?', name, [{ text: 'Cancel', style: 'cancel' }, { text: 'Sign out', style: 'destructive', onPress: go }]);
  };
  return (
    <Screen>
      <ScreenHeader title="Signed-in devices" />
      {q.loading && !q.data ? <Loading /> : q.error && !q.data ? <ErrorState error={q.error} onRetry={q.refresh} /> : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, gap: t.space.sm, paddingBottom: t.space.xxl }}>
          {q.data?.map((d, i) => (
            <View key={d.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
              <Icon name={ICONS[d.platform] ?? 'hardware-chip-outline'} color={t.colors.primary} />
              <View style={{ flex: 1 }}>
                <T weight="700">{d.deviceName}{d.current ? ' (this device)' : ''}</T>
                <T variant="small" tone="muted">{d.platform} · {d.appVersion ?? ''} · last seen {formatDay(d.lastSeenAt)} {formatTime(d.lastSeenAt)}</T>
              </View>
              {!d.current ? <Button icon="log-out-outline" variant="secondary" size="sm" onPress={() => revoke(d.id, d.deviceName)} accessibilityLabel="Sign out device" hasTVPreferredFocus={i === 0} /> : null}
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
