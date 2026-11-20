/**
 * expo-web-browser, loaded lazily: there is no browser on TV, so screens
 * check `webBrowser()` and fall back (show the URL, use link codes).
 */
import { Platform } from 'react-native';

type WebBrowserModule = typeof import('expo-web-browser');

export function webBrowser(): WebBrowserModule | null {
  if (Platform.isTV || Platform.OS === 'web') return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('expo-web-browser') as WebBrowserModule;
  } catch {
    return null;
  }
}
