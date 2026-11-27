/**
 * TV: "Use your phone as remote". Shows a QR code and a 6-character code (POST /pair/start, renewed when it runs
 * out); the phone opens it, signs in and becomes a touch-pad remote and second screen. Lists the paired phones
 * with Unpair. Guests (other accounts) are approved in a dialog wherever the TV is (state/session.tsx).
 */
import { useCallback, useEffect, useState } from 'react';
import { ScrollView, View } from 'react-native';
import type { PairStartResponse, Pairing } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { QrCode } from '@/components/QrCode';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { on } from '@/utils/events';

const fmtCode = (c: string) => `${c.slice(0, 3)} ${c.slice(3)}`;

export default function PairPhoneScreen() {
  const t = useTheme();
  const api = useApi();
  const { server } = useSession();
  const [start, setStart] = useState<PairStartResponse | null>(null);
  const [left, setLeft] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [pairings, setPairings] = useState<Pairing[]>([]);

  const fresh = useCallback(async () => {
    setError(null);
    try {
      setStart(await api.pairStart());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create a pairing code');
    }
  }, [api]);
  const loadPairings = useCallback(() => {
    api.pairings().then((p) => setPairings(p.filter((x) => x.role === 'tv')), () => undefined);
  }, [api]);

  useEffect(() => {
    void fresh();
    loadPairings();
  }, [fresh, loadPairings]);

  // Countdown; a new code when it runs out. Paired phones refresh every few seconds (a phone using the code).
  useEffect(() => {
    if (!start) return;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(start.expiresAt) - Date.now()) / 1000));
      setLeft(s);
      if (s <= 0) void fresh();
    };
    tick();
    const timer = setInterval(tick, 1000);
    const poll = setInterval(loadPairings, 4000);
    return () => {
      clearInterval(timer);
      clearInterval(poll);
    };
  }, [start, fresh, loadPairings]);
  // A phone just paired: the code is used up, show a new one for the next phone.
  useEffect(() => on('pairUpdated', () => {
    loadPairings();
    void fresh();
  }), [loadPairings, fresh]);

  const origin = (server?.url ?? '').replace(/\/+$/, '');
  const url = start ? `${origin}${start.path}` : '';
  const host = origin.replace(/^https?:\/\//, '');
  const qr = t.isTV ? t.s(300) : 240;

  return (
    <Screen>
      <ScreenHeader title="Use your phone as remote" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, alignItems: 'center' }}>
        <View style={{ flexDirection: t.isTV ? 'row' : 'column', gap: t.space.xxl, alignItems: 'center', maxWidth: t.isTV ? t.s(1100) : 560, width: '100%' }}>
          <View style={{ padding: t.space.sm, backgroundColor: '#fff', borderRadius: t.radius }}>
            {start ? <QrCode value={url} size={qr} /> : <View style={{ width: qr, height: qr, alignItems: 'center', justifyContent: 'center' }}><Icon name={error ? 'alert-circle-outline' : 'qr-code-outline'} size={48} color="#000" /></View>}
          </View>
          <View style={{ flex: t.isTV ? 1 : undefined, gap: t.space.md }}>
            <T>1. Point your phone's camera at the code.</T>
            <T>2. Open the link and sign in (any account on this server).</T>
            <T>3. Your phone becomes a touch-pad remote and a second screen.</T>
            <T tone="muted">Or open {host}/pair on your phone and type:</T>
            <T variant="title" weight="800" style={{ letterSpacing: 6 }}>{start ? fmtCode(start.code) : '••• •••'}</T>
            {start ? <T variant="small" tone="muted">New code in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}</T> : null}
            {error ? <T tone="danger">{error}</T> : null}
            <T variant="small" tone="muted">Someone signed in with a different account needs your OK on this screen, and can only control playback and browse what you're allowed to watch.</T>
          </View>
        </View>
        {pairings.length ? (
          <View style={{ width: '100%', maxWidth: t.isTV ? t.s(1100) : 560, marginTop: t.space.xl, gap: t.space.sm }}>
            <T variant="heading">Paired phones</T>
            {pairings.map((p) => (
              <View key={p.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
                <Icon name="phone-portrait-outline" />
                <View style={{ flex: 1 }}>
                  <T weight="700">{p.controllerDeviceName}</T>
                  <T variant="small" tone="muted">{p.crossUser ? `${p.otherUserName} · guest` : 'Your account'}{p.online ? ' · connected' : ''}</T>
                </View>
                <Button label="Unpair" icon="close" variant="ghost" size="sm" onPress={() => void api.unpair(p.id).then(loadPairings, () => undefined)} />
              </View>
            ))}
          </View>
        ) : null}
      </ScrollView>
    </Screen>
  );
}
