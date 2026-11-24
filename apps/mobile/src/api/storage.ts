/**
 * Key/value storage.
 *  - `secure*`: tokens. expo-secure-store on phones; AsyncStorage on TV (no
 *    keychain UI there, and Android TV devices often lack a usable keystore).
 *  - `get/set/remove`: ordinary JSON-able app data in AsyncStorage.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';

type SecureStoreModule = typeof import('expo-secure-store');
let secureStore: SecureStoreModule | null | undefined;

function getSecureStore(): SecureStoreModule | null {
  if (secureStore !== undefined) return secureStore;
  if (Platform.isTV || Platform.OS === 'web') {
    secureStore = null;
    return null;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    secureStore = require('expo-secure-store') as SecureStoreModule;
  } catch {
    secureStore = null;
  }
  return secureStore;
}

/** SecureStore keys may only contain alphanumerics, ".", "-" and "_". */
const safeKey = (key: string) => key.replace(/[^A-Za-z0-9._-]/g, '_');

export async function secureGet(key: string): Promise<string | null> {
  const ss = getSecureStore();
  if (ss) {
    try {
      return await ss.getItemAsync(safeKey(key));
    } catch {
      /* fall through to AsyncStorage */
    }
  }
  return AsyncStorage.getItem(`secure:${key}`);
}

export async function secureSet(key: string, value: string): Promise<void> {
  const ss = getSecureStore();
  if (ss) {
    try {
      await ss.setItemAsync(safeKey(key), value);
      return;
    } catch {
      /* fall through */
    }
  }
  await AsyncStorage.setItem(`secure:${key}`, value);
}

export async function secureRemove(key: string): Promise<void> {
  const ss = getSecureStore();
  if (ss) {
    try {
      await ss.deleteItemAsync(safeKey(key));
    } catch {
      /* ignore */
    }
  }
  await AsyncStorage.removeItem(`secure:${key}`);
}

export async function getJSON<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export async function setJSON(key: string, value: unknown): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}
