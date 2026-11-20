/// <reference types="node" />
/**
 * Dynamic Expo config for the MediaMax white-label apps.
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
 * Select a brand with MEDIAMAX_BRAND=<brand>. TV builds are selected with
 * EXPO_TV=1 (read by @react-native-tvos/config-tv).
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
}

const isTV = process.env.EXPO_TV === '1' || process.env.EXPO_TV === 'true';
const brandName = process.env.MEDIAMAX_BRAND;
const brandDir = brandName ? path.join(__dirname, 'branding', brandName) : null;

function readBrand(): BrandFile {
  if (!brandDir) return {};
  const file = path.join(brandDir, 'brand.json');
  if (!fs.existsSync(file)) {
    throw new Error(`MEDIAMAX_BRAND=${brandName} but ${file} does not exist. Run: npm run brand -- <serverUrl> ${brandName}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as BrandFile;
}

/** Use the brand's asset if present, else the stock MediaMax asset. */
function asset(name: string, fallback: string): string {
  if (brandDir) {
    const p = path.join(brandDir, name);
    if (fs.existsSync(p)) return `./branding/${brandName}/${name}`;
  }
  return fallback;
}

function optionalAsset(name: string): string | undefined {
  if (brandDir && fs.existsSync(path.join(brandDir, name))) return `./branding/${brandName}/${name}`;
  const stock = path.join(__dirname, 'assets', 'tv', name);
  if (fs.existsSync(stock)) return `./assets/tv/${name}`;
  return undefined;
}

export default ({ config }: ConfigContext): ExpoConfig => {
  const brand = readBrand();
  const appName = brand.appName ?? 'MediaMax';
  const bundleId = brand.bundleId ?? 'tv.mediamax.app';
  const androidPackage = brand.androidPackage ?? bundleId;
  const splashBg = brand.splashBackgroundColor ?? '#0B0B12';
  const icon = asset('icon.png', './assets/icon.png');
  const splash = asset('splash.png', './assets/splash-icon.png');

  const tvBanner = optionalAsset('tv-banner.png');
  const tvIcon = optionalAsset('tv-icon.png');
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

  return {
    ...config,
    name: appName,
    slug: brand.slug ?? 'mediamax',
    scheme: brand.scheme ?? 'mediamax',
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
          imageWidth: 220,
          backgroundColor: splashBg,
          dark: { image: splash, backgroundColor: splashBg },
        },
      ],
      [
        'expo-build-properties',
        {
          android: { usesCleartextTraffic: true },
        },
      ],
      [
        '@react-native-tvos/config-tv',
        {
          isTV,
          tvosDeploymentTarget: '16.4',
          ...(tvBanner ? { androidTVBanner: tvBanner } : {}),
          ...(tvIcon ? { androidTVIcon: tvIcon } : {}),
          ...(hasAppleTVImages ? { appleTVImages: appleTV } : {}),
        },
      ],
    ],
    experiments: { typedRoutes: false, tsconfigPaths: true },
    extra: {
      isTVBuild: isTV,
      brand: brandName ?? null,
      defaultServerUrl: brand.serverUrl ?? process.env.MEDIAMAX_SERVER_URL ?? null,
      lockServer: brand.lockServer ?? process.env.MEDIAMAX_LOCK_SERVER === '1',
      fallbackPrimaryColor: brand.primaryColor ?? '#7C5CFF',
      ...(brand.easProjectId ? { eas: { projectId: brand.easProjectId } } : {}),
    },
  };
};
