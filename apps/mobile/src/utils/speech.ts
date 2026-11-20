/**
 * Device text-to-speech (expo-speech), loaded defensively.
 *
 * expo-speech links on iOS and Android (phones and Android TV), but its podspec
 * does not list tvOS, so on Apple TV the native module is absent and importing
 * the package would throw. We check for the native module first and only then
 * require the JS package; without it `deviceSpeech` is null and callers show the
 * line as text only.
 */
import { requireOptionalNativeModule } from 'expo';

type SpeechModule = typeof import('expo-speech');

function load(): SpeechModule | null {
  try {
    if (!requireOptionalNativeModule('ExpoSpeech')) return null;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-speech') as SpeechModule;
  } catch {
    return null;
  }
}

export const deviceSpeech: SpeechModule | null = load();
