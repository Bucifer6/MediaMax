/** Add items to one of the user's playlists, or to a new one. */
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import type { Item } from '@/api/types';
import { invalidate } from '@/api/useQuery';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { Button } from './Button';
import { Focusable } from './Focusable';
import { Icon } from './Icon';
import { Input } from './Input';
import { Sheet } from './Sheet';
import { T } from './Text';

export function AddToPlaylistSheet({
  visible,
  title,
  getItemIds,
  onClose,
}: {
  visible: boolean;
  /** What is being added (shown under the title). */
  title?: string;
  /** Resolved lazily (e.g. all tracks of an album). */
  getItemIds: () => Promise<string[]> | string[];
  onClose: () => void;
}) {
  const t = useTheme();
  const api = useApi();
  const [lists, setLists] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState('');

  useEffect(() => {
    if (!visible) return;
    setError(null);
    setDone(null);
    setLists(null);
    let alive = true;
    api
      .playlists()
      .then((l) => alive && setLists(l))
      .catch((e) => {
        if (!alive) return;
        setLists([]);
        setError(e instanceof Error ? e.message : 'Could not load playlists');
      });
    return () => {
      alive = false;
    };
  }, [visible, api]);

  // Close shortly after a success so the confirmation is visible.
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(onClose, 1100);
    return () => clearTimeout(timer);
  }, [done, onClose]);

  const run = async (key: string, fn: (ids: string[]) => Promise<string>) => {
    setBusy(key);
    setError(null);
    try {
      const ids = await getItemIds();
      if (!ids.length) throw new Error('Nothing to add');
      const name = await fn(ids);
      invalidate('playlists');
      invalidate('children:');
      setDone(`Added to ${name}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not add to playlist');
    } finally {
      setBusy(null);
    }
  };

  const addTo = (pl: Item) =>
    run(pl.id, async (ids) => {
      await api.addToPlaylist(pl.id, ids);
      return pl.title;
    });

  const create = () => {
    const name = newTitle.trim();
    if (!name) return;
    void run('__new', async (ids) => {
      const pl = await api.createPlaylist(name, ids);
      setNewTitle('');
      return pl.title;
    });
  };

  return (
    <Sheet visible={visible} title="Add to playlist" subtitle={title} onClose={onClose}>
      {done ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, paddingVertical: t.space.md }}>
          <Icon name="checkmark-circle" color={t.colors.success} />
          <T tone="success" weight="700">
            {done}
          </T>
        </View>
      ) : null}
      {error ? (
        <T tone="danger" weight="600">
          {error}
        </T>
      ) : null}
      {!lists ? <ActivityIndicator color={t.colors.primary} style={{ marginVertical: t.space.md }} /> : null}
      {lists?.map((pl, i) => (
        <Focusable
          key={pl.id}
          onPress={() => void addTo(pl)}
          disabled={!!busy || !!done}
          hasTVPreferredFocus={i === 0}
          focusScale={t.isTV ? 1.03 : 1}
          style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, paddingVertical: t.isTV ? t.s(12) : 12, paddingHorizontal: t.space.sm, borderRadius: t.radius }}
        >
          <Icon name="list" color={t.colors.primary} />
          <View style={{ flex: 1 }}>
            <T weight="600" numberOfLines={1}>
              {pl.title}
            </T>
            <T variant="small" tone="muted">
              {pl.childCount} {pl.childCount === 1 ? 'item' : 'items'}
            </T>
          </View>
          {busy === pl.id ? <ActivityIndicator color={t.colors.primary} /> : <Icon name="add" color={t.colors.textMuted} />}
        </Focusable>
      ))}
      {lists && !lists.length && !error ? <T tone="muted">You have no playlists yet. Create one below.</T> : null}
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: t.space.sm, marginTop: t.space.sm }}>
        <View style={{ flex: 1 }}>
          <Input label="New playlist" value={newTitle} onChangeText={setNewTitle} placeholder="Playlist name" returnKeyType="done" onSubmitEditing={create} maxLength={120} />
        </View>
        <Button label="Create" icon="add" onPress={create} loading={busy === '__new'} disabled={!newTitle.trim() || !!busy || !!done} hasTVPreferredFocus={!!lists && !lists.length} />
      </View>
    </Sheet>
  );
}
