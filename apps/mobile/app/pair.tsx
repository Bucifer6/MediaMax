import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, View } from 'react-native';
import type { PairClaimResponse, PairStatus } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';

/**
 * Phone side of QR pairing. Opened by the deep link `kinora://pair?c=CODE&t=SECRET&s=SERVER` (or the legacy `mediamax://pair?…`) (the "Open in the app"
 * button on the web pairing page) or from Link a TV → "Use this phone as a remote", where the code is typed.
 * Pairing waits for one tap; a TV signed in with another account must accept on screen.
 */
export default function PairScreen() {
  const t = useTheme();
  const api = useApi();
  const { socket, server } = useSession();
  const params = useLocalSearchParams<{ c?: string; t?: string; s?: string }>();
  const token = typeof params.t === 'string' ? params.t : '';
  const fromServer = typeof params.s === 'string' ? params.s.replace(/\/+$/, '') : '';
  const wrongServer = !!fromServer && !!server?.url && server.url.replace(/\/+$/, '').toLowerCase() !== fromServer.toLowerCase();
  const [code, setCode] = useState(typeof params.c === 'string' ? params.c.toUpperCase() : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<PairClaimResponse | null>(null);
  const [status, setStatus] = useState<PairStatus | null>(null);
  const claimed = useRef(false);

  const done = (deviceId: string) => router.replace({ pathname: '/tv-remote', params: { device: deviceId } });

  const submit = async () => {
    if (claimed.current) return;
    claimed.current = true;
    setBusy(true);
    setError(null);
    try {
      const r = await api.post<PairClaimResponse>('/pair/claim', token ? { token } : { code });
      setClaim(r);
      setStatus(r.status);
      if (r.status === 'paired') done(r.targetDeviceId);
    } catch (e) {
      claimed.current = false;
      setError(e instanceof Error ? e.message : 'Pairing failed');
    } finally {
      setBusy(false);
    }
  };

  // Waiting for the TV's owner: socket event, polling as a fallback.
  useEffect(() => {
    if (status !== 'pending' || !claim?.requestId) return;
    const off = socket?.subscribe((ev) => {
      if (ev.type === 'pair.updated' && ev.requestId === claim.requestId) {
        setStatus(ev.status);
        if (ev.status === 'paired') done(claim.targetDeviceId);
      }
    });
    const timer = setInterval(() => {
      api.get<{ status: PairStatus }>(`/pair/requests/${encodeURIComponent(claim.requestId!)}`).then((r) => {
        setStatus(r.status);
        if (r.status === 'paired') done(claim.targetDeviceId);
      }, () => undefined);
    }, 3000);
    return () => {
      off?.();
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, claim?.requestId, socket]);

  return (
    <Screen>
      <ScreenHeader title="Phone remote" />
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <View style={{ flex: 1, padding: t.space.gutter, gap: t.space.lg, justifyContent: 'center', maxWidth: 480, alignSelf: 'center', width: '100%' }}>
          <View style={{ alignItems: 'center', gap: t.space.sm }}>
            <View style={{ width: 84, height: 84, borderRadius: 42, backgroundColor: t.alpha(t.colors.primary, 0.15), alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="tv-outline" size={40} color={t.colors.primary} />
            </View>
            {status === 'pending' && claim ? (
              <>
                <T variant="title" center>Waiting for {claim.ownerName}</T>
                <T tone="muted" center>Accept the request on {claim.targetName}. It’s signed in with another account, so you’ll get playback control and can browse what it may show.</T>
                <ActivityIndicator color={t.colors.primary} />
              </>
            ) : status === 'declined' || status === 'expired' ? (
              <>
                <T variant="title" center>{status === 'declined' ? 'Request declined' : 'Request expired'}</T>
                <T tone="muted" center>Show a new code on the TV and try again.</T>
              </>
            ) : wrongServer ? (
              <>
                <T variant="title" center>Different server</T>
                <T tone="muted" center>This code is for {fromServer}, but the app is connected to {server?.url}. Switch servers in Settings first.</T>
              </>
            ) : (
              <>
                <T variant="title" center>{token ? 'Pair with this TV?' : 'Enter the code on your TV'}</T>
                <T tone="muted" center>{token ? 'This phone becomes a touch-pad remote and second screen for the TV that showed the code.' : 'On the TV choose “Use your phone as remote”, then type the 6-character code.'}</T>
              </>
            )}
          </View>
          {!token && !claim && (
            <Input
              value={code}
              onChangeText={(v) => setCode(v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              placeholder="ABC123"
              autoCapitalize="characters"
              autoCorrect={false}
              autoFocus
              returnKeyType="done"
              onSubmitEditing={submit}
              style={{ fontSize: 30, letterSpacing: 8, textAlign: 'center', fontWeight: '800' }}
            />
          )}
          {!claim && !wrongServer && (
            <Button label="Pair" icon="link" onPress={submit} loading={busy} disabled={!token && code.length !== 6} block size="lg" />
          )}
          {(status === 'declined' || status === 'expired') && (
            <Button label="Try another code" variant="secondary" onPress={() => { claimed.current = false; setClaim(null); setStatus(null); setCode(''); router.setParams({ c: '', t: '', s: '' }); }} />
          )}
          {error ? (
            <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="alert-circle" color={t.colors.danger} />
              <T tone="danger" weight="700">{error}</T>
            </View>
          ) : null}
          <Button label="Open the remote" variant="ghost" onPress={() => router.replace('/tv-remote')} style={{ alignSelf: 'center' }} />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
