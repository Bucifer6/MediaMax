/**
 * Autolinking overrides.
 *
 * react-native-google-cast (Chromecast) is phones-only: the Google Cast SDK has
 * no tvOS build, and a TV has nothing to cast to. TV builds (EXPO_TV=1) unlink
 * it so the pod / Gradle module is not added; the JS side checks for the native
 * module before loading (src/cast).
 *
 * The same goes for the CarPlay / Android Auto module (modules/mediamax-car): a TV is not a car.
 */
const isTV = process.env.EXPO_TV === '1' || process.env.EXPO_TV === 'true';

module.exports = {
  dependencies: isTV
    ? {
        'react-native-google-cast': { platforms: { ios: null, android: null } },
        // CarPlay / Android Auto bridge (local Expo module). Expo autolinking excludes it for TV via
        // plugins/withMediaMaxCar.js; listed here too so no linker ever picks it up for a TV build.
        'mediamax-car': { platforms: { ios: null, android: null } },
      }
    : {},
};
