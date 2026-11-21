/** Persistent device identity sent with every request (X-Kinora-* headers). */
import * as Application from 'expo-application';
import * as Crypto from 'expo-crypto';
import * as Device from 'expo-device';
import { Platform as RNPlatform } from 'react-native';
import { getJSON, setJSON } from './storage';
import type { DeviceInfo, Platform } from './types';

const KEY = 'mediamax.deviceId';
let cached: DeviceInfo | null = null;

export function currentPlatform(): Platform {
  if (RNPlatform.OS === 'ios') return RNPlatform.isTV ? 'tvos' : 'ios';
  if (RNPlatform.OS === 'android') return RNPlatform.isTV ? 'androidtv' : 'android';
  if (RNPlatform.OS === 'web') return 'web';
  return 'other';
}

export function appVersion(): string {
  return Application.nativeApplicationVersion ?? '0.1.0';
}

function defaultDeviceName(): string {
  const name = Device.deviceName ?? Device.modelName;
  if (name) return name;
  const p = currentPlatform();
  return { tvos: 'Apple TV', androidtv: 'Android TV', roku: 'Roku', ios: 'iPhone', android: 'Android', web: 'Browser', other: 'Device' }[p];
}

export async function getDeviceInfo(): Promise<DeviceInfo> {
  if (cached) return cached;
  let id = await getJSON<string | null>(KEY, null);
  if (!id) {
    id = Crypto.randomUUID();
    await setJSON(KEY, id);
  }
  cached = { deviceId: id, deviceName: defaultDeviceName(), platform: currentPlatform(), appVersion: appVersion() };
  return cached;
}

/** Synchronous accessor once getDeviceInfo() has resolved (the session boot awaits it). */
export function deviceInfoSync(): DeviceInfo | null {
  return cached;
}
