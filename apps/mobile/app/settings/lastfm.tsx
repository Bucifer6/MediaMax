/** Settings → Connected services → Last.fm (browser approval, scrobble toggle, disconnect). */
import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, View } from 'react-native';
import type { LastfmStatus } from '@/api/types';
import { Button } from '@/components/Button';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { ErrorState } from '@/components/States';
import { T } from '@/components/Text';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { webBrowser } from '@/utils/browser';

const POLL_MS = 3000;
/** Give up polling after this long without a connection. */
const POLL_LIMIT_MS = 10 * 60 * 1000;
const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

export default function LastfmScreen() {
  const t = useTheme();
  const api = useApi();
  const { user } = useSession();
  const [status, setStatus] = useState<LastfmStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Set while waiting for the user to approve in the browser (TV: the URL to show). */
  const [authUrl, setAuthUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setStatus(await api.lastfm());
      setLoadError(null);
    } catch (e) {
      setLoadError(msg(e, 'Could not load Last.fm status'));
    }
  }, [api]);
  useEffect(() => {
    void load();
  }, [load]);

  // Poll GET /lastfm every 3 s (it completes the connection server-side) until connected.
  useEffect(() => {
    if (!authUrl) return;
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > POLL_LIMIT_MS) {
        setAuthUrl(null);
        setError('Timed out waiting for Last.fm. Try connecting again.');
        return;
      }
      try {
        const s = await api.lastfm();
        setStatus(s);
        if (s.connected) setAuthUrl(null);
      } catch {
        /* keep polling */
      }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [authUrl, api]);

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

  const connect = () =>
    run(async () => {
      const { authUrl: url } = await api.lastfmConnect();
      setAuthUrl(url);
      const wb = webBrowser();
      if (wb) {
        await wb.openBrowserAsync(url).catch(() => Linking.openURL(url));
        // Back from the browser: check straight away instead of waiting for the next poll.
        const s = await api.lastfm().catch(() => null);
        if (s) {
          setStatus(s);
          if (s.connected) setAuthUrl(null);
        }
      }
    }, 'Could not start the Last.fm sign-in');
  const setScrobble = (v: boolean) =>
    run(async () => {
      setStatus((s) => (s ? { ...s, scrobble: v } : s));
      setStatus(await api.lastfmSetScrobble(v));
    }, 'Could not save');
  const disconnect = () => run(async () => setStatus(await api.lastfmDisconnect()), 'Could not disconnect');

  const body = () => {
    if (loadError && !status) return <ErrorState error={loadError} onRetry={load} />;
    if (!status) return <ActivityIndicator color={t.colors.primary} style={{ marginTop: t.space.xxl }} />;
    if (!status.available)
      return (
        <View style={{ alignItems: 'center', gap: t.space.md, padding: t.space.xl }}>
          <Icon name="construct-outline" size={t.isTV ? t.s(48) : 40} color={t.colors.textMuted} />
          <T variant="heading" center>
            Last.fm isn’t set up on this server
          </T>
          <T tone="muted" center style={{ maxWidth: t.isTV ? t.s(640) : 420 }}>
            {user?.isAdmin
              ? 'Create an API account at last.fm/api/account/create, then enter its API key and shared secret in the web dashboard under Server settings → Last.fm.'
              : 'Ask your server admin to add a Last.fm API account in the server settings. Once that’s done you can connect here.'}
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
              <T tone="muted">{status.username ? `Signed in as ${status.username}` : 'Your Last.fm account is linked'}</T>
            </View>
          </View>
          <SettingSection title="Sync">
            <SettingRow icon="radio-outline" label="Scrobble what I listen to" toggle={status.scrobble} onToggle={(v) => void setScrobble(v)} hasTVPreferredFocus />
          </SettingSection>
          <T variant="small" tone="muted" style={{ marginBottom: t.space.lg, paddingHorizontal: t.space.sm }}>
            “Now playing” is sent when a track starts; it is scrobbled after half its length or 4 minutes.
          </T>
          <SettingSection>
            <SettingRow icon="unlink-outline" label="Disconnect Last.fm" destructive chevron={false} onPress={() => void disconnect()} />
          </SettingSection>
        </>
      );
    if (authUrl)
      return (
        <View style={{ alignItems: 'center', gap: t.space.lg, paddingVertical: t.space.lg }}>
          {t.isTV ? (
            <>
              <T tone="muted" center>
                On your phone or computer, open this address and approve Kinora:
              </T>
              <T variant="heading" tone="primary" center selectable style={{ maxWidth: t.s(900) }}>
                {authUrl}
              </T>
            </>
          ) : (
            <T tone="muted" center>
              Approve Kinora on Last.fm in the browser, then come back here.
            </T>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
            <ActivityIndicator color={t.colors.primary} />
            <T tone="muted">Waiting for Last.fm…</T>
          </View>
          <View style={{ flexDirection: 'row', gap: t.space.sm }}>
            {!t.isTV ? <Button label="Open Last.fm again" icon="open-outline" onPress={() => void (webBrowser()?.openBrowserAsync(authUrl) ?? Linking.openURL(authUrl))} /> : null}
            <Button label="Cancel" variant="secondary" onPress={() => setAuthUrl(null)} hasTVPreferredFocus />
          </View>
        </View>
      );
    return (
      <View style={{ alignItems: 'center', gap: t.space.md, padding: t.space.xl }}>
        <Icon name="musical-notes-outline" size={t.isTV ? t.s(56) : 48} color={t.colors.primary} />
        <T variant="heading" center>
          Connect your Last.fm account
        </T>
        <T tone="muted" center style={{ maxWidth: t.isTV ? t.s(640) : 420 }}>
          Scrobble the music you play here to your Last.fm profile.{t.isTV ? ' You’ll approve it from your phone or computer.' : ''}
        </T>
        <Button label="Connect Last.fm" icon="link" onPress={connect} loading={busy} hasTVPreferredFocus style={{ alignSelf: 'center' }} />
      </View>
    );
  };

  return (
    <Screen>
      <ScreenHeader title="Last.fm" subtitle="Connected services" />
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
