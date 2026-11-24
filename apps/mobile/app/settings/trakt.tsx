/** Settings → Connected services → Trakt (device-code sign-in, scrobble toggle, disconnect). */
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import type { TraktDeviceCode, TraktStatus } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { ErrorState } from '@/components/States';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';

const POLL_MS = 5000;
const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function TraktScreen() {
  const t = useTheme();
  const api = useApi();
  const { user } = useSession();
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [code, setCode] = useState<TraktDeviceCode | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.trakt());
      setLoadError(null);
    } catch (e) {
      setLoadError(msg(e, 'Could not load Trakt status'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // While a code is shown: poll every 5 s until connected or the code expires.
  useEffect(() => {
    if (!code) return;
    const expires = new Date(code.expiresAt).getTime();
    const timer = setInterval(async () => {
      if (Date.now() > expires) {
        setCode(null);
        setError('The code expired. Start again to get a new one.');
        return;
      }
      try {
        const s = await api.trakt();
        setStatus(s);
        if (s.connected) setCode(null);
      } catch {
        /* keep polling */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [code, api]);

  const run = async (fn: () => Promise<void>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e, fallback));
    } finally {
      setBusy(false);
    }
  };

  const connect = () => run(async () => setCode(await api.traktConnect()), 'Could not start the Trakt sign-in');
  const setScrobble = (v: boolean) =>
    run(async () => {
      setStatus((s) => (s ? { ...s, scrobble: v } : s));
      setStatus(await api.traktSetScrobble(v));
    }, 'Could not save');
  const disconnect = () => run(async () => setStatus(await api.traktDisconnect()), 'Could not disconnect');

  const body = () => {
    if (loadError && !status) return <ErrorState error={loadError} onRetry={load} />;
    if (!status) return <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xxl }} />;
    if (!status.available)
      return (
        <View style={{ alignItems: 'center', gap: t.space.md, padding: t.space.xl }}>
          <Icon name="construct-outline" size={t.isTV ? t.s(48) : 40} color={t.colors.textMuted} />
          <T variant="heading" center>
            Trakt isn’t set up on this server
          </T>
          <T tone="muted" center style={{ maxWidth: t.isTV ? t.s(640) : 420 }}>
            {user?.isAdmin
              ? 'Create an app at trakt.tv/oauth/applications, then enter its client ID and secret in the web dashboard under Server settings → Trakt.'
              : 'Ask your server admin to add a Trakt app (client ID and secret) in the server settings. Once that’s done you can connect your account here.'}
          </T>
          <Button label="Check again" icon="refresh" variant="secondary" onPress={load} hasTVPreferredFocus style={{ alignSelf: 'center' }} />
        </View>
      );
    if (status.connected)
      return (
        <>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface, marginBottom: t.space.lg }}>
            <Icon name="checkmark-circle" color={t.colors.success} size={t.isTV ? t.s(36) : 30} />
            <View style={{ flex: 1 }}>
              <T variant="heading">Connected</T>
              <T tone="muted">{status.username ? `Signed in as ${status.username}` : 'Your Trakt account is linked'}</T>
            </View>
          </View>
          <SettingSection title="Sync">
            <SettingRow icon="radio-outline" label="Scrobble what I watch" toggle={status.scrobble} onToggle={(v) => void setScrobble(v)} hasTVPreferredFocus />
          </SettingSection>
          <T variant="small" tone="muted" style={{ marginBottom: t.space.lg, paddingHorizontal: t.space.sm }}>
            When on, playback start, pause and stop plus “mark watched” are sent to Trakt automatically.
          </T>
          <SettingSection>
            <SettingRow icon="unlink-outline" label="Disconnect Trakt" destructive chevron={false} onPress={() => void disconnect()} />
          </SettingSection>
        </>
      );
    if (code)
      return (
        <View style={{ alignItems: 'center', gap: t.space.lg, paddingVertical: t.space.lg }}>
          <T tone="muted" center>
            On your phone or computer, go to
          </T>
          <T variant={t.isTV ? 'title' : 'heading'} tone="primary" center selectable onPress={t.isTV ? undefined : () => Linking.openURL(code.verificationUrl)}>
            {code.verificationUrl.replace(/^https?:\/\//, '')}
          </T>
          <T tone="muted" center>
            and enter this code
          </T>
          <View style={{ paddingHorizontal: t.isTV ? t.s(48) : 24, paddingVertical: t.isTV ? t.s(20) : 14, borderRadius: t.radius * 1.5, backgroundColor: t.alpha(t.colors.primary, 0.14), borderWidth: 2, borderColor: t.colors.primary }}>
            <T weight="900" selectable style={{ fontSize: t.isTV ? t.s(96) : 52, lineHeight: t.isTV ? t.s(110) : 62, letterSpacing: t.isTV ? t.s(16) : 8, color: t.colors.text }} adjustsFontSizeToFit numberOfLines={1}>
              {code.userCode}
            </T>
          </View>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <ActivityIndicator color={t.colors.primary} />
            <T tone="muted">Waiting for you to approve…</T>
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            {!t.isTV ? <Button label="Open Trakt" icon="open-outline" onPress={() => Linking.openURL(code.verificationUrl)} /> : null}
            <Button label="Cancel" variant="secondary" onPress={() => setCode(null)} hasTVPreferredFocus />
          </View>
        </View>
      );
    return (
      <View style={{ alignItems: 'center', gap: t.space.md, padding: t.space.xl }}>
        <Icon name="sync-circle-outline" size={t.isTV ? t.s(56) : 48} color={t.colors.primary} />
        <T variant="heading" center>
          Connect your Trakt account
        </T>
        <T tone="muted" center style={{ maxWidth: t.isTV ? t.s(640) : 420 }}>
          Keep your watch history in sync with Trakt. You’ll get a short code to enter on trakt.tv.
        </T>
        <Button label="Connect Trakt" icon="link" onPress={connect} loading={busy} hasTVPreferredFocus style={{ alignSelf: 'center' }} />
      </View>
    );
  };

  return (
    <Screen>
      <ScreenHeader title="Trakt" subtitle="Connected services" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl, alignItems: t.isTV ? 'center' : undefined }}>
        <View style={{ width: '100%', maxWidth: t.isTV ? t.s(820) : undefined }}>
          {error ? (
            <T tone="danger" weight="600" center style={{ marginBottom: t.space.md }}>
              {error}
            </T>
          ) : null}
          {body()}
        </View>
      </ScrollView>
    </Screen>
  );
}
