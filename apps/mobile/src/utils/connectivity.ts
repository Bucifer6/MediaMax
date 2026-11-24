/**
 * Network type and charging state for smart downloads and instant play (expo-network, expo-battery).
 * Falls back to "online, Wi-Fi unknown = not Wi-Fi, not charging" when a module is unavailable (web, old builds).
 */
import React from 'react';
import * as Battery from 'expo-battery';
import * as Network from 'expo-network';
import type { Conditions } from '@/state/smartDownloads';

export async function getConditions(): Promise<Conditions> {
  const [net, battery] = await Promise.all([
    Network.getNetworkStateAsync().catch(() => null),
    Battery.getBatteryStateAsync().catch(() => Battery.BatteryState.UNKNOWN),
  ]);
  const type = net?.type;
  return {
    online: net ? net.isConnected !== false && type !== Network.NetworkStateType.NONE : true,
    // Ethernet (TV boxes, tablets on a dock) counts as unmetered too.
    wifi: type === Network.NetworkStateType.WIFI || type === Network.NetworkStateType.ETHERNET,
    charging: battery === Battery.BatteryState.CHARGING || battery === Battery.BatteryState.FULL,
  };
}

/** Cellular (or unknown-but-not-Wi-Fi) connection: don't ask the server to start work on our behalf. */
export async function isMetered(): Promise<boolean> {
  const c = await getConditions();
  return c.online && !c.wifi;
}

/** Called when the network or charging state changes. Returns an unsubscribe function. */
export function onConditionsChange(cb: () => void): () => void {
  const subs: { remove(): void }[] = [];
  try {
    subs.push(Network.addNetworkStateListener(() => cb()));
  } catch {
    /* module unavailable */
  }
  try {
    subs.push(Battery.addBatteryStateListener(() => cb()));
  } catch {
    /* module unavailable */
  }
  return () => subs.forEach((s) => s.remove());
}

/**
 * Whether the device has a network connection (expo-network). Starts optimistic (true) and follows changes; used to
 * keep server-only features (Your DJ, the Radio Host) quiet while offline.
 */
export function useOnline(): boolean {
  const [online, setOnline] = React.useState(true);
  React.useEffect(() => {
    let alive = true;
    const check = () =>
      void Network.getNetworkStateAsync()
        .then((n) => alive && setOnline(n.isConnected !== false && n.type !== Network.NetworkStateType.NONE))
        .catch(() => undefined);
    check();
    let sub: { remove(): void } | null = null;
    try {
      sub = Network.addNetworkStateListener((n) => alive && setOnline(n.isConnected !== false && n.type !== Network.NetworkStateType.NONE));
    } catch {
      /* module unavailable: stay optimistic */
    }
    return () => {
      alive = false;
      sub?.remove();
    };
  }, []);
  return online;
}
