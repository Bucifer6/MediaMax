/// <reference types="node" />
/**
 * Dynamic Expo config for the Kinora white-label apps.
 *
 * Everything visual inside the app (name shown on screens, logos, colours, fonts,
 * layout, home rows, feature toggles) is fetched from the server at runtime.
 * Only what the OS needs *before* the app starts — app name under the icon,
 * bundle id, icon, splash and TV banners — is baked in at build time. Those come
 * from an optional brand folder produced by `npm run brand -- <serverUrl>`:
 *
 *   branding/<brand>/brand.json   (written by scripts/brand.mjs)
 *   branding/<brand>/icon.png     (1024x1024)
 *   branding/<brand>/splash.png
 *
 * Select a brand with KINORA_BRAND=<brand> (or the original MEDIAMAX_BRAND). TV builds are selected with
 * EXPO_TV=1 (read by @react-native-tvos/config-tv).
 *
 * The stock app's name, URL scheme and store identifiers live in branding/defaults.json (the single source of
 * truth); a brand's brand.json overrides them field by field.
 */
import type { ConfigContext, ExpoConfig } from 'expo/config';
import fs from 'node:fs';
import path from 'node:path';

interface BrandFile {
  appName?: string;
  slug?: string;
  scheme?: string;
  bundleId?: string;
  androidPackage?: string;
  /** Baked-in server; when set with lockServer the connect screen is skipped. */
  serverUrl?: string | null;
  lockServer?: boolean;
  splashBackgroundColor?: string;
  primaryColor?: string;
  version?: string;
  easProjectId?: string;
  /**
   * iOS: Siri "Play … in Kinora" (INPlayMediaIntent + com.apple.developer.siri entitlement).
   * Needs the Siri capability on the App ID; also enabled by KINORA_SIRI=1 (or MEDIAMAX_SIRI=1). See README › Siri.
   */
  siri?: boolean;
}

interface Defaults {
  appName: string;
  slug: string;
  scheme: string;
  legacySchemes: string[];
  bundleId: string;
  androidPackage: string;
}
const DEFAULTS = JSON.parse(fs.readFileSync(path.join(__dirname, 'branding', 'defaults.json'), 'utf8')) as Defaults;

/** KINORA_<name> wins over the original MEDIAMAX_<name>. */
const env = (name: string): string | undefined => process.env[`KINORA_${name}`] ?? process.env[`MEDIAMAX_${name}`];

const isTV = process.env.EXPO_TV === '1' || process.env.EXPO_TV === 'true';
const brandName = env('BRAND');
const brandDir = brandName ? path.join(__dirname, 'branding', brandName) : null;

function readBrand(): BrandFile {
  if (!brandDir) return {};
  const file = path.join(brandDir, 'brand.json');
  if (!fs.existsSync(file)) {
    throw new Error(`KINORA_BRAND=${brandName} but ${file} does not exist. Run: npm run brand -- <serverUrl> ${brandName}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BrandFile;
}

/** Use the brand's asset if present, else the stock Kinora asset. */
function asset(name: string, fallback: string): string {
  if (brandDir) {
    const p = path.join(brandDir, name);
    if (fs.existsSync(p)) return `./branding/${brandName}/${name}`;
  }
  return fallback;
}

/**
 * TV artwork: the brand folder's file, else (stock Kinora builds only) the Kinora artwork in
 * assets/tv, rendered by scripts/brand-export.mjs. A white-label build never falls back to Kinora
 * TV artwork; without its own it gets the platform defaults derived from its icon.
 */
function optionalAsset(name: string): string | undefined {
  if (brandDir) return fs.existsSync(path.join(brandDir, name)) ? `./branding/${brandName}/${name}` : undefined;
  const stock = path.join(__dirname, 'assets', 'tv', name);
  if (fs.existsSync(stock)) return `./assets/tv/${name}`;
  return undefined;
}

/** Apple TV icon layers (front = mark, back = background) for the focus parallax, when available. */
function appleTVLayers(size: string): { front: string; back: string } | undefined {
  const front = optionalAsset(`appletv-icon-front-${size}.png`);
  const back = optionalAsset(`appletv-icon-back-${size}.png`);
  return front && back ? { front, back } : undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const brand = readBrand();
  const appName = brand.appName ?? DEFAULTS.appName;
  const bundleId = brand.bundleId ?? DEFAULTS.bundleId;
  const androidPackage = brand.androidPackage ?? (brand.bundleId ? bundleId : DEFAULTS.androidPackage);
  // Every build registers the stock schemes: kinora:// (primary: OIDC redirects, pairing links) and the legacy
  // mediamax://, so links made by older servers or web clients still open the app. A brand's own scheme comes first.
  const schemes = [...new Set([brand.scheme, DEFAULTS.scheme, ...DEFAULTS.legacySchemes].filter((x): x is string => !!x))];
  // Stock Kinora: dark ground #0D0C1D (light-mode splash #F7F6FF). A brand's splash colour is used for both.
  const splashBg = brand.splashBackgroundColor ?? '#0D0C1D';
  const splashBgLight = brand.splashBackgroundColor ?? '#F7F6FF';
  const icon = asset('icon.png', './assets/icon.png');
  const splash = asset('splash.png', './assets/splash-icon.png');

  const tvBanner = optionalAsset('tv-banner.png');
  const tvIcon = optionalAsset('tv-icon.png');
  const layers = { iconLayers: appleTVLayers('1280x768'), iconSmallLayers: appleTVLayers('400x240'), iconSmall2xLayers: appleTVLayers('800x480') };
  const appleTV = {
    icon: optionalAsset('appletv-icon-1280x768.png'),
    iconSmall: optionalAsset('appletv-icon-400x240.png'),
    iconSmall2x: optionalAsset('appletv-icon-800x480.png'),
    topShelf: optionalAsset('appletv-topshelf-1920x720.png'),
    topShelf2x: optionalAsset('appletv-topshelf-3840x1440.png'),
    topShelfWide: optionalAsset('appletv-topshelfwide-2320x720.png'),
    topShelfWide2x: optionalAsset('appletv-topshelfwide-4640x1440.png'),
  };
  const hasAppleTVImages = Object.values(appleTV).every(Boolean);
  const appleTVImages = {
    ...appleTV,
    ...Object.fromEntries(Object.entries(layers).filter(([, v]) => v)),
  };

  return {
    ...config,
    name: appName,
    slug: brand.slug ?? DEFAULTS.slug,
    scheme: schemes,
    version: brand.version ?? '0.1.0',
    orientation: isTV ? 'landscape' : 'default',
    icon,
    userInterfaceStyle: 'automatic',
    backgroundColor: splashBg,
    ios: {
      bundleIdentifier: bundleId,
      supportsTablet: true,
      infoPlist: {
        UIBackgroundModes: ['audio'],
        // Self-hosted servers are frequently plain http on the LAN.
        NSAppTransportSecurity: { NSAllowsArbitraryLoads: true, NSAllowsLocalNetworking: true },
        NSLocalNetworkUsageDescription: `${appName} connects to your media server on the local network.`,
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: androidPackage,
      adaptiveIcon: {
        backgroundColor: splashBg,
        foregroundImage: asset('android-icon-foreground.png', './assets/android-icon-foreground.png'),
        backgroundImage: asset('android-icon-background.png', './assets/android-icon-background.png'),
        monochromeImage: asset('android-icon-monochrome.png', './assets/android-icon-monochrome.png'),
      },
      predictiveBackGestureEnabled: false,
      permissions: ['android.permission.FOREGROUND_SERVICE', 'android.permission.FOREGROUND_SERVICE_MEDIA_PLAYBACK', 'android.permission.WAKE_LOCK'],
    },
    web: { favicon: './assets/favicon.png' },
    plugins: [
      ['expo-router', { root: './app' }],
      ['expo-video', { supportsBackgroundPlayback: true, supportsPictureInPicture: !isTV }],
      ['expo-audio', { microphonePermission: false, enableBackgroundPlayback: true }],
      'expo-secure-store',
      'expo-font',
      // Profile picture upload (phones only; the pod is skipped on tvOS).
      ['expo-image-picker', { photosPermission: `${appName} uses your photos to set your profile picture.`, cameraPermission: false, microphonePermission: false }],
      [
        'expo-splash-screen',
        {
          image: splash,
          imageWidth: 260,
          backgroundColor: splashBgLight,
          dark: { image: splash, backgroundColor: splashBg },
        },
      ],
      [
        'expo-build-properties',
        {
          android: { usesCleartextTraffic: true },
        },
      ],
      // Chromecast (phones only). The Cast SDK has no tvOS build and casting from a TV makes no
      // sense, so TV builds skip the plugin and react-native.config.js unlinks the native module.
      // CC1AD845 = Google's Default Media Receiver. The Cast SDK is pinned: the default '+' picks up 23.x,
      // which is compiled with a newer Kotlin than React Native's toolchain can read.
      ...(isTV ? [] : [['react-native-google-cast', { receiverAppId: 'CC1AD845', expandedController: false, androidPlayServicesCastFrameworkVersion: '22.1.0' }] as [string, Record<string, unknown>]]),
      // CarPlay (audio entitlement + CarPlay scene) and Android Auto (Media3 MediaLibraryService), backed
      // by the local module in modules/mediamax-car. On TV builds the plugin only removes the module
      // from Android autolinking; the iOS pod is iOS-only, so tvOS skips it. See README › CarPlay & Android Auto.
      // Siri media intents are opt-in (`siri` in brand.json or KINORA_SIRI=1): the entitlement needs
      // the Siri capability on the App ID. Simulator CI builds are unsigned, so either way compiles.
      ['./plugins/withMediaMaxCar', { isTV, siri: !isTV && (brand.siri === true || env('SIRI') === '1') }],
      [
        '@react-native-tvos/config-tv',
        {
          isTV,
          tvosDeploymentTarget: '16.4',
          ...(tvBanner ? { androidTVBanner: tvBanner } : {}),
          ...(tvIcon ? { androidTVIcon: tvIcon } : {}),
          ...(hasAppleTVImages ? { appleTVImages } : {}),
        },
      ],
    ],
    experiments: { typedRoutes: false, tsconfigPaths: true },
    extra: {
      isTVBuild: isTV,
      brand: brandName ?? null,
      defaultServerUrl: brand.serverUrl ?? env('SERVER_URL') ?? null,
      lockServer: brand.lockServer ?? env('LOCK_SERVER') === '1',
      fallbackPrimaryColor: brand.primaryColor ?? '#9198FF',
      ...(brand.easProjectId ? { eas: { projectId: brand.easProjectId } } : {}),
    },
  };
};
