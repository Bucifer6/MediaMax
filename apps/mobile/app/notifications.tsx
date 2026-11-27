/**
 * Notifications (GET /notifications): new episodes of shows the viewer follows, request and issue updates.
 * Opening one marks it read and goes to the episode (or Requests); "Mark all read" clears the count.
 */
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, View } from 'react-native';
import type { AppNotification } from '@/api/types';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Img } from '@/components/Img';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { emit, on } from '@/utils/events';
import { formatDay } from '@/utils/format';

/** Where a notification leads in the app (null: nowhere to go, e.g. issues, which are web only). */
export function notificationTarget(n: Pick<AppNotification, 'kind' | 'itemId' | 'link'>): string | null {
  if (n.link?.startsWith('/requests')) return '/requests';
  if (n.itemId) return `/item/${n.itemId}`;
  if (n.kind === 'new-episode') return '/calendar';
  return null;
}

export default function NotificationsScreen() {
  const t = useTheme();
  const api = useApi();
  const [items, setItems] = useState<AppNotification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<Error | null>(null);

  const load = useCallback(() => {
    api
      .notifications({ limit: 100 })
      .then((r) => {
        setItems(r.items);
        setUnread(r.unread);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))));
  }, [api]);
  useEffect(load, [load]);
  useEffect(() => on('notification', load), [load]);

  const setCount = (n: number) => {
    setUnread(n);
    emit('notification', { unread: n });
  };
  const open = (n: AppNotification) => {
    if (!n.readAt) {
      setItems((cur) => cur?.map((x) => (x.id === n.id ? { ...x, readAt: new Date().toISOString() } : x)) ?? cur);
      void api.markNotificationsRead([n.id]).then((r) => setCount(r.unread)).catch(() => undefined);
    }
    const to = notificationTarget(n);
    if (to) router.push(to as never);
  };
  const markAll = () => {
    setItems((cur) => cur?.map((x) => (x.readAt ? x : { ...x, readAt: new Date().toISOString() })) ?? cur);
    void api.markNotificationsRead().then((r) => setCount(r.unread)).catch(() => undefined);
  };

  const thumb = t.isTV ? t.s(120) : 72;
  return (
    <Screen>
      <ScreenHeader title="Notifications" subtitle={unread ? `${unread} unread` : undefined} />
      {unread ? (
        <View style={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.sm, flexDirection: 'row' }}>
          <Button label="Mark all read" icon="checkmark-done" variant="secondary" size="sm" onPress={markAll} />
        </View>
      ) : null}
      {!items && !error ? (
        <Loading />
      ) : error && !items ? (
        <ErrorState error={error} onRetry={load} />
      ) : !items?.length ? (
        <EmptyState icon="notifications-outline" title="No notifications" message="New episodes of the shows you follow and updates to your requests show up here." />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(n) => n.id}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, gap: t.space.xs }}
          renderItem={({ item: n, index }) => (
            <Focusable
              onPress={() => open(n)}
              hasTVPreferredFocus={index === 0 && !unread}
              focusScale={t.isTV ? 1.01 : 1}
              style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: n.readAt ? 'transparent' : t.alpha(t.colors.primary, 0.1) }}
              accessibilityLabel={`${n.readAt ? '' : 'Unread: '}${n.title}`}
            >
              <View style={{ width: thumb, height: Math.round((thumb * 9) / 16), borderRadius: t.radius * 0.6, overflow: 'hidden', backgroundColor: t.colors.surface }}>
                {n.imageUrl ? <Img path={n.imageUrl} width={thumb * 2} style={{ width: '100%', height: '100%' }} /> : null}
              </View>
              <View style={{ flex: 1, gap: 2 }}>
                <T weight={n.readAt ? '600' : '800'} numberOfLines={1}>{n.title}</T>
                {n.body ? <T variant="small" tone="muted" numberOfLines={2}>{n.body}</T> : null}
                <T variant="caption" tone="muted">{formatDay(n.createdAt)}</T>
              </View>
              {!n.readAt ? <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: t.colors.primary }} /> : null}
            </Focusable>
          )}
        />
      )}
    </Screen>
  );
}
