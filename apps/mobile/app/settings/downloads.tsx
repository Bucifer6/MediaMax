import { useState } from 'react';
import { Alert, ScrollView, View } from 'react-native';
import { OptionSheet } from '@/components/OptionSheet';
import { Screen, ScreenHeader } from '@/components/Screen';
import { SettingRow, SettingSection } from '@/components/SettingRow';
import { T } from '@/components/Text';
import { DOWNLOAD_QUALITIES, qualityLabel, useDownloads } from '@/state/downloads';
import { DELETE_AFTER_OPTIONS, STORAGE_LIMIT_OPTIONS, deleteAfterLabel, storageLimitLabel, waitingLabel } from '@/state/smartDownloads';
import { useTheme } from '@/theme';
import { formatBytes } from '@/utils/format';

type Sheet = 'quality' | 'storage' | 'deleteAfter' | null;

/** Download settings: Wi-Fi only, storage limit, default quality, auto-delete, pause / resume, smart rules of this device. */
export default function DownloadSettings() {
  const t = useTheme();
  const d = useDownloads();
  const [sheet, setSheet] = useState<Sheet>(null);
  const s = d.smart;
  const removeRule = (id: string, title: string) =>
    Alert.alert('Stop smart downloads?', `${title}: downloaded episodes stay until you delete them.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Stop', style: 'destructive', onPress: () => void d.setRule({ id: d.rules.find((r) => r.id === id)!.showId }, null) },
    ]);

  return (
    <Screen>
      <ScreenHeader title="Download settings" />
      <ScrollView contentContainerStyle={{ paddingHorizontal: t.space.gutter, paddingBottom: t.space.xl }}>
        <SettingSection title="Transfers">
          <SettingRow icon={s.paused ? 'play-outline' : 'pause-outline'} label={s.paused ? 'Resume all downloads' : 'Pause all downloads'} onPress={s.paused ? d.resumeAll : d.pauseAll} chevron={false} />
          <SettingRow icon="wifi-outline" label="Download on Wi-Fi only" toggle={s.wifiOnly} onToggle={(v) => d.setSmart({ wifiOnly: v })} />
          <SettingRow icon="battery-charging-outline" label="Smart downloads only while charging" toggle={s.chargingOnly} onToggle={(v) => d.setSmart({ chargingOnly: v })} />
        </SettingSection>
        {d.waitingFor ? (
          <T variant="small" tone="muted" style={{ marginTop: -t.space.sm, marginBottom: t.space.md, paddingHorizontal: t.space.sm }}>
            {waitingLabel[d.waitingFor]}
          </T>
        ) : null}
        <SettingSection title="Storage">
          <SettingRow icon="server-outline" label="Storage limit" value={storageLimitLabel(s.storageLimitGb)} onPress={() => setSheet('storage')} />
          <SettingRow icon="film-outline" label="Default quality" value={qualityLabel(d.defaultQuality)} onPress={() => setSheet('quality')} />
          <SettingRow icon="trash-outline" label="Delete watched episodes" value={deleteAfterLabel(s.deleteWatchedAfterHours)} onPress={() => setSheet('deleteAfter')} />
        </SettingSection>
        <T variant="small" tone="muted" style={{ marginTop: -t.space.sm, marginBottom: t.space.lg, paddingHorizontal: t.space.sm }}>
          {formatBytes(d.totalBytes) || '0 B'} used. When the limit is reached, watched downloads are removed oldest first; unwatched ones are never removed automatically.
        </T>
        <SettingSection title="Smart downloads on this device">
          {d.rules.length ? (
            d.rules.map((r) => (
              <SettingRow
                key={r.id}
                icon="sparkles-outline"
                label={r.showTitle}
                value={`Next ${r.keepCount} · ${deleteAfterLabel(r.deleteWatchedAfterHours).toLowerCase()}`}
                onPress={() => removeRule(r.id, r.showTitle)}
              />
            ))
          ) : (
            <View style={{ padding: t.space.md }}>
              <T variant="small" tone="muted">
                Open a show and choose Smart download to keep its next unwatched episodes on this device.
              </T>
            </View>
          )}
        </SettingSection>
        <T variant="small" tone="muted" style={{ paddingHorizontal: t.space.sm }}>
          New episodes are fetched while the app is open (and when it comes back to the foreground) on a connection that meets these conditions. Phones don&apos;t let apps download on a schedule reliably in the background, so open the app on Wi-Fi to top up.
        </T>
      </ScrollView>
      <OptionSheet
        visible={sheet === 'quality'}
        title="Default download quality"
        options={DOWNLOAD_QUALITIES.map((q) => ({ key: q.key, label: q.label, description: q.description, selected: q.key === d.defaultQuality }))}
        onSelect={(k) => {
          setSheet(null);
          d.setDefaultQuality(k);
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'storage'}
        title="Storage limit"
        options={STORAGE_LIMIT_OPTIONS.map((gb) => ({ key: String(gb ?? 'none'), label: storageLimitLabel(gb), selected: gb === s.storageLimitGb }))}
        onSelect={(k) => {
          setSheet(null);
          d.setSmart({ storageLimitGb: k === 'none' ? null : Number(k) });
          void d.refreshSmart();
        }}
        onClose={() => setSheet(null)}
      />
      <OptionSheet
        visible={sheet === 'deleteAfter'}
        title="Delete watched episodes"
        options={DELETE_AFTER_OPTIONS.map((h) => ({ key: String(h ?? 'never'), label: deleteAfterLabel(h), description: h == null ? undefined : 'For shows with smart downloads', selected: h === s.deleteWatchedAfterHours }))}
        onSelect={(k) => {
          setSheet(null);
          d.setSmart({ deleteWatchedAfterHours: k === 'never' ? null : Number(k) });
        }}
        onClose={() => setSheet(null)}
      />
    </Screen>
  );
}
