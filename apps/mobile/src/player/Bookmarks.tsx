/**
 * Audiobook / podcast bookmarks in the now-playing screen: the bookmarks of
 * every part of the current book that is in the queue, tap to jump there, add
 * one at the current position with an optional note.
 * API: GET/POST /items/:id/bookmarks, DELETE /items/:id/bookmarks/:bookmarkId.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Bookmark, Item } from '@/api/types';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Input } from '@/components/Input';
import { T } from '@/components/Text';
import { useMusic } from '@/state/music';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatClock } from '@/utils/format';
import { isSpokenAudio } from '@/utils/library';

/** Parts of the current book in the queue (just the current item for a podcast episode or a loose part). */
function bookParts(queue: Item[], current: Item): Item[] {
  if (current.type !== 'bookpart' || !current.parentId) return [current];
  return queue.filter((q) => q.type === 'bookpart' && q.parentId === current.parentId).slice(0, 100);
}

export function BookmarksPanel() {
  const t = useTheme();
  const api = useApi();
  const m = useMusic();
  const insets = useSafeAreaInsets();
  const cur = m.current;
  const parts = useMemo(() => (cur && isSpokenAudio(cur.type) ? bookParts(m.queue, cur) : []), [m.queue, cur]);
  const key = parts.map((p) => p.id).join(',');
  const [list, setList] = useState<Bookmark[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!key) return setList([]);
    try {
      const all = await Promise.all(key.split(',').map((id) => api.bookmarks(id).catch(() => [] as Bookmark[])));
      setList(all.flat());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not load bookmarks');
    }
  }, [api, key]);

  useEffect(() => {
    setList(null);
    void load();
  }, [load]);

  const order = useMemo(() => new Map(parts.map((p, i) => [p.id, i])), [parts]);
  const titles = useMemo(() => (parts.length > 1 ? new Map(parts.map((p) => [p.id, p.title])) : null), [parts]);
  const sorted = useMemo(() => [...(list ?? [])].sort((a, b) => (order.get(a.itemId) ?? 0) - (order.get(b.itemId) ?? 0) || a.positionMs - b.positionMs), [list, order]);

  if (!cur) return null;

  const add = async () => {
    const positionMs = Math.round(m.positionMs);
    setBusy(true);
    setError(null);
    try {
      const bm = await api.addBookmark(cur.id, { positionMs, note: note.trim() || undefined });
      setList((l) => [...(l ?? []), bm]);
      setNote('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add the bookmark');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (b: Bookmark) => {
    setList((l) => (l ?? []).filter((x) => x.id !== b.id));
    try {
      await api.removeBookmark(b.itemId, b.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not delete the bookmark');
      void load();
    }
  };

  const play = (b: Bookmark) => {
    if (b.itemId === cur.id) {
      m.seek(b.positionMs);
      if (!m.playing) m.toggle();
      return;
    }
    const qi = m.queue.findIndex((q) => q.id === b.itemId);
    if (qi >= 0) m.jumpTo(qi, b.positionMs);
  };

  return (
    <FlatList
      data={sorted}
      keyExtractor={(b) => b.id}
      style={{ flex: 1 }}
      contentContainerStyle={{ paddingBottom: insets.bottom + t.space.lg }}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={
        <View style={{ gap: t.space.sm, marginBottom: t.space.sm }}>
          <T variant="heading" color="#fff">
            Bookmarks
          </T>
          <Input value={note} onChangeText={setNote} placeholder="Note (optional)" maxLength={500} returnKeyType="done" onSubmitEditing={() => void add()} icon="create-outline" style={{ color: '#fff' }} />
          <Button label={`Bookmark ${formatClock(m.positionMs)}`} icon="bookmark-outline" size="sm" onPress={() => void add()} loading={busy} />
          {error ? <T tone="danger">{error}</T> : null}
          {list === null ? <ActivityIndicator color="#fff" /> : null}
        </View>
      }
      ListEmptyComponent={
        list !== null ? (
          <T color="rgba(255,255,255,0.6)" style={{ paddingVertical: t.space.sm }}>
            No bookmarks yet.
          </T>
        ) : undefined
      }
      renderItem={({ item: b }) => (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.xs }}>
          <Focusable
            onPress={() => play(b)}
            focusScale={t.isTV ? 1.02 : 1}
            containerStyle={{ flex: 1 }}
            accessibilityLabel={`Play from ${formatClock(b.positionMs)}`}
            style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.space.sm, paddingHorizontal: t.space.sm, borderRadius: t.radius, backgroundColor: b.itemId === cur.id ? 'rgba(255,255,255,0.08)' : 'transparent' }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minWidth: t.isTV ? t.s(90) : 72 }}>
              <Icon name="play" size={t.isTV ? t.s(14) : 12} color={t.colors.primary} />
              <T variant="small" weight="700" color="#fff" style={{ fontVariant: ['tabular-nums'] }}>
                {formatClock(b.positionMs)}
              </T>
            </View>
            <View style={{ flex: 1 }}>
              <T color={b.note ? '#fff' : 'rgba(255,255,255,0.6)'} numberOfLines={2}>
                {b.note || 'Bookmark'}
              </T>
              {titles?.get(b.itemId) ? (
                <T variant="caption" color="rgba(255,255,255,0.6)" numberOfLines={1}>
                  {titles.get(b.itemId)}
                </T>
              ) : null}
            </View>
          </Focusable>
          <Focusable onPress={() => void remove(b)} ringRadius={999} accessibilityLabel={`Delete bookmark at ${formatClock(b.positionMs)}`} style={{ padding: t.isTV ? t.s(10) : 8, borderRadius: 999 }}>
            {({ focused }) => <Icon name="trash-outline" size={t.isTV ? t.s(22) : 18} color={focused ? t.colors.danger : 'rgba(255,255,255,0.6)'} />}
          </Focusable>
        </View>
      )}
    />
  );
}
