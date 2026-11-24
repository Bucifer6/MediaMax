import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { BrandMarkImage } from '@/components/BrandWordmark';
import { BackButton } from '@/components/Screen';
import { T } from '@/components/Text';
import { useSession, type SavedServer } from '@/state/session';
import { useTheme } from '@/theme';

export default function ConnectScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { servers, server, addServer, selectServer, removeServer, status, lockServer } = useSession();
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const connect = async () => {
    if (!url.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await addServer(url);
      setUrl('');
      router.replace('/login');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not connect');
    } finally {
      setBusy(false);
    }
  };

  const pick = async (s: SavedServer) => {
    setBusy(true);
    await selectServer(s.id);
    setBusy(false);
    router.replace('/');
  };

  const canGoBack = status === 'signed-in' && router.canGoBack();
  const contentWidth = t.isTV ? t.s(620) : Math.min(t.width - 32, 460);

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      <LinearGradient colors={[t.alpha(t.colors.primary, 0.35), 'transparent']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: t.height * 0.55 }} />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
          {canGoBack ? (
            <View style={{ position: 'absolute', top: insets.top + 8, left: 8 }}>
              <BackButton />
            </View>
          ) : null}
          <View style={{ width: contentWidth, gap: t.space.lg }}>
            <View style={{ alignItems: 'center', gap: t.space.sm, marginBottom: t.space.md }}>
              <BrandMarkImage size={t.s(72)} />
              <T variant="hero" center>
                {servers.length ? 'Your servers' : 'Connect to your server'}
              </T>
              <T tone="muted" center>
                Enter the address of your media server — for example{' '}
                <T tone="default" weight="700">
                  192.168.1.20:8096
                </T>{' '}
                or{' '}
                <T tone="default" weight="700">
                  media.example.com
                </T>
              </T>
            </View>

            {servers.length ? (
              <View style={{ gap: t.space.sm }}>
                {servers.map((s, i) => (
                  <View key={s.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                    <Focusable
                      onPress={() => pick(s)}
                      hasTVPreferredFocus={i === 0}
                      containerStyle={{ flex: 1 }}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, borderWidth: 1, borderColor: s.id === server?.id ? t.colors.primary : t.colors.border }}
                    >
                      <View style={{ width: t.s(44), height: t.s(44), borderRadius: t.s(22), backgroundColor: t.alpha(t.colors.primary, 0.18), alignItems: 'center', justifyContent: 'center' }}>
                        <Icon name="server-outline" color={t.colors.primary} />
                      </View>
                      <View style={{ flex: 1 }}>
                        <T weight="700" numberOfLines={1}>
                          {s.name}
                        </T>
                        <T variant="small" tone="muted" numberOfLines={1}>
                          {s.url}
                          {s.userName ? ` · ${s.userName}` : ''}
                        </T>
                      </View>
                      <Icon name="chevron-forward" color={t.colors.textMuted} />
                    </Focusable>
                    {!lockServer ? <Button icon="trash-outline" variant="secondary" accessibilityLabel={`Remove ${s.name}`} onPress={() => removeServer(s.id)} /> : null}
                  </View>
                ))}
              </View>
            ) : null}

            {!lockServer || !servers.length ? (
              <View style={{ gap: t.space.md, padding: t.space.lg, borderRadius: t.radius * 1.4, backgroundColor: t.alpha(t.colors.surface, 0.85), borderWidth: 1, borderColor: t.colors.border }}>
                <T variant="heading">{servers.length ? 'Add another server' : 'Server address'}</T>
                <Input
                  value={url}
                  onChangeText={setUrl}
                  placeholder="https://media.example.com"
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
                  returnKeyType="go"
                  onSubmitEditing={connect}
                  icon="globe-outline"
                  autoFocus={!servers.length && !t.isTV}
                />
                {error ? (
                  <T tone="danger" variant="small">
                    {error}
                  </T>
                ) : null}
                <Button label="Connect" icon="arrow-forward" onPress={connect} loading={busy} block size="lg" hasTVPreferredFocus={!servers.length} />
              </View>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}
