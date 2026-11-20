/** Programme details + actions (watch live, catch-up, record, record series). */
import React, { useState } from 'react';
import { Modal, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { Channel, Program } from '@/api/types';
import { useApi, useCapabilities } from '@/state/session';
import { useTheme } from '@/theme';
import { formatDay, formatTime, isAiring, programProgress } from '@/utils/format';
import { playChannel } from '@/utils/nav';
import { Button } from './Button';
import { Img } from './Img';
import { ProgressBar } from './ProgressBar';
import { T } from './Text';

export function ProgramSheet({
  program,
  channel,
  onClose,
  onChanged,
}: {
  program: Program | null;
  channel: Channel | null | undefined;
  onClose: () => void;
  /** Called after a recording is created/cancelled so the caller can refresh. */
  onChanged?: (p: Program) => void;
}) {
  const t = useTheme();
  const api = useApi();
  const caps = useCapabilities();
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  if (!program) return null;

  const now = Date.now();
  const start = new Date(program.start).getTime();
  const end = new Date(program.end).getTime();
  const airing = isAiring(program, now);
  const past = end <= now;
  const future = start > now;
  const archiveOk = !!channel?.hasArchive && start > now - (channel.archiveDays || 0) * 86400000;
  const durationMin = Math.round((end - start) / 60000);

  const run = async (key: string, fn: () => Promise<unknown>, success: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg(success);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(null);
    }
  };

  const record = () =>
    run('rec', async () => {
      const r = await api.createRecording({ channelId: program.channelId, programId: program.id });
      onChanged?.({ ...program, recordingId: r.id });
    }, 'Recording scheduled');
  const cancel = () =>
    run('cancel', async () => {
      await api.deleteRecording(program.recordingId!);
      onChanged?.({ ...program, recordingId: null });
    }, 'Recording cancelled');
  const series = () =>
    run('series', () => api.createRule({ titleMatch: program.title, channelId: program.channelId, newOnly: true, keepLatest: null, paddingBeforeMin: 1, paddingAfterMin: 5 }), `Recording every "${program.title}"`);

  const go = (fn: () => void) => {
    onClose();
    fn();
  };

  return (
    <Modal visible transparent animationType={t.isTV ? 'fade' : 'slide'} onRequestClose={onClose} supportedOrientations={['portrait', 'landscape']}>
      <View style={{ flex: 1, justifyContent: t.isTV ? 'center' : 'flex-end', alignItems: t.isTV ? 'center' : 'stretch' }}>
        <Pressable style={{ position: 'absolute', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)' }} onPress={onClose} focusable={false} />
        <View style={{ backgroundColor: t.colors.surface, borderRadius: t.radius * 1.5, borderBottomLeftRadius: t.isTV ? t.radius * 1.5 : 0, borderBottomRightRadius: t.isTV ? t.radius * 1.5 : 0, width: t.isTV ? t.s(720) : undefined, maxHeight: '85%', paddingBottom: insets.bottom + t.space.lg, borderWidth: 1, borderColor: t.colors.border, overflow: 'hidden' }}>
          <ScrollView contentContainerStyle={{ padding: t.space.lg, gap: t.space.md }}>
            <View style={{ flexDirection: 'row', gap: t.space.md, alignItems: 'flex-start' }}>
              {program.iconUrl ? <Img path={program.iconUrl} width={120} style={{ width: t.s(120), height: t.s(80), borderRadius: t.radius / 2 }} /> : null}
              <View style={{ flex: 1, gap: 4 }}>
                <T variant="caption" tone="primary" style={{ textTransform: 'uppercase' }}>
                  {channel?.name ?? ''} · {formatDay(program.start)} {formatTime(program.start)}–{formatTime(program.end)}
                </T>
                <T variant="heading">{program.title}</T>
                {program.subtitle || program.episodeNum ? (
                  <T tone="muted" variant="small">
                    {[program.episodeNum, program.subtitle].filter(Boolean).join(' · ')}
                  </T>
                ) : null}
                <View style={{ flexDirection: 'row', gap: 6, flexWrap: 'wrap' }}>
                  {program.isNew ? <Badge label="NEW" color={t.colors.success} /> : null}
                  {program.category ? <Badge label={program.category} color={t.colors.textMuted} /> : null}
                  {program.recordingId ? <Badge label="● REC" color={t.colors.danger} /> : null}
                  {airing ? <Badge label="ON NOW" color={t.colors.primary} /> : null}
                </View>
              </View>
            </View>
            {airing ? <ProgressBar value={programProgress(program, now)} /> : null}
            {program.description ? <T tone="muted">{program.description}</T> : null}
            {msg ? <T tone="accent" weight="700">{msg}</T> : null}
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.space.sm }}>
              {airing && channel ? <Button label="Watch live" icon="play" onPress={() => go(() => playChannel(channel))} hasTVPreferredFocus /> : null}
              {(airing || past) && archiveOk && channel ? (
                <Button label={airing ? 'Start over' : 'Watch (catch-up)'} icon={airing ? 'refresh' : 'time-outline'} variant={airing ? 'secondary' : 'primary'} onPress={() => go(() => playChannel(channel, { catchupStart: program.start, durationMin }))} hasTVPreferredFocus={!airing} />
              ) : null}
              {caps.dvr && (future || airing) && !program.recordingId ? <Button label="Record" icon="radio-button-on" variant="secondary" onPress={record} loading={busy === 'rec'} hasTVPreferredFocus={future} /> : null}
              {caps.dvr && program.recordingId ? <Button label="Cancel recording" icon="close-circle-outline" variant="secondary" onPress={cancel} loading={busy === 'cancel'} /> : null}
              {caps.dvr && (future || airing) ? <Button label="Record series" icon="repeat" variant="secondary" onPress={series} loading={busy === 'series'} /> : null}
              <Button label="Close" variant="ghost" onPress={onClose} hasTVPreferredFocus={past && !archiveOk} />
            </View>
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

function Badge({ label, color }: { label: string; color: string }) {
  const t = useTheme();
  return (
    <View style={{ borderWidth: 1, borderColor: color, borderRadius: 4, paddingHorizontal: 6, paddingVertical: 1 }}>
      <T variant="caption" color={color}>
        {label}
      </T>
    </View>
  );
}
