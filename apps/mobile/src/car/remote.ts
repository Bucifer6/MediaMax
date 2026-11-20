/**
 * Lock-screen / CarPlay remote command hook for the audio player (src/state/music.tsx).
 * Kept separate from CarBridge so the player does not import the bridge (no import cycle).
 */
import { Platform } from 'react-native';
import { MediaMaxCar } from '../../modules/mediamax-car';

/**
 * Call right after `player.setActiveForLockScreen(...)`: expo-audio has just (re)registered
 * MPRemoteCommandCenter handlers, and a single expo-audio player cannot skip tracks, so on iOS the
 * native module installs next/previous-track handlers that drive the JS queue. Used by the CarPlay
 * Now Playing screen and the lock screen. `trackSkip` is false for spoken audio, which uses
 * ±15/30 s skip buttons instead. No-op on Android, in Expo Go and on TV.
 */
export function syncCarRemoteCommands(trackSkip: boolean): void {
  if (Platform.OS !== 'ios' || !MediaMaxCar) return;
  try {
    MediaMaxCar.syncRemoteCommands(trackSkip);
  } catch {
    /* module present but call failed: lock screen keeps expo-audio's defaults */
  }
}
