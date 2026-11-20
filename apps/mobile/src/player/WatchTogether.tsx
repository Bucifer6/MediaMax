/** Watch-together UI: room code + members, or start / join a room. */
import React, { useState } from 'react';
import { View } from 'react-native';
import type { SyncPlayRoom } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { Sheet } from '@/components/Sheet';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useSyncPlay } from '@/state/syncplay';
import { useTheme } from '@/theme';

export function RoomCode({ code }: { code: string }) {
  const t = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: t.space.xs, paddingVertical: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.primary, 0.12) }}>
      <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
        Room code
      </T>
      <T weight="900" tone="primary" selectable style={{ fontSize: t.isTV ? t.s(64) : 48, lineHeight: t.isTV ? t.s(76) : 58, letterSpacing: t.isTV ? t.s(14) : 10 }}>
        {code}
      </T>
      <T variant="small" tone="muted" center>
        Friends enter this code under “Watch together” or “Join watch party”.
      </T>
    </View>
  );
}

export function MemberList({ room }: { room: SyncPlayRoom }) {
  const t = useTheme();
  const { user } = useSession();
  return (
    <View style={{ gap: t.space.xs }}>
      <T variant="caption" tone="muted" style={{ textTransform: 'uppercase' }}>
        {room.members.length} watching
      </T>
      {room.members.map((m) => (
        <View key={m.userId} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: 4 }}>
          <View style={{ width: t.s(30), height: t.s(30), borderRadius: t.s(15), backgroundColor: t.colors.primary, alignItems: 'center', justifyContent: 'center' }}>
            <T variant="small" weight="800" color={t.colors.primaryText}>
              {m.displayName.slice(0, 1).toUpperCase()}
            </T>
          </View>
          <T weight="600" style={{ flex: 1 }} numberOfLines={1}>
            {m.displayName}
            {m.userId === user?.id ? ' (you)' : ''}
          </T>
          {m.userId === room.ownerId ? (
            <View style={{ paddingHorizontal: 8, paddingVertical: 2, borderRadius: 999, backgroundColor: t.alpha(t.colors.accent, 0.2) }}>
              <T variant="caption" tone="accent">
                Host
              </T>
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}

/** Code entry + join button (also used by the "Join watch party" screen). */
export function JoinForm({ autoFocus, preferredFocus }: { autoFocus?: boolean; preferredFocus?: boolean }) {
  const t = useTheme();
  const sync = useSyncPlay();
  const [code, setCode] = useState('');
  const submit = () => code.trim().length >= 4 && sync.join(code);
  return (
    <View style={{ gap: t.space.sm }}>
      <Input
        label="Join with a code"
        value={code}
        onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 36))}
        placeholder="ABCDE"
        autoCapitalize="characters"
        autoCorrect={false}
        autoFocus={autoFocus}
        returnKeyType="go"
        onSubmitEditing={submit}
        style={{ fontSize: t.isTV ? t.s(30) : 26, letterSpacing: 6, textAlign: 'center', fontWeight: '800' }}
      />
      <Button label="Join" icon="enter-outline" onPress={submit} loading={sync.pending === 'join'} disabled={code.trim().length < 4 || !!sync.pending} block hasTVPreferredFocus={preferredFocus} />
    </View>
  );
}

export function SyncError() {
  const t = useTheme();
  const { error } = useSyncPlay();
  if (!error) return null;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
      <Icon name="alert-circle" color={t.colors.danger} size={t.isTV ? t.s(22) : 18} />
      <T tone="danger" weight="600" style={{ flex: 1 }}>
        {error}
      </T>
    </View>
  );
}

export function WatchTogetherSheet({ visible, itemId, onClose }: { visible: boolean; itemId: string; onClose: () => void }) {
  const t = useTheme();
  const sync = useSyncPlay();
  const room = sync.room;
  return (
    <Sheet visible={visible} title="Watch together" subtitle={room ? 'Play, pause and seek stay in sync for everyone' : 'Watch in sync with friends on other devices'} onClose={onClose}>
      {room ? (
        <>
          <RoomCode code={room.code} />
          <MemberList room={room} />
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            <Button label="Done" onPress={onClose} hasTVPreferredFocus />
            <Button
              label="Leave room"
              icon="exit-outline"
              variant="secondary"
              onPress={() => {
                sync.leave();
                onClose();
              }}
            />
          </View>
        </>
      ) : (
        <>
          <Button label="Start a room" icon="people" size="lg" block loading={sync.pending === 'create'} disabled={!!sync.pending} onPress={() => sync.create(itemId)} hasTVPreferredFocus />
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <View style={{ flex: 1, height: 1, backgroundColor: t.colors.border }} />
            <T variant="small" tone="muted">
              or
            </T>
            <View style={{ flex: 1, height: 1, backgroundColor: t.colors.border }} />
          </View>
          <JoinForm />
        </>
      )}
      <SyncError />
    </Sheet>
  );
}
