/**
 * Bell with the unread count (GET /notifications?limit=1 for the count, then the live `notification` event).
 * Opens the Notifications screen. Used in the TV top bar and the phone home header.
 */
import { router } from 'expo-router';
import { useEffect, useState } from 'react';
import { AppState, View } from 'react-native';
import { useApi, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { on } from '@/utils/events';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { T } from './Text';

export function useUnreadNotifications(): number {
  const api = useApi();
  const { status } = useSession();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (status !== 'signed-in') return;
    const load = () => void api.notifications({ limit: 1 }).then((r) => setUnread(r.unread)).catch(() => undefined);
    load();
    const offEvt = on('notification', (e) => setUnread(e.unread));
    const app = AppState.addEventListener('change', (s) => s === 'active' && load());
    return () => {
      offEvt();
      app.remove();
    };
  }, [api, status]);
  return unread;
}

export function NotificationBell({ size }: { size?: number }) {
  const t = useTheme();
  const unread = useUnreadNotifications();
  const s = size ?? (t.isTV ? t.s(26) : 24);
  return (
    <Focusable onPress={() => router.push('/notifications' as never)} ringRadius={999} style={{ padding: t.isTV ? t.s(8) : 8 }} accessibilityLabel={unread ? `Notifications, ${unread} unread` : 'Notifications'}>
      <Icon name={unread ? 'notifications' : 'notifications-outline'} size={s} />
      {unread > 0 ? (
        <View style={{ position: 'absolute', top: 2, right: 2, minWidth: s * 0.7, height: s * 0.7, borderRadius: s, paddingHorizontal: 3, backgroundColor: t.colors.primary, alignItems: 'center', justifyContent: 'center' }}>
          <T variant="caption" weight="800" color={t.colors.primaryText}>{unread > 99 ? '99+' : unread}</T>
        </View>
      ) : null}
    </Focusable>
  );
}
