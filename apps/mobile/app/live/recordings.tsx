import React, { useEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import type { Recording, RecordingStatus } from '@/api/types';
import { useQuery } from '@/api/useQuery';
import { Button } from '@/components/Button';
import { Chip } from '@/components/Chip';
import { Focusable } from '@/components/Focusable';
import { Icon } from '@/components/Icon';
import { Screen, ScreenHeader } from '@/components/Screen';
import { EmptyState, ErrorState, Loading } from '@/components/States';
import { T } from '@/components/Text';
import { useApi } from '@/state/session';
import { useTheme } from '@/theme';
import { formatBytes, formatDay, formatTime } from '@/utils/format';
import { on } from '@/utils/events';
import { playItem } from '@/utils/nav';

const GROUPS: { status: RecordingStatus; title: string }[] = [
  { status: 'recording', title: 'Recording now' },
  { status: 'scheduled', title: 'Scheduled' },
  { status: 'completed', title: 'Recorded' },
  { status: 'failed', title: 'Failed' },
];

export default function RecordingsScreen() {
  const t = useTheme();
  const api = useApi();
  const recs = useQuery('dvr:recordings', (a) => a.recordings());
  const rules = useQuery('dvr:rules', (a) => a.rules());
  const [tab, setTab] = useState<'recordings' | 'rules'>('recordings');

  const setRecs = recs.setData;
  useEffect(
    () =>
      on('recording', (r) =>
        setRecs((prev) => {
          const list = prev ?? [];
          return list.some((x) => x.id === r.id) ? list.map((x) => (x.id === r.id ? r : x)) : [r, ...list];
        }),
      ),
    [setRecs],
  );

  const grouped = useMemo(() => {
    const list = (recs.data ?? []).filter((r) => r.status !== 'cancelled');
    return GROUPS.map((g) => ({ ...g, items: list.filter((r) => r.status === g.status).sort((a, b) => (g.status === 'completed' ? b.start.localeCompare(a.start) : a.start.localeCompare(b.start))) })).filter((g) => g.items.length);
  }, [recs.data]);

  const remove = (r: Recording) => {
    const doIt = async () => {
      recs.setData((prev) => prev?.filter((x) => x.id !== r.id));
      try {
        await api.deleteRecording(r.id);
      } catch {
        void recs.refresh();
      }
    };
    if (t.isTV) return void doIt();
    Alert.alert(r.status === 'completed' ? 'Delete recording?' : 'Cancel recording?', r.title, [
      { text: 'Keep', style: 'cancel' },
      { text: r.status === 'completed' ? 'Delete' : 'Cancel recording', style: 'destructive', onPress: doIt },
    ]);
  };

  return (
    <Screen>
      <ScreenHeader title="Recordings" />
      <View style={{ flexDirection: 'row', gap: t.space.sm, paddingHorizontal: t.space.gutter, paddingBottom: t.space.sm }}>
        <Chip label="Recordings" selected={tab === 'recordings'} onPress={() => setTab('recordings')} hasTVPreferredFocus />
        <Chip label="Series rules" selected={tab === 'rules'} onPress={() => setTab('rules')} />
      </View>
      {tab === 'recordings' ? (
        recs.loading && !recs.data ? (
          <Loading />
        ) : recs.error && !recs.data ? (
          <ErrorState error={recs.error} onRetry={recs.refresh} />
        ) : !grouped.length ? (
          <EmptyState icon="recording-outline" title="No recordings" message="Open the TV guide and choose Record on any programme." />
        ) : (
          <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl * 2, gap: t.space.lg }} refreshControl={t.isTV ? undefined : <RefreshControl refreshing={recs.refreshing} onRefresh={recs.refresh} tintColor={t.colors.primary} />}>
            {grouped.map((g) => (
              <View key={g.status} style={{ gap: t.space.sm }}>
                <T variant="heading">{g.title}</T>
                {g.items.map((r) => (
                  <View key={r.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                    <Focusable
                      onPress={() => (r.itemId ? playItem(r.itemId) : undefined)}
                      containerStyle={{ flex: 1 }}
                      focusScale={t.isTV ? 1.02 : 1}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}
                    >
                      <Icon name={r.status === 'recording' ? 'radio-button-on' : r.status === 'completed' ? 'play-circle' : r.status === 'failed' ? 'alert-circle' : 'time-outline'} color={r.status === 'recording' || r.status === 'failed' ? t.colors.danger : t.colors.primary} />
                      <View style={{ flex: 1 }}>
                        <T weight="700" numberOfLines={1}>
                          {r.title}
                        </T>
                        <T variant="small" tone="muted" numberOfLines={1}>
                          {r.channelName} · {formatDay(r.start)} {formatTime(r.start)}–{formatTime(r.end)}
                          {r.sizeBytes ? ` · ${formatBytes(r.sizeBytes)}` : ''}
                        </T>
                        {r.error ? (
                          <T variant="small" tone="danger" numberOfLines={2}>
                            {r.error}
                          </T>
                        ) : null}
                      </View>
                    </Focusable>
                    <Button icon={r.status === 'completed' || r.status === 'failed' ? 'trash-outline' : 'close'} variant="secondary" onPress={() => remove(r)} accessibilityLabel="Remove" />
                  </View>
                ))}
              </View>
            ))}
          </ScrollView>
        )
      ) : (
        <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xxl, gap: t.space.sm }}>
          {!rules.data?.length ? <EmptyState icon="repeat" title="No series rules" message="Choose Record series on a programme to record every episode." /> : null}
          {rules.data?.map((rule) => (
            <View key={rule.id} style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}>
              <Icon name="repeat" color={t.colors.primary} />
              <View style={{ flex: 1 }}>
                <T weight="700">“{rule.titleMatch}”</T>
                <T variant="small" tone="muted">
                  {rule.channelId ? 'This channel' : 'Any channel'} · {rule.newOnly ? 'New episodes only' : 'All airings'}
                  {rule.keepLatest ? ` · keep ${rule.keepLatest}` : ''}
                  {!rule.enabled ? ' · paused' : ''}
                </T>
              </View>
              <Button
                icon="trash-outline"
                variant="secondary"
                accessibilityLabel="Delete rule"
                onPress={async () => {
                  rules.setData((prev) => prev?.filter((x) => x.id !== rule.id));
                  await api.deleteRule(rule.id).catch(() => rules.refresh());
                }}
              />
            </View>
          ))}
        </ScrollView>
      )}
    </Screen>
  );
}
