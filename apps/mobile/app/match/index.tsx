/** Movie Match: start a session (phone or TV) or join one with the code shown on the host's screen. */
import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { router } from 'expo-router';
import type { MatchContentKind, MatchRule } from '@/api/types';
import { decide, normalizeCode } from '@/api/decide';
import { useApi } from '@/state/session';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Input } from '@/components/Input';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { useTheme } from '@/theme';

export default function MatchStartScreen() {
  const t = useTheme();
  const api = useApi();
  const d = decide(api);
  const [kind, setKind] = useState<MatchContentKind>('movies');
  const [rule, setRule] = useState<MatchRule>('all');
  const [unwatched, setUnwatched] = useState(true);
  const [maxRuntime, setMaxRuntime] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<{ id: string }>) => {
    setBusy(true);
    try {
      const s = await fn();
      router.replace(`/match/${s.id}` as never);
    } catch (e) {
      Alert.alert('Movie Match', (e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Movie Match" subtitle="Swipe together, find a film everyone wants" />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: t.space.gutter, gap: t.space.lg }}>
        <View style={{ gap: t.space.sm }}>
          <T variant="heading">Join</T>
          <T tone="muted">Type the code on the TV (or scan its QR code with your camera).</T>
          <Input value={code} onChangeText={(v) => setCode(normalizeCode(v))} placeholder="CODE" autoCapitalize="characters" autoCorrect={false} maxLength={8}
            style={{ fontSize: 26, letterSpacing: 6, textAlign: 'center' }} onSubmitEditing={() => code.length === 6 && run(() => d.joinMatch(code))} />
          <Button label="Join" icon="people" disabled={code.length !== 6} loading={busy} onPress={() => run(() => d.joinMatch(code))} />
        </View>
        <View style={{ gap: t.space.sm }}>
          <T variant="heading">Start a session</T>
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            {(['movies', 'shows', 'both'] as const).map((k) => <Chip key={k} label={k === 'movies' ? 'Movies' : k === 'shows' ? 'Shows' : 'Both'} selected={kind === k} onPress={() => setKind(k)} />)}
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            {[null, 90, 120].map((m) => <Chip key={String(m)} label={m ? `Under ${m} min` : 'Any length'} selected={maxRuntime === m} onPress={() => setMaxRuntime(m)} />)}
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.sm, flexWrap: 'wrap' }}>
            <Chip label="Everyone says yes" selected={rule === 'all'} onPress={() => setRule('all')} />
            <Chip label="Majority wins" selected={rule === 'majority'} onPress={() => setRule('majority')} />
          </View>
          <Chip label="Only things nobody has seen" icon="eye-off-outline" selected={unwatched} onPress={() => setUnwatched((v) => !v)} />
          <T variant="small" tone="muted">The strictest profile in the group sets the age rating.</T>
          <Button label="Start matching" icon="play" loading={busy} onPress={() => run(() => d.createMatch({ kind, rule, unwatchedByAll: unwatched, maxRuntimeMin: maxRuntime }))} />
        </View>
      </ScrollView>
    </Screen>
  );
}
