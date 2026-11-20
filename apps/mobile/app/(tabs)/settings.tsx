import Constants from 'expo-constants';
import { router } from 'expo-router';
import React, { useState } from 'react';
import { Alert, Linking, Platform, ScrollView, View } from 'react-native';
import { appVersion } from '@/api/device';
import { Button } from '@/components/Button';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { useDownloads } from '@/state/downloads';
import { useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatBytes } from '@/utils/format';

export default function SettingsScreen() {
  const t = useTheme();
  const { user, server, info, branding, device, api, signOut, switchProfile, refreshUser, lockServer } = useSession();
  const caps = useCapabilities();
  const downloads = useDownloads();
  const bottom = useTabBarSpace();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(user?.displayName ?? '');
  const theme = branding?.themes.find((x) => x.id === (branding.allowUserThemes ? user?.preferences.themeId : null)) ?? branding?.themes.find((x) => x.id === branding.defaultThemeId);
  const prefs = user?.preferences;

  const saveName = async () => {
    if (!api || !name.trim()) return;
    try {
      await api.updateMe({ displayName: name.trim() });
      await refreshUser();
      setEditing(false);
    } catch (e) {
      Alert.alert('Could not save', e instanceof Error ? e.message : '');
    }
  };

  const confirmSignOut = () => {
    if (t.isTV) return void signOut();
    Alert.alert('Sign out?', `You will be signed out of ${server?.name ?? 'this server'} on this device.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => void signOut() },
    ]);
  };

  const maxW = t.isTV ? t.s(820) : undefined;
  return (
    <Screen padTop={!t.isTV}>
      <ScrollView contentContainerStyle={{ paddingBottom: bottom, paddingHorizontal: t.space.gutter, alignItems: t.isTV ? 'center' : undefined }}>
        <View style={{ width: '100%', maxWidth: maxW }}>
          <ScreenHeader title="Settings" back={false} />
          {/* Account */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, marginBottom: t.space.lg }}>
            <View style={{ width: t.s(60), height: t.s(60), borderRadius: t.s(30), backgroundColor: t.colors.primary, overflow: 'hidden', alignItems: 'center', justifyContent: 'center' }}>
              {user?.avatarUrl ? <Img path={user.avatarUrl} width={60} style={{ width: '100%', height: '100%' }} /> : <T variant="title" color={t.colors.primaryText}>{user?.displayName?.slice(0, 1).toUpperCase()}</T>}
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              {editing ? (
                <Input value={name} onChangeText={setName} autoFocus returnKeyType="done" onSubmitEditing={saveName} />
              ) : (
                <T variant="heading" numberOfLines={1}>
                  {user?.displayName}
                </T>
              )}
              <T variant="small" tone="muted" numberOfLines={1}>
                @{user?.username} · {server?.name}
                {user?.isAdmin ? ' · Admin' : ''}
              </T>
            </View>
            {editing ? <Button label="Save" size="sm" onPress={saveName} /> : <Button icon="create-outline" variant="secondary" size="sm" onPress={() => setEditing(true)} accessibilityLabel="Edit name" />}
          </View>

          <SettingSection title="Appearance & playback">
            <SettingRow icon="color-palette-outline" label="Theme" value={branding?.allowUserThemes ? theme?.name : `${theme?.name ?? 'Server'} (set by server)`} onPress={branding?.allowUserThemes ? () => router.push('/settings/theme' as never) : undefined} hasTVPreferredFocus />
            <SettingRow icon="play-circle-outline" label="Playback" value={prefs?.maxBitrate ? `${Math.round(prefs.maxBitrate / 1000)} Mbps` : 'Original quality'} onPress={() => router.push('/settings/playback' as never)} />
          </SettingSection>

          <SettingSection title="Devices">
            {caps.linkCodes && !t.isTV ? <SettingRow icon="tv-outline" label="Link a TV" value="Enter a code" onPress={() => router.push('/link-tv' as never)} /> : null}
            <SettingRow icon="phone-portrait-outline" label="Signed-in devices" onPress={() => router.push('/settings/devices' as never)} />
            {downloads.supported && (caps.downloads || downloads.records.length) ? <SettingRow icon="download-outline" label="Downloads" value={formatBytes(downloads.totalBytes) || 'None'} onPress={() => router.push('/(tabs)/downloads')} /> : null}
          </SettingSection>

          <SettingSection title="Account">
            {caps.profilePicker ? <SettingRow icon="people-outline" label="Switch profile" onPress={() => void switchProfile()} /> : null}
            {!lockServer ? <SettingRow icon="server-outline" label="Switch server" value={server?.name} onPress={() => router.push('/connect')} /> : null}
            <SettingRow icon="log-out-outline" label="Sign out" destructive onPress={confirmSignOut} chevron={false} />
          </SettingSection>

          <SettingSection title="About">
            <SettingRow label="Server" value={`${info?.name ?? server?.name ?? ''} ${info?.version ? `v${info.version}` : ''}`} chevron={false} />
            <SettingRow label="Address" value={server?.url} chevron={false} />
            <SettingRow label="App" value={`${Constants.expoConfig?.name ?? 'MediaMax'} ${appVersion()} · ${device?.platform ?? Platform.OS}`} chevron={false} />
            <SettingRow label="Device" value={device?.deviceName} chevron={false} />
            {branding?.supportUrl ? <SettingRow icon="help-buoy-outline" label="Help & support" onPress={() => Linking.openURL(branding.supportUrl!)} /> : null}
          </SettingSection>
          {branding?.footerText ? (
            <T variant="small" tone="muted" center style={{ marginTop: t.space.sm }}>
              {branding.footerText}
            </T>
          ) : null}
          <T variant="caption" tone="muted" center style={{ marginTop: t.space.sm, opacity: 0.6 }}>
            Device ID {device?.deviceId.slice(0, 8)}
          </T>
        </View>
      </ScrollView>
    </Screen>
  );
}
