import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Platform, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ApiError } from '@/api/client';
import type { LinkCodeResponse, PublicProfile } from '@/api/types';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Input, type TextInputRef } from '@/components/Input';
import { PinPad } from '@/components/PinPad';
import { T } from '@/components/Text';
import { useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { useBackHandler } from '@/tv';

type Mode = 'profiles' | 'pin' | 'password' | 'link';

export default function LoginScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const { api, branding, info, server, features, completeLogin, lockServer, error: sessionError, retry } = useSession();
  const [profiles, setProfiles] = useState<PublicProfile[] | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [selected, setSelected] = useState<PublicProfile | null>(null);
  const [pin, setPin] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const passwordRef = useRef<TextInputRef>(null);

  // Load profiles and choose the default mode (link code on TV).
  useEffect(() => {
    if (!api) return;
    let alive = true;
    (async () => {
      let list: PublicProfile[] = [];
      if (features.profilePicker) {
        try {
          list = await api.profiles();
        } catch {
          list = [];
        }
      }
      if (!alive) return;
      setProfiles(list);
      setMode((m) => m ?? (t.isTV && features.linkCodes ? 'link' : list.length ? 'profiles' : 'password'));
    })();
    return () => {
      alive = false;
    };
  }, [api, features.profilePicker, features.linkCodes, t.isTV]);

  const fail = (e: unknown) => setError(e instanceof ApiError ? (e.status === 401 ? 'Incorrect details — try again.' : e.message) : 'Could not sign in');

  const enterProfile = async (p: PublicProfile, pinValue?: string) => {
    if (!api) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await api.profileLogin(p.id, pinValue);
      await completeLogin(auth);
      router.replace('/(tabs)');
    } catch (e) {
      fail(e);
      setPin('');
    } finally {
      setBusy(false);
    }
  };

  const chooseProfile = (p: PublicProfile) => {
    setSelected(p);
    setError(null);
    setPin('');
    if (p.requiresPassword) {
      setUsername(p.username ?? p.displayName);
      setMode('password');
    } else if (p.hasPin) setMode('pin');
    else void enterProfile(p);
  };

  const signIn = async () => {
    if (!api || !username || !password) return;
    setBusy(true);
    setError(null);
    try {
      const auth = await api.login(username.trim(), password);
      await completeLogin(auth);
      router.replace('/(tabs)');
    } catch (e) {
      fail(e);
    } finally {
      setBusy(false);
    }
  };

  // Back on the remote steps back through the modes.
  useBackHandler(() => {
    if (mode === 'pin' || (mode === 'password' && selected)) {
      setMode('profiles');
      setSelected(null);
      return true;
    }
    return false;
  }, mode === 'pin' || (mode === 'password' && !!selected));

  const logo = branding?.logoWideUrl ?? branding?.logoUrl;
  const panelWidth = t.isTV ? t.s(760) : Math.min(t.width - 32, 480);
  const serverName = branding?.serverName ?? info?.name ?? server?.name ?? 'MediaMax';

  const modes: { key: Mode; label: string; icon: React.ComponentProps<typeof Chip>['icon'] }[] = [];
  if (profiles?.length) modes.push({ key: 'profiles', label: 'Profiles', icon: 'people-outline' });
  modes.push({ key: 'password', label: 'Password', icon: 'key-outline' });
  if (features.linkCodes) modes.push({ key: 'link', label: t.isTV ? 'Use your phone' : 'Link code', icon: 'phone-portrait-outline' });

  return (
    <View style={{ flex: 1, backgroundColor: t.colors.background }}>
      {branding?.loginBackgroundUrl ? <Img path={branding.loginBackgroundUrl} width={t.width} style={{ position: 'absolute', width: '100%', height: '100%' }} priority="high" /> : null}
      <LinearGradient
        colors={[t.alpha(t.colors.overlay, 0.35), t.alpha(t.colors.background, 0.85), t.colors.background]}
        locations={[0, 0.55, 1]}
        style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 }}
      />
      {!branding?.loginBackgroundUrl ? <LinearGradient colors={[t.alpha(t.colors.primary, 0.4), 'transparent']} style={{ position: 'absolute', top: 0, left: 0, right: 0, height: t.height * 0.6 }} /> : null}
      <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={{ flexGrow: 1, alignItems: 'center', justifyContent: 'center', paddingTop: insets.top + t.space.xl, paddingBottom: insets.bottom + t.space.xl, paddingHorizontal: t.space.md }} keyboardShouldPersistTaps="handled">
          <View style={{ alignItems: 'center', gap: t.space.sm, marginBottom: t.space.xl, maxWidth: panelWidth }}>
            {logo ? (
              <Img path={logo} width={t.s(320)} contentFit="contain" style={{ width: t.isTV ? t.s(360) : 240, height: t.isTV ? t.s(110) : 72 }} />
            ) : (
              <T variant="hero" center>
                {serverName}
              </T>
            )}
            {branding?.loginMessage ? (
              <T tone="muted" center>
                {branding.loginMessage}
              </T>
            ) : branding?.tagline ? (
              <T tone="muted" center>
                {branding.tagline}
              </T>
            ) : null}
          </View>

          {!mode ? (
            <ActivityIndicator color={t.colors.primary} size="large" />
          ) : (
            <View style={{ width: mode === 'profiles' ? Math.min(t.width - 32, t.isTV ? t.s(1100) : 640) : panelWidth, alignItems: 'center', gap: t.space.lg }}>
              {mode === 'profiles' && profiles ? <ProfileGrid profiles={profiles} onPick={chooseProfile} busyId={busy ? selected?.id : undefined} /> : null}

              {mode === 'pin' && selected ? (
                <View style={{ alignItems: 'center', gap: t.space.lg }}>
                  <Avatar profile={selected} size={t.isTV ? t.s(96) : 80} />
                  <T variant="heading">Enter PIN for {selected.displayName}</T>
                  <PinPad value={pin} onChange={setPin} onComplete={(p) => enterProfile(selected, p)} error={!!error} />
                  {busy ? <ActivityIndicator color={t.colors.primary} /> : null}
                </View>
              ) : null}

              {mode === 'password' ? (
                <View style={{ width: '100%', gap: t.space.md, padding: t.space.lg, borderRadius: t.radius * 1.4, backgroundColor: t.alpha(t.colors.surface, 0.9), borderWidth: 1, borderColor: t.colors.border }}>
                  <T variant="heading">{selected ? `Sign in as ${selected.displayName}` : `Sign in to ${serverName}`}</T>
                  <Input label="Username" value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} textContentType="username" returnKeyType="next" onSubmitEditing={() => passwordRef.current?.focus()} icon="person-outline" />
                  <Input ref={passwordRef} label="Password" value={password} onChangeText={setPassword} secureTextEntry textContentType="password" returnKeyType="go" onSubmitEditing={signIn} icon="lock-closed-outline" />
                  <Button label="Sign in" onPress={signIn} loading={busy} block size="lg" disabled={!username || !password} />
                </View>
              ) : null}

              {mode === 'link' ? <LinkCodePanel onLinked={async (auth) => { await completeLogin(auth); router.replace('/(tabs)'); }} /> : null}

              {error ? (
                <T tone="danger" center>
                  {error}
                </T>
              ) : null}

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.space.sm, marginTop: t.space.md }}>
                {modes.map((m) => (
                  <Chip key={m.key} label={m.label} icon={m.icon} selected={mode === m.key || (mode === 'pin' && m.key === 'profiles')} onPress={() => { setMode(m.key); setSelected(null); setError(null); }} />
                ))}
              </View>
              {!lockServer ? (
                <Focusable onPress={() => router.push('/connect')} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs, padding: t.space.sm }}>
                  <Icon name="swap-horizontal" size={t.isTV ? t.s(20) : 16} color={t.colors.textMuted} />
                  <T variant="small" tone="muted">
                    {server?.url ?? 'Change server'} · Switch server
                  </T>
                </Focusable>
              ) : null}
              {sessionError ? (
                <Button label="Server unreachable — retry" icon="refresh" variant="ghost" size="sm" onPress={retry} />
              ) : null}
            </View>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function Avatar({ profile, size }: { profile: PublicProfile; size: number }) {
  const t = useTheme();
  const hue = [...profile.id].reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  return (
    <View style={{ width: size, height: size, borderRadius: t.shapeRadius(size, size) === t.radius ? size * 0.28 : size / 2, overflow: 'hidden', backgroundColor: `hsl(${hue}, 55%, 45%)`, alignItems: 'center', justifyContent: 'center' }}>
      {profile.avatarUrl ? (
        <Img path={profile.avatarUrl} width={size} style={{ width: '100%', height: '100%' }} />
      ) : (
        <T variant="title" color="#fff" style={{ fontSize: size * 0.42, lineHeight: size * 0.5 }}>
          {profile.displayName.slice(0, 1).toUpperCase()}
        </T>
      )}
    </View>
  );
}

function ProfileGrid({ profiles, onPick, busyId }: { profiles: PublicProfile[]; onPick: (p: PublicProfile) => void; busyId?: string }) {
  const t = useTheme();
  const size = t.isTV ? t.s(150) : t.wide ? 120 : 96;
  return (
    <View style={{ alignItems: 'center', gap: t.space.lg }}>
      <T variant="title" center>
        Who's watching?
      </T>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: t.isTV ? t.s(36) : 20 }}>
        {profiles.map((p, i) => (
          <Focusable key={p.id} onPress={() => onPick(p)} hasTVPreferredFocus={i === 0} ring={false} focusScale={t.isTV ? 1.12 : 1} style={{ alignItems: 'center', gap: t.space.sm, width: size + 16 }}>
            {({ focused }) => (
              <>
                <View style={{ borderRadius: size, borderWidth: t.s(4), borderColor: focused ? t.colors.primary : 'transparent', padding: 2 }}>
                  <Avatar profile={p} size={size} />
                  {busyId === p.id ? (
                    <View style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center' }}>
                      <ActivityIndicator color="#fff" />
                    </View>
                  ) : null}
                  {p.hasPin ? (
                    <View style={{ position: 'absolute', bottom: 2, right: 2, backgroundColor: t.colors.surface, borderRadius: 999, padding: 4 }}>
                      <Icon name="lock-closed" size={t.isTV ? t.s(16) : 12} color={t.colors.textMuted} />
                    </View>
                  ) : null}
                </View>
                <T weight={focused ? '800' : '600'} tone={focused ? 'default' : 'muted'} numberOfLines={1} center>
                  {p.displayName}
                </T>
              </>
            )}
          </Focusable>
        ))}
      </View>
    </View>
  );
}

/** TV link-code sign-in: show a code, poll every 3 s until a signed-in phone/browser approves it. */
function LinkCodePanel({ onLinked }: { onLinked: (auth: { token: string; user: NonNullable<import('@/api/types').LinkPollResponse['user']> }) => Promise<void> }) {
  const t = useTheme();
  const { api, info, server } = useSession();
  const [code, setCode] = useState<LinkCodeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  const request = useCallback(async () => {
    if (!api) return null;
    setError(null);
    try {
      const c = await api.linkRequest();
      setCode(c);
      return c;
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not get a code');
      return null;
    }
  }, [api]);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    (async () => {
      const c = await request();
      if (!c || !api) return;
      const poll = async () => {
        if (!alive) return;
        try {
          const r = await api.linkPoll(c.pollToken);
          if (!alive) return;
          if (r.status === 'linked' && r.token && r.user) {
            await onLinked({ token: r.token, user: r.user });
            return;
          }
          if (r.status === 'expired' || new Date(c.expiresAt).getTime() < Date.now()) {
            setNonce((n) => n + 1);
            return;
          }
        } catch {
          /* transient — keep polling */
        }
        timer = setTimeout(poll, 3000);
      };
      timer = setTimeout(poll, 3000);
    })();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, nonce]);

  const base = (info?.publicUrl ?? server?.url ?? '').replace(/\/+$/, '');
  return (
    <View style={{ width: '100%', alignItems: 'center', gap: t.space.lg, padding: t.space.xl, borderRadius: t.radius * 1.4, backgroundColor: t.alpha(t.colors.surface, 0.9), borderWidth: 1, borderColor: t.colors.border }}>
      <T variant="heading" center>
        Sign in with your phone or computer
      </T>
      <T tone="muted" center>
        Go to{' '}
        <T weight="800" tone="primary">
          {base}/link
        </T>{' '}
        — or open the app on your phone and choose{' '}
        <T weight="800">Settings › Link a TV</T> — then enter:
      </T>
      {code ? (
        <View style={{ flexDirection: 'row', gap: t.space.sm }}>
          {code.code.split('').map((ch, i) => (
            <View key={i} style={{ minWidth: t.isTV ? t.s(84) : 52, paddingVertical: t.space.md, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.background, borderWidth: 2, borderColor: t.alpha(t.colors.primary, 0.6), alignItems: 'center' }}>
              <T variant="hero" style={{ fontSize: t.isTV ? t.s(64) : 40, lineHeight: t.isTV ? t.s(76) : 48, fontVariant: ['tabular-nums'] }}>
                {ch}
              </T>
            </View>
          ))}
        </View>
      ) : (
        <ActivityIndicator color={t.colors.primary} size="large" />
      )}
      {error ? <T tone="danger">{error}</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
        <ActivityIndicator color={t.colors.textMuted} size="small" />
        <T variant="small" tone="muted">
          Waiting for approval…
        </T>
      </View>
      <Button label="New code" icon="refresh" variant="secondary" size="sm" onPress={() => setNonce((n) => n + 1)} hasTVPreferredFocus />
    </View>
  );
}
