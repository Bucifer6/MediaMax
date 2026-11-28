/**
 * "Who's watching?" — shown after signing in to an account that has profiles, and from Settings → Switch profile.
 * Large focusable tiles for the TV remote; PIN-protected profiles ask for their PIN. Same API as the web app.
 * The account owner can add profiles here and, with "Manage profiles", edit or delete them (app/profile-edit.tsx).
 */
import { router, useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '@/api/client';
import type { AccountProfile } from '@/api/types';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { PinPad } from '@/components/PinPad';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { useBackHandler } from '@/tv';

/** "Add profile": a tile like the others with a plus. */
function AddTile({ size, onPress }: { size: number; onPress: () => void }) {
  const t = useTheme();
  return (
    <Focusable onPress={onPress} ring={false} focusScale={t.isTV ? 1.12 : 1} style={{ alignItems: 'center', gap: t.space.sm, width: size + 24 }} accessibilityLabel="Add profile">
      {({ focused }) => (
        <>
          <View style={{ borderRadius: size * 0.3, borderWidth: t.s(4), borderColor: focused ? t.colors.primary : 'transparent', padding: 2 }}>
            <View style={{ width: size, height: size, borderRadius: size * 0.24, borderWidth: 2, borderStyle: 'dashed', borderColor: t.colors.border, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="add" size={size * 0.4} color={t.colors.textMuted} />
            </View>
          </View>
          <T weight={focused ? '800' : '600'} tone={focused ? 'default' : 'muted'} center>Add profile</T>
        </>
      )}
    </Focusable>
  );
}

function ProfileTile({ p, size, focusFirst, busy, editing, onPress }: { p: AccountProfile; size: number; focusFirst: boolean; busy: boolean; editing?: boolean; onPress: () => void }) {
  const t = useTheme();
  return (
    <Focusable onPress={onPress} hasTVPreferredFocus={focusFirst} ring={false} focusScale={t.isTV ? 1.12 : 1} style={{ alignItems: 'center', gap: t.space.sm, width: size + 24 }}
      accessibilityLabel={`${p.displayName}${p.isKids ? ', kids' : ''}${p.hasPin ? ', PIN protected' : ''}`}>
      {({ focused }) => (
        <>
          <View style={{ borderRadius: size * 0.3, borderWidth: t.s(4), borderColor: focused ? t.colors.primary : 'transparent', padding: 2 }}>
            <View style={{ width: size, height: size, borderRadius: size * 0.24, overflow: 'hidden', backgroundColor: p.color ?? t.colors.surface, alignItems: 'center', justifyContent: 'center' }}>
              {p.avatarUrl ? (
                <Img path={p.avatarUrl} width={size} style={{ width: '100%', height: '100%' }} />
              ) : (
                <T variant="title" color="#fff" style={{ fontSize: size * 0.42, lineHeight: size * 0.5 }}>{p.displayName.slice(0, 1).toUpperCase()}</T>
              )}
            </View>
            {busy ? (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                <ActivityIndicator color="#fff" />
              </View>
            ) : null}
            {editing ? (
              <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: size * 0.24 }}>
                <Icon name="pencil" size={size * 0.3} color="#fff" />
              </View>
            ) : null}
            {p.hasPin && !p.current ? (
              <View style={{ position: 'absolute', top: 4, right: 4, backgroundColor: t.colors.surface, borderRadius: 999, padding: 4 }}>
                <Icon name="lock-closed" size={t.isTV ? t.s(16) : 12} color={t.colors.textMuted} />
              </View>
            ) : null}
            {p.isKids ? (
              <View style={{ position: 'absolute', bottom: -6, alignSelf: 'center', backgroundColor: '#ffd166', borderRadius: 999, paddingHorizontal: 10, paddingVertical: 2 }}>
                <T variant="caption" color="#1b1b2f" weight="800">KIDS</T>
              </View>
            ) : null}
          </View>
          <T weight={focused || p.current ? '800' : '600'} tone={focused ? 'default' : 'muted'} numberOfLines={1} center>
            {p.displayName}
          </T>
        </>
      )}
    </Focusable>
  );
}

export default function ProfilesScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { api, user, completeProfilePick, signOut } = useSession();
  const [list, setList] = useState<AccountProfile[] | null>(null);
  const [pinFor, setPinFor] = useState<AccountProfile | null>(null);
  const [pin, setPin] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const [canAdd, setCanAdd] = useState(false);

  // Reloaded whenever the screen shows again (after adding or editing a profile).
  useFocusEffect(
    useCallback(() => {
      if (!api) return;
      api.accountProfiles().then(setList).catch((e) => setError(e instanceof Error ? e.message : 'Could not load profiles'));
    }, [api]),
  );
  // Only the account owner manages profiles, while the server allows them and there is room for another.
  const isOwner = !!list?.find((p) => p.current)?.isOwner;
  useEffect(() => {
    if (!api || !isOwner) return setCanAdd(false);
    api.profileSettings().then((s) => setCanAdd(s.enabled && (list?.length ?? 0) < s.maxPerAccount)).catch(() => setCanAdd(false));
  }, [api, isOwner, list?.length]);

  useBackHandler(() => {
    if (managing) {
      setManaging(false);
      return true;
    }
    if (pinFor) {
      setPinFor(null);
      setPin('');
      setError(null);
      return true;
    }
    // Opened from Settings (already in a profile): Back returns to the app instead of closing it.
    if (list?.some((p) => p.current)) {
      void completeProfilePick();
      return true;
    }
    return false;
  });

  const enter = async (p: AccountProfile, pinValue?: string) => {
    if (!api) return;
    setError(null);
    if (p.current) return completeProfilePick();
    if (p.hasPin && !pinValue) {
      setPin('');
      return setPinFor(p);
    }
    setBusyId(p.id);
    try {
      const auth = await api.switchProfile(p.id, pinValue);
      setPinFor(null);
      await completeProfilePick(auth);
    } catch (e) {
      setPin('');
      if (e instanceof ApiError && e.code === 'pin_required') setPinFor(p);
      else setError(e instanceof ApiError ? (e.status === 401 ? 'Incorrect PIN' : e.message) : 'Could not switch profile');
    } finally {
      setBusyId(null);
    }
  };

  const size = t.isTV ? t.s(170) : t.wide ? 128 : 104;
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.colors.background }} contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', padding: t.space.lg, paddingTop: insets.top + t.space.lg, paddingBottom: insets.bottom + t.space.lg, gap: t.space.lg }}>
      {!list && !error ? (
        <ActivityIndicator color={t.colors.primary} size="large" />
      ) : pinFor ? (
        <View style={{ alignItems: 'center', gap: t.space.lg }}>
          <T variant="heading" center>{pinFor.isOwner && user?.isKids ? `Enter ${pinFor.displayName}'s PIN to leave the kids profile` : `Enter the PIN for ${pinFor.displayName}`}</T>
          <PinPad value={pin} onChange={setPin} length={pinFor.pinLength ?? 4} onComplete={(v) => void enter(pinFor, v)} error={!!error} />
          {busyId ? <ActivityIndicator color={t.colors.primary} /> : null}
          <Button label="Back" variant="ghost" icon="arrow-back" onPress={() => { setPinFor(null); setPin(''); setError(null); }} />
        </View>
      ) : (
        <>
          <T variant="title" center>{managing ? 'Manage profiles' : "Who's watching?"}</T>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.isTV ? t.s(40) : 18, maxWidth: t.isTV ? t.s(1400) : 640 }}>
            {(list ?? []).map((p, i) => (
              <ProfileTile
                key={p.id}
                p={p}
                size={size}
                focusFirst={list!.some((x) => x.current) ? p.current : i === 0}
                busy={busyId === p.id}
                editing={managing && !p.isOwner}
                onPress={() => (managing ? (p.isOwner ? undefined : router.push(`/profile-edit?id=${encodeURIComponent(p.id)}` as never)) : void enter(p))}
              />
            ))}
            {canAdd && !managing ? <AddTile size={size} onPress={() => router.push('/profile-edit' as never)} /> : null}
          </View>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, justifyContent: 'center' }}>
            {isOwner && (list?.length ?? 0) > 1 ? (
              <Button label={managing ? 'Done' : 'Manage profiles'} variant="secondary" icon={managing ? 'checkmark' : 'pencil'} onPress={() => setManaging((m) => !m)} />
            ) : null}
            <Button label="Sign out" variant="ghost" icon="log-out-outline" onPress={() => void signOut()} />
          </View>
        </>
      )}
      {error ? <T tone="danger" center>{error}</T> : null}
    </ScrollView>
  );
}
