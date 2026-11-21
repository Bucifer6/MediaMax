import type { DownloadRule, Platform } from '@mediamax/shared';

export interface DeviceRules {
  deviceId: string;
  deviceName: string;
  platform: Platform;
  rules: DownloadRule[];
}

/** Rules grouped per device (devices and shows sorted by name). */
export function groupRulesByDevice(rules: DownloadRule[]): DeviceRules[] {
  const map = new Map<string, DeviceRules>();
  for (const r of rules) {
    const g = map.get(r.deviceId) ?? { deviceId: r.deviceId, deviceName: r.deviceName, platform: r.platform, rules: [] };
    g.rules.push(r);
    map.set(r.deviceId, g);
  }
  return [...map.values()]
    .map((g) => ({ ...g, rules: [...g.rules].sort((a, b) => a.showTitle.localeCompare(b.showTitle)) }))
    .sort((a, b) => a.deviceName.localeCompare(b.deviceName));
}

export function deleteAfterText(h: number | null): string {
  if (h == null) return 'keeps watched episodes';
  if (h === 0) return 'deletes watched episodes right away';
  return h < 48 ? `deletes watched episodes after ${h} h` : `deletes watched episodes after ${Math.round(h / 24)} days`;
}

/** "Next 3 unwatched · Wi-Fi only · 720p · deletes watched episodes after 24 h". */
export function ruleSummary(r: Pick<DownloadRule, 'keepCount' | 'wifiOnly' | 'quality' | 'deleteWatchedAfterHours'>): string {
  return [
    `Next ${r.keepCount} unwatched`,
    r.wifiOnly ? 'Wi-Fi only' : null,
    r.quality !== 'original' ? r.quality : null,
    deleteAfterText(r.deleteWatchedAfterHours),
  ].filter(Boolean).join(' · ');
}
