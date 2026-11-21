import React, { useState } from 'react';
import { Alert } from 'react-native';
import type { Item } from '@/api/types';
import { Button } from '@/components/Button';
import { OptionSheet } from '@/components/OptionSheet';
import { useDownloads } from '@/state/downloads';
import { KEEP_OPTIONS, deleteAfterLabel } from '@/state/smartDownloads';
import { useCapabilities } from '@/state/session';

/**
 * Show page: smart downloads ("keep the next N unwatched episodes on this device") and "download all episodes".
 * Rules live on the server per device; the downloads provider fetches / deletes episodes as they are watched.
 */
export function SmartDownloadButton({ show }: { show: Item }) {
  const caps = useCapabilities();
  const d = useDownloads();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!caps.downloads || !d.supported) return null;
  const rule = d.ruleFor(show.id);

  const choose = async (key: string) => {
    setOpen(false);
    setBusy(true);
    try {
      if (key === 'all') await d.downloadShow(show.id);
      else await d.setRule(show, key === 'off' ? null : Number(key));
    } catch (e) {
      Alert.alert('Smart downloads', e instanceof Error ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button icon={rule ? 'sparkles' : 'sparkles-outline'} label={rule ? `Next ${rule.keepCount}` : undefined} variant="secondary" size="lg" onPress={() => setOpen(true)} loading={busy} accessibilityLabel="Smart download" />
      <OptionSheet
        visible={open}
        title="Smart download"
        sections={[
          {
            title: `Keep the next unwatched episodes on this device · watched ones: ${deleteAfterLabel(rule?.deleteWatchedAfterHours ?? d.smart.deleteWatchedAfterHours).toLowerCase()}`,
            options: [
              { key: 'off', label: 'Off', selected: !rule },
              ...KEEP_OPTIONS.map((n) => ({ key: String(n), label: `Next ${n} episode${n === 1 ? '' : 's'}`, selected: rule?.keepCount === n, description: d.smart.wifiOnly ? 'Downloads on Wi-Fi' : undefined })),
            ],
          },
          { title: 'Download now', options: [{ key: 'all', label: 'All episodes', icon: 'download-outline' }] },
        ]}
        onSelect={(k) => void choose(k)}
        onClose={() => setOpen(false)}
      />
    </>
  );
}
