import { router } from 'expo-router';
import React from 'react';
import { Alert, FlatList, View } from 'react-native';
import { Button } from '@/components/Button';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Img } from '@/components/Img';
import { ProgressBar } from '@/components/ProgressBar';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState } from '@/components/States';
import { useTabBarSpace } from '@/components/TabBar';
import { T } from '@/components/Text';
import { qualityLabel, useDownloads, type DownloadRecord } from '@/state/downloads';
import { useMusic } from '@/state/music';
import { useCapabilities, useSession } from '@/state/session';
import { useTheme } from '@/theme';
import { formatBytes, itemSubtitle } from '@/utils/format';
import { playItem } from '@/utils/nav';

export default function DownloadsScreen() {
  const t = useTheme();
  const caps = useCapabilities();
  const { retry: reconnect, server } = useSession();
  const downloads = useDownloads();
  const music = useMusic();
  const bottom = useTabBarSpace();
  const list = [...downloads.records].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const open = (r: DownloadRecord) => {
    if (r.state !== 'done') return;
    if (r.item.type === 'track') {
      const tracks = list.filter((x) => x.state === 'done' && x.item.type === 'track').map((x) => x.item);
      music.playQueue(tracks, tracks.findIndex((x) => x.id === r.id));
      return;
    }
    playItem(r.id, { startMs: r.positionMs > 0 && r.item.durationMs && r.positionMs < r.item.durationMs * 0.95 ? r.positionMs : undefined });
  };

  const remove = (r: DownloadRecord) =>
    Alert.alert('Remove download?', r.item.title, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => downloads.remove(r.id) },
    ]);

  return (
    <Screen>
      <ScreenHeader title="Downloads" back={false} subtitle={downloads.totalBytes ? `${formatBytes(downloads.totalBytes)} on this device` : undefined} />
      {caps.offline ? (
        <View style={{ marginHorizontal: t.space.gutter, marginBottom: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.warning, 0.15), flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
          <Icon name="cloud-offline-outline" color={t.colors.warning} />
          <T variant="small" style={{ flex: 1 }}>
            {server?.name ?? 'Your server'} is unreachable. Your downloads still play offline.
          </T>
          <Button label="Retry" size="sm" variant="secondary" onPress={reconnect} />
        </View>
      ) : null}
      {!list.length ? (
        <EmptyState icon="download-outline" title="No downloads" message={caps.downloads ? 'Tap the download button on a movie, episode, season or album to watch it offline.' : 'Downloads are not enabled for your account.'} />
      ) : (
        <FlatList
          data={list}
          keyExtractor={(r) => r.id}
          contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: bottom, gap: t.space.sm }}
          renderItem={({ item: r }) => {
            const square = r.item.type === 'track' || r.item.type === 'album';
            const w = square ? 64 : 112;
            const h = square ? 64 : 63;
            return (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                <Focusable onPress={() => open(r)} onLongPress={() => r.state === 'done' && router.push(`/item/${r.id}` as never)} containerStyle={{ flex: 1 }} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.sm, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
                  <View style={{ width: w, height: h, borderRadius: t.radius / 2, overflow: 'hidden', backgroundColor: t.colors.surfaceAlt, alignItems: 'center', justifyContent: 'center' }}>
                    {r.posterUri || r.backdropUri ? <Img path={(square ? r.posterUri : r.backdropUri ?? r.posterUri)!} style={{ width: '100%', height: '100%' }} /> : <Icon name="film-outline" color={t.colors.textMuted} />}
                    {r.state === 'done' ? (
                      <View style={{ position: 'absolute', backgroundColor: 'rgba(0,0,0,0.45)', borderRadius: 999, padding: 6 }}>
                        <Icon name="play" size={16} color="#fff" />
                      </View>
                    ) : null}
                  </View>
                  <View style={{ flex: 1, gap: 3 }}>
                    <T weight="700" numberOfLines={1}>
                      {r.item.type === 'episode' ? r.item.grandparentTitle ?? r.item.title : r.item.title}
                    </T>
                    <T variant="small" tone="muted" numberOfLines={1}>
                      {r.item.type === 'episode' ? `${itemSubtitle(r.item).split(' · ').slice(1).join(' · ')} · ${r.item.title}` : itemSubtitle(r.item)}
                    </T>
                    {r.state === 'downloading' || r.state === 'queued' ? (
                      <>
                        <ProgressBar value={r.progress} indeterminate={r.state === 'downloading' && !r.total} track={t.alpha(t.colors.text, 0.12)} />
                        <T variant="caption" tone="muted">
                          {r.state === 'queued'
                            ? `Waiting…${r.quality && r.quality !== 'original' ? ` · ${qualityLabel(r.quality)}` : ''}`
                            : r.total
                              ? `${formatBytes(r.bytes)} of ${formatBytes(r.total)}`
                              : `${formatBytes(r.bytes) || '0 B'} downloaded${r.quality && r.quality !== 'original' ? ` · converting to ${qualityLabel(r.quality)}` : ''}`}
                        </T>
                      </>
                    ) : r.state === 'error' ? (
                      <T variant="caption" tone="danger">
                        {r.error ?? 'Failed'}
                      </T>
                    ) : (
                      <T variant="caption" tone="muted">
                        {formatBytes(r.bytes)}
                        {r.quality && r.quality !== 'original' ? ` · ${qualityLabel(r.quality)}` : ''}
                        {r.pendingSync ? ' · progress will sync' : ''}
                      </T>
                    )}
                  </View>
                </Focusable>
                {r.state === 'error' ? <Button icon="refresh" variant="secondary" onPress={() => downloads.retry(r.id)} accessibilityLabel="Retry" /> : null}
                {r.state === 'downloading' || r.state === 'queued' ? (
                  <Button icon="close" variant="secondary" onPress={() => downloads.cancel(r.id)} accessibilityLabel="Cancel" />
                ) : (
                  <Button icon="trash-outline" variant="secondary" onPress={() => remove(r)} accessibilityLabel="Remove" />
                )}
              </View>
            );
          }}
        />
      )}
    </Screen>
  );
}
