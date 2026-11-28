/** Podcasts: directory search (or paste a feed URL), subscribe, and manage subscriptions. */
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Keyboard, RefreshControl, ScrollView, View } from 'react-native';
import type { PodcastSearchResult, PodcastSubscription } from '@/api/types';
import { invalidate } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { Input } from '@/components/Input';
import { OptionSheet } from '@/components/OptionSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDay, formatTime } from '@/utils/format';

const msg = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

export default function PodcastsScreen() {
  const t = useTheme();
  const api = useApi();
  const [subs, setSubs] = useState<PodcastSubscription[] | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PodcastSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PodcastSubscription | null>(null);

  /** Phones only (a TV has no files to pick): subscribe to every feed in an OPML export from another podcast app. */
  const importOpml = async () => {
    setError(null);
    setNotice(null);
    const pick = await DocumentPicker.getDocumentAsync({ type: ['text/x-opml', 'text/xml', 'application/xml', '*/*'], copyToCacheDirectory: true }).catch(() => null);
    const asset = pick && !pick.canceled ? pick.assets[0] : null;
    if (!asset) return;
    setBusy('opml');
    try {
      const text = await new File(asset.uri).text();
      const r = await api.importOpml(text);
      setNotice(`Imported ${r.added} podcast${r.added === 1 ? '' : 's'}${r.skipped ? `, ${r.skipped} already subscribed` : ''}${r.failed.length ? `, ${r.failed.length} couldn't be added` : ''}.`);
      await loadSubs();
    } catch (e) {
      setError(msg(e, 'Could not import that OPML file'));
    } finally {
      setBusy(null);
    }
  };

  const loadSubs = useCallback(async () => {
    try {
      setSubs(await api.podcasts());
    } catch (e) {
      setSubs((s) => s ?? []);
      setError(msg(e, 'Could not load your podcasts'));
    }
  }, [api]);
  useEffect(() => {
    void loadSubs();
  }, [loadSubs]);

  const search = async () => {
    const term = q.trim();
    if (!term) return;
    Keyboard.dismiss();
    setSearching(true);
    setError(null);
    try {
      setResults(await api.searchPodcasts(term));
    } catch (e) {
      setResults(null);
      setError(msg(e, 'Search failed'));
    } finally {
      setSearching(false);
    }
  };

  const act = async (key: string, fn: () => Promise<void>, fallback: string) => {
    setBusy(key);
    setError(null);
    setNotice(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e, fallback));
    } finally {
      setBusy(null);
    }
  };

  const subscribe = (feedUrl: string, title?: string) =>
    act(
      `sub:${feedUrl}`,
      async () => {
        const sub = await api.subscribePodcast(feedUrl, false);
        setSubs((s) => [sub, ...(s ?? []).filter((x) => x.id !== sub.id)]);
        setNotice(`Subscribed to ${sub.title || title || 'podcast'}`);
        invalidate('libraries');
        invalidate('home');
      },
      'Could not subscribe',
    );

  const toggleAuto = (sub: PodcastSubscription) =>
    act(
      `auto:${sub.id}`,
      async () => {
        setSubs((s) => s?.map((x) => (x.id === sub.id ? { ...x, autoDownload: !sub.autoDownload } : x)) ?? s);
        try {
          const updated = await api.updatePodcast(sub.id, { autoDownload: !sub.autoDownload });
          setSubs((s) => s?.map((x) => (x.id === sub.id ? updated : x)) ?? s);
        } catch (e) {
          setSubs((s) => s?.map((x) => (x.id === sub.id ? sub : x)) ?? s);
          throw e;
        }
      },
      'Could not save',
    );

  const refresh = (sub: PodcastSubscription) =>
    act(
      `refresh:${sub.id}`,
      async () => {
        await api.refreshPodcast(sub.id);
        await loadSubs();
        invalidate(`children:${sub.itemId}`);
        setNotice(`Checked ${sub.title} for new episodes`);
      },
      'Could not refresh',
    );

  const unsubscribe = (sub: PodcastSubscription) =>
    act(
      `del:${sub.id}`,
      async () => {
        await api.unsubscribePodcast(sub.id);
        setSubs((s) => s?.filter((x) => x.id !== sub.id) ?? s);
        invalidate('home');
      },
      'Could not unsubscribe',
    );

  const subscribedFeeds = new Set((subs ?? []).map((s) => s.feedUrl));
  const art = t.isTV ? t.s(72) : 56;

  return (
    <Screen>
      <ScreenHeader title="Podcasts" />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, alignItems: t.isTV ? 'center' : undefined }}
        refreshControl={t.isTV ? undefined : <RefreshControl refreshing={refreshing} onRefresh={async () => { setRefreshing(true); await loadSubs(); setRefreshing(false); }} tintColor={t.colors.primary} />}
      >
        <View style={{ width: '100%', maxWidth: t.isTV ? t.s(900) : 720, gap: t.space.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space.sm }}>
            <View style={{ flex: 1 }}>
              <Input value={q} onChangeText={setQ} placeholder="Search podcasts or paste a feed URL" icon="search" autoCapitalize="none" autoCorrect={false} returnKeyType="search" onSubmitEditing={() => void search()} />
            </View>
            {isUrl(q) ? (
              <Button label="Subscribe" icon="add" onPress={() => void subscribe(q.trim())} loading={busy === `sub:${q.trim()}`} hasTVPreferredFocus />
            ) : (
              <Button label="Search" icon="search" onPress={() => void search()} loading={searching} disabled={!q.trim()} hasTVPreferredFocus />
            )}
          </View>

          {!t.isTV ? (
            <Button label="Import OPML" icon="cloud-upload-outline" variant="ghost" size="sm" onPress={() => void importOpml()} loading={busy === 'opml'} accessibilityLabel="Import podcasts from an OPML file" />
          ) : null}

          {notice ? (
            <View style={{ flexDirection: 'row', gap: t.space.sm, alignItems: 'center' }}>
              <Icon name="checkmark-circle" color={t.colors.success} />
              <T tone="success" weight="700" style={{ flex: 1 }}>{notice}</T>
            </View>
          ) : null}
          {error ? <T tone="danger" weight="600">{error}</T> : null}

          {results ? (
            <View style={{ gap: t.space.xs }}>
              <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                <T variant="caption" tone="muted" style={{ flex: 1, textTransform: 'uppercase' }}>
                  {results.length ? `Results for “${q.trim()}”` : `Nothing found for “${q.trim()}”`}
                </T>
                <Button label="Clear" variant="ghost" size="sm" onPress={() => setResults(null)} />
              </View>
              {results.map((r) => {
                const subscribed = subscribedFeeds.has(r.feedUrl);
                return (
                  <View key={r.feedUrl} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
                    <View style={{ width: art, height: art, borderRadius: 8, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                      {r.imageUrl ? <Img path={r.imageUrl} width={art} style={{ width: '100%', height: '100%' }} /> : <Icon name="mic" color={t.colors.textMuted} />}
                    </View>
                    <View style={{ flex: 1 }}>
                      <T weight="700" numberOfLines={2}>{r.title}</T>
                      <T variant="small" tone="muted" numberOfLines={1}>{[r.author, r.genre].filter(Boolean).join(' · ')}</T>
                    </View>
                    <Button label={subscribed ? 'Subscribed' : 'Subscribe'} icon={subscribed ? 'checkmark' : 'add'} size="sm" variant={subscribed ? 'secondary' : 'primary'} disabled={subscribed} loading={busy === `sub:${r.feedUrl}`} onPress={() => void subscribe(r.feedUrl, r.title)} />
                  </View>
                );
              })}
            </View>
          ) : null}

          <T variant="caption" tone="muted" style={{ textTransform: 'uppercase', marginTop: t.space.md }}>
            Your subscriptions
          </T>
          {!subs ? <ActivityIndicator color={t.colors.primary} /> : null}
          {subs && !subs.length ? <T tone="muted">You’re not subscribed to any podcasts yet. Search above to find some.</T> : null}
          {subs?.map((s) => (
            <View key={s.id} style={{ gap: t.space.sm, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
              <Focusable onPress={() => router.push(`/item/${s.itemId}` as never)} focusScale={t.isTV ? 1.02 : 1} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, borderRadius: t.radius }} accessibilityLabel={`Open ${s.title}`}>
                <View style={{ width: art, height: art, borderRadius: 8, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                  {s.imageUrl ? <Img path={s.imageUrl} width={art} style={{ width: '100%', height: '100%' }} /> : <Icon name="mic" color={t.colors.textMuted} />}
                </View>
                <View style={{ flex: 1 }}>
                  <T weight="700" numberOfLines={2}>{s.title}</T>
                  <T variant="small" tone="muted" numberOfLines={1}>
                    {s.episodeCount} episodes{s.lastRefreshAt ? ` · checked ${formatDay(s.lastRefreshAt)} ${formatTime(s.lastRefreshAt)}` : ''}
                  </T>
                  {s.lastError ? <T variant="small" tone="danger" numberOfLines={2}>{s.lastError}</T> : null}
                </View>
                <Icon name="chevron-forward" color={t.colors.textMuted} />
              </Focusable>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm, alignItems: 'center' }}>
                <Button
                  label={s.autoDownload ? 'Auto-download on' : 'Auto-download off'}
                  icon={s.autoDownload ? 'cloud-download' : 'cloud-download-outline'}
                  size="sm"
                  variant="secondary"
                  onPress={() => void toggleAuto(s)}
                  loading={busy === `auto:${s.id}`}
                  accessibilityLabel={`Automatically download new episodes: ${s.autoDownload ? 'on' : 'off'}`}
                />
                <Button label="Refresh" icon="refresh" size="sm" variant="secondary" onPress={() => void refresh(s)} loading={busy === `refresh:${s.id}`} />
                <Button label="Unsubscribe" icon="trash-outline" size="sm" variant="ghost" onPress={() => setConfirm(s)} loading={busy === `del:${s.id}`} />
              </View>
            </View>
          ))}
        </View>
      </ScrollView>
      <OptionSheet
        visible={!!confirm}
        title={confirm ? `Unsubscribe from “${confirm.title}”?` : undefined}
        options={[
          { key: 'yes', label: 'Unsubscribe', icon: 'trash-outline', destructive: true },
          { key: 'no', label: 'Cancel', icon: 'close' },
        ]}
        onSelect={(k) => {
          const s = confirm;
          setConfirm(null);
          if (k === 'yes' && s) void unsubscribe(s);
        }}
        onClose={() => setConfirm(null)}
      />
    </Screen>
  );
}
