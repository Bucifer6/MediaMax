/**
 * "Join watch party": join a SyncPlay room by code without a video open. The
 * room's current item opens in the player as soon as it is known (on join, or
 * when the host sends `load`); the SyncPlay provider does the navigation.
 */
import React, { useEffect } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState } from '@/components/States';
import { T } from '@/components/Text';
import { JoinForm, MemberList, RoomCode, SyncError } from '@/player/WatchTogether';
import { useSyncPlay } from '@/state/syncplay';
import { useTheme } from '@/theme';

export default function WatchPartyScreen() {
  const t = useTheme();
  const sync = useSyncPlay();
  const { hold } = sync;
  // Keep the room while this screen waits for the host.
  useEffect(() => hold(), [hold]);

  if (!sync.enabled) return <Screen><ScreenHeader title="Join watch party" /><EmptyState icon="people-outline" title="Watch together is off" message="Your server has watch-together turned off." /></Screen>;

  return (
    <Screen>
      <ScreenHeader title="Join watch party" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: t.space.gutter, gap: t.space.lg, alignItems: 'center' }}>
        <View style={{ width: '100%', maxWidth: t.isTV ? t.s(620) : 480, gap: t.space.lg }}>
          {sync.room ? (
            <>
              <RoomCode code={sync.room.code} />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, justifyContent: 'center' }}>
                <ActivityIndicator color={t.colors.primary} />
                <T tone="muted">{sync.room.itemId ? 'Opening…' : 'Waiting for the host to start something…'}</T>
              </View>
              <MemberList room={sync.room} />
              <Button label="Leave" icon="exit-outline" variant="secondary" onPress={sync.leave} hasTVPreferredFocus style={{ alignSelf: 'center' }} />
            </>
          ) : (
            <>
              <View style={{ alignItems: 'center', gap: t.space.sm }}>
                <View style={{ width: t.s(84), height: t.s(84), borderRadius: t.s(42), backgroundColor: t.alpha(t.colors.primary, 0.15), alignItems: 'center', justifyContent: 'center' }}>
                  <Icon name="people" size={t.isTV ? t.s(40) : 38} color={t.colors.primary} />
                </View>
                <T variant="title" center>
                  Watch together
                </T>
                <T tone="muted" center>
                  Enter the 5-letter code from a friend’s player. Their video opens here and stays in sync.
                </T>
              </View>
              <JoinForm autoFocus={!t.isTV} preferredFocus />
            </>
          )}
          <SyncError />
        </View>
      </ScrollView>
    </Screen>
  );
}
