/**
 * Player settings kept on this device (not in the user's server preferences, since they depend on the device):
 *  - external player (Android): hand videos to VLC / Kodi / Just Player … instead of the built-in player;
 *  - frame-rate matching (Android TV / Fire TV): switch the TV's refresh rate to the video's.
 */
import { useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { getJSON, setJSON } from '@/api/storage';
import { MediaMaxMedia } from '../../modules/mediamax-media';
import { EXTERNAL_DEFAULT, normalizeExternalSetting, type ExternalPlayerSetting } from './external';

const EXTERNAL_KEY = 'mm.player.external';
const FRAME_RATE_KEY = 'mm.player.matchFrameRate';

/** The native build can launch external players (Android with a MediaMaxMedia build that has openExternalPlayer). */
export const externalPlayerSupported = Platform.OS === 'android' && typeof MediaMaxMedia?.openExternalPlayer === 'function';
/** Frame-rate matching is offered on Android TV (Apple TV follows the system's "Match Content" setting). */
export const frameRateMatchingSupported = Platform.OS === 'android' && Platform.isTV && !!MediaMaxMedia;

function store<T>(key: string, fallback: T, normalize: (v: unknown) => T) {
  let cache: T | null = null;
  const listeners = new Set<(v: T) => void>();
  const get = async (): Promise<T> => {
    if (cache !== null) return cache;
    cache = normalize(await getJSON<unknown>(key, fallback));
    return cache;
  };
  const set = async (v: T) => {
    cache = v;
    for (const l of listeners) l(v);
    await setJSON(key, v);
  };
  const use = (): T => {
    const [v, setV] = useState<T>(cache ?? fallback);
    useEffect(() => {
      void get().then(setV);
      listeners.add(setV);
      return () => {
        listeners.delete(setV);
      };
    }, []);
    return v;
  };
  return { get, set, use };
}

const external = store<ExternalPlayerSetting>(EXTERNAL_KEY, EXTERNAL_DEFAULT, normalizeExternalSetting);
const frameRate = store<boolean>(FRAME_RATE_KEY, false, (v) => v === true);

export const getExternalPlayer = external.get;
export const setExternalPlayer = external.set;
export const useExternalPlayer = external.use;

export const getMatchFrameRate = frameRate.get;
export const setMatchFrameRate = frameRate.set;
export const useMatchFrameRate = frameRate.use;
