import { router } from 'expo-router';
import React, { useState } from 'react';
import { KeyboardAvoidingView, Platform, View } from 'react-native';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';

/** Phone side of TV pairing: approve the code the TV shows. */
export default function LinkTvScreen() {
  const t = useTheme();
  const api = useApi();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  const approve = async () => {
    const c = code.trim().toUpperCase();
    if (c.length < 4) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.linkApprove(c);
      setResult({ ok: true, text: `${r.deviceName || 'Your TV'} is now signed in.` });
      setCode('');
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'That code did not work' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Link a TV" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, padding: t.space.gutter, gap: t.space.lg, justifyContent: 'center', maxWidth: 480, alignSelf: 'center', width: '100%' }}>
          <View style={{ alignItems: 'center', gap: t.space.sm }}>
            <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: t.alpha(t.colors.primary, 0.15), alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="tv-outline" size={40} color={t.colors.primary} />
            </View>
            <T variant="title" center>Enter the code on your TV</T>
            <T tone="muted" center>Open the app on your Apple TV or Android TV and choose “Use your phone”. It will sign in as you.</T>
          </View>
          <Input
            value={code}
            onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8))}
            placeholder="ABCD"
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
            returnKeyType="done"
            onSubmitEditing={approve}
            style={{ fontSize: 34, letterSpacing: 10, textAlign: 'center', fontWeight: '800' }}
          />
          <Button label="Link TV" icon="link" onPress={approve} loading={busy} disabled={code.length < 4} block size="lg" />
          {result ? (
            <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name={result.ok ? 'checkmark-circle' : 'alert-circle'} color={result.ok ? t.colors.success : t.colors.danger} />
              <T tone={result.ok ? 'success' : 'danger'} weight="700">{result.text}</T>
            </View>
          ) : null}
          {result?.ok ? <Button label="Done" variant="ghost" onPress={() => router.back()} style={{ alignSelf: 'center' }} /> : null}
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
