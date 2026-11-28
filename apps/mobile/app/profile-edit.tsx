/**
 * Add or edit a profile of this account (the account owner only; same API as the web app's Profiles page):
 * name, avatar, kids profile and an optional 4-digit PIN. `?id=` edits that profile, without it a new one is made.
 * Libraries, ratings and request rights stay on the web page; the server applies sensible kids defaults.
 */
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, View } from 'react-native';
import type { BuiltinAvatar, Profile } from '@/api/types';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { PinPad } from '@/components/PinPad';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow } from '@/components/SettingRow';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { useBackHandler } from '@/tv';

export default function ProfileEditScreen() {
  const t = useTheme();
  const api = useApi();
  const { id } = useLocalSearchParams<{ id?: string }>();
  const [existing, setExisting] = useState<Profile | null>(null);
  const [avatars, setAvatars] = useState<BuiltinAvatar[]>([]);
  const [name, setName] = useState('');
  const [avatarId, setAvatarId] = useState<string | null>(null);
  const [kids, setKids] = useState(false);
  // PIN: unchanged (null), being entered ('' / digits), or removed.
  const [pinMode, setPinMode] = useState<'keep' | 'set' | 'remove'>('keep');
  const [pin, setPin] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    void api.avatars().then(setAvatars).catch(() => undefined);
    if (!id) return;
    api
      .manageableProfiles()
      .then((list) => {
        const p = list.find((x) => x.id === id) ?? null;
        setExisting(p);
        if (p) {
          setName(p.displayName);
          setAvatarId(p.avatarId);
          setKids(p.isKids);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [api, id]);

  useBackHandler(() => {
    if (pinMode === 'set') {
      setPinMode('keep');
      setPin('');
      return true;
    }
    return false;
  });

  const save = async (pinValue?: string) => {
    const displayName = name.trim();
    if (!displayName) return setError('Give the profile a name');
    setBusy(true);
    setError(null);
    try {
      const pinField = pinValue ? { pin: pinValue } : pinMode === 'remove' ? { pin: null } : {};
      const avatar = avatars.find((a) => a.id === avatarId);
      if (existing) await api.updateProfile(existing.id, { displayName, avatarId, isKids: kids, ...pinField });
      else await api.createProfile({ displayName, avatarId, color: avatar?.color ?? null, isKids: kids, ...pinField });
      router.back();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPinMode('keep');
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const remove = () => {
    if (!existing) return;
    Alert.alert(`Delete ${existing.displayName}?`, 'Its watch history, My List and settings are deleted too.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void api.deleteProfile(existing.id).then(() => router.back()).catch((e) => setError(e instanceof Error ? e.message : String(e)));
        },
      },
    ]);
  };

  const tile = t.isTV ? t.s(96) : 64;
  if (loading) return <Screen><ActivityIndicator style={{ marginTop: t.space.xxl }} color={t.colors.primary} /></Screen>;

  if (pinMode === 'set') {
    return (
      <Screen>
        <ScreenHeader title="Choose a PIN" subtitle="4 digits, asked when someone opens this profile" />
        <View style={{ alignItems: 'center', gap: t.space.lg, marginTop: t.space.lg }}>
          <PinPad value={pin} onChange={setPin} length={4} onComplete={(v) => void save(v)} error={!!error} />
          {busy ? <ActivityIndicator color={t.colors.primary} /> : null}
          {error ? <T tone="danger">{error}</T> : null}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      <ScreenHeader title={existing ? `Edit ${existing.displayName}` : 'Add profile'} />
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl, gap: t.space.lg, maxWidth: t.isTV ? t.s(1100) : undefined }}>
        <Input label="Name" value={name} onChangeText={setName} placeholder="Who's this for?" autoFocus={!existing && !t.isTV} maxLength={40} returnKeyType="done" />
        {avatars.length ? (
          <View style={{ gap: t.space.sm }}>
            <T variant="small" tone="muted" weight="700">Avatar</T>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {avatars.map((a) => (
                <Focusable
                  key={a.id}
                  onPress={() => setAvatarId(a.id)}
                  ringRadius={tile * 0.3}
                  accessibilityLabel={`Avatar ${a.name}${avatarId === a.id ? ', selected' : ''}`}
                  style={{ width: tile, height: tile, borderRadius: tile * 0.26, overflow: 'hidden', backgroundColor: a.color, borderWidth: 3, borderColor: avatarId === a.id ? t.colors.primary : 'transparent' }}
                >
                  <Img path={a.url} width={tile * 2} style={{ width: '100%', height: '100%' }} />
                </Focusable>
              ))}
            </View>
          </View>
        ) : null}
        <View>
          <SettingRow icon="happy-outline" label="Kids profile" value="Family-friendly titles only, no Live TV unless the server allows it" toggle={kids} onToggle={setKids} />
          {existing?.hasPin && pinMode !== 'remove' ? (
            <>
              <SettingRow icon="keypad-outline" label="Change PIN" onPress={() => setPinMode('set')} />
              <SettingRow icon="lock-open-outline" label="Remove PIN" onPress={() => setPinMode('remove')} />
            </>
          ) : (
            <SettingRow icon="lock-closed-outline" label={pinMode === 'remove' ? 'PIN will be removed: add one again' : 'Add a PIN'} onPress={() => setPinMode('set')} />
          )}
        </View>
        {error ? <T tone="danger">{error}</T> : null}
        <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
          <Button label={busy ? 'Saving…' : existing ? 'Save' : 'Add profile'} icon="checkmark" onPress={() => void save()} disabled={busy} />
          {existing ? <Button label="Delete profile" icon="trash-outline" variant="ghost" onPress={remove} /> : null}
        </View>
      </ScrollView>
    </Screen>
  );
}
