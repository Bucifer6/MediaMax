import React, { useEffect, useMemo, useState } from 'react';
import { Alert, RefreshControl, ScrollView, View } from 'react-native';
import type { Recording, RecordingRule, RecordingStatus } from '@/api/types';
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

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Rule filters (priority, weekdays, time window, repeats) in one line. */
function ruleFilters(rule: RecordingRule): string {
  const parts: string[] = [`Priority ${rule.priority}`];
  const days = rule.daysOfWeek;
  if (days && days.length && days.length < 7) {
    const sorted = [...days].sort((a, b) => a - b);
    const key = sorted.join(',');
    parts.push(key === '1,2,3,4,5' ? 'Weekdays' : key === '0,6' ? 'Weekends' : sorted.map((d) => DAY_NAMES[d] ?? '?').join(', '));
  } else parts.push('Any day');
  if (rule.timeFrom || rule.timeTo) parts.push(`${rule.timeFrom ?? '00:00'}–${rule.timeTo ?? '24:00'}`);
  else parts.push('Any time');
  parts.push(rule.skipRepeats ? 'Skips repeats' : 'Records repeats');
  return parts.join(' · ');
}

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
  const [prioritizing, setPrioritizing] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  /** PATCH priority 100: always wins a tuner conflict. The server re-plans, so reload the list. */
  const makeTopPriority = async (r: Recording) => {
    setPrioritizing(r.id);
    setActionError(null);
    try {
      await api.updateRecording(r.id, { priority: 100 });
      await recs.refresh();
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Could not change the priority');
    } finally {
      setPrioritizing(null);
    }
  };

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
            {actionError ? <T tone="danger">{actionError}</T> : null}
            {grouped.map((g) => (
              <View key={g.status} style={{ gap: t.space.sm }}>
                <T variant="heading">{g.title}</T>
                {g.items.map((r) => (
                  <View key={r.id} style={{ gap: t.space.xs }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                      <Focusable
                        onPress={() => (r.itemId ? playItem(r.itemId) : undefined)}
                        containerStyle={{ flex: 1 }}
                        focusScale={t.isTV ? 1.02 : 1}
                        style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.md, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.colors.surface }}
                      >
                        <Icon name={r.status === 'recording' ? 'radio-button-on' : r.status === 'completed' ? 'play-circle' : r.status === 'failed' ? 'alert-circle' : 'time-outline'} color={r.status === 'recording' || r.status === 'failed' ? t.colors.danger : t.colors.primary} />
                        <View style={{ flex: 1 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.space.sm }}>
                            <T weight="700" numberOfLines={1} style={{ flexShrink: 1 }}>
                              {r.title}
                            </T>
                            {r.conflict ? <Badge label="Conflict" color={t.colors.danger} /> : null}
                            {r.priority >= 100 && r.status === 'scheduled' ? <Badge label="Top priority" color={t.colors.primary} /> : null}
                          </View>
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
                    {r.conflict && r.status === 'scheduled' ? (
                      <View style={{ gap: t.space.sm, padding: t.space.md, borderRadius: t.radius, backgroundColor: t.alpha(t.colors.danger, 0.1), borderWidth: 1, borderColor: t.alpha(t.colors.danger, 0.35) }}>
                        <T variant="small">
                          Not enough tuners or provider connections are free at this time, so this won't record unless another recording is cancelled
                          {r.priority < 100 ? ' or you make it top priority (another recording may then miss out instead).' : '. Other top-priority recordings already take every slot.'}
                        </T>
                        {r.priority < 100 ? <Button label="Make top priority" icon="arrow-up-circle-outline" size="sm" onPress={() => void makeTopPriority(r)} loading={prioritizing === r.id} /> : null}
                      </View>
                    ) : null}
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
                <T variant="small" tone="muted">
                  {ruleFilters(rule)}
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

function Badge({ label, color }: { label: string; color: string }) {
  const t = useTheme();
  return (
    <View style={{ backgroundColor: t.alpha(color, 0.18), borderRadius: 999, paddingHorizontal: t.isTV ? t.s(10) : 8, paddingVertical: 2 }}>
      <T variant="caption" weight="800" color={color} style={{ letterSpacing: 0 }}>
        {label}
      </T>
    </View>
  );
}
