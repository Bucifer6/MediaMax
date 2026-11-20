// @ts-check
/**
 * Expo config plugin for CarPlay (iOS) and Android Auto, backed by the local Expo module in
 * modules/mediamax-car. Used from app.config.ts as ['./plugins/withMediaMaxCar', { isTV }].
 *
 * iOS (phones only):
 *   - entitlement com.apple.developer.carplay-audio (Apple must grant it to the team first, see README)
 *   - UIApplicationSceneManifest: a CarPlay template scene (MediaMaxCarSceneDelegate) and the phone
 *     scene switched to MediaMaxPhoneSceneDelegate (an ExpoAppSceneDelegate subclass that can adopt the
 *     React Native window after a CarPlay-first launch)
 *
 * Android (phones only):
 *   - the Media3 MediaLibraryService (tv.mediamax.car.MediaMaxCarService) with the
 *     MediaLibraryService and legacy MediaBrowserService intent filters
 *   - the artwork ContentProvider (Android Auto only loads content:// artwork)
 *   - com.google.android.gms.car.application meta-data + res/xml/automotive_app_desc.xml (<uses name="media"/>)
 *
 * TV builds (isTV): nothing is added, and the Android project excludes the module from Expo
 * autolinking (the iOS pod is iOS-only, so tvOS targets skip it on their own).
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withDangerousMod,
  withEntitlementsPlist,
  withInfoPlist,
  withSettingsGradle,
} = require('expo/config-plugins');

const MODULE_NAME = 'mediamax-car';
const PHONE_SCENE_DELEGATE = 'MediaMaxPhoneSceneDelegate';
const CAR_SCENE_DELEGATE = 'MediaMaxCarSceneDelegate';
const SERVICE_CLASS = 'tv.mediamax.car.MediaMaxCarService';
const PROVIDER_CLASS = 'tv.mediamax.car.ArtworkProvider';
const AUTOMOTIVE_META = 'com.google.android.gms.car.application';
const AUTOMOTIVE_XML = 'automotive_app_desc';

/** @typedef {import('expo/config-plugins').ConfigPlugin<{ isTV?: boolean } | void>} Plugin */

// ----------------------------------------------------------------------------- iOS

/** @param {Record<string, any>} infoPlist */
function applySceneManifest(infoPlist) {
  const manifest = infoPlist.UIApplicationSceneManifest ?? { UIApplicationSupportsMultipleScenes: false };
  const configs = manifest.UISceneConfigurations ?? {};
  const phone = Array.isArray(configs.UIWindowSceneSessionRoleApplication) ? configs.UIWindowSceneSessionRoleApplication : [];
  // Keep the template's configuration name; only the delegate class changes. The template's
  // SceneDelegate.swift still compiles but is no longer instantiated.
  configs.UIWindowSceneSessionRoleApplication = phone.length
    ? phone.map((/** @type {Record<string, any>} */ entry) => ({ ...entry, UISceneClassName: entry.UISceneClassName ?? 'UIWindowScene', UISceneDelegateClassName: PHONE_SCENE_DELEGATE }))
    : [{ UISceneClassName: 'UIWindowScene', UISceneConfigurationName: 'Default Configuration', UISceneDelegateClassName: PHONE_SCENE_DELEGATE }];
  configs.CPTemplateApplicationSceneSessionRoleApplication = [
    { UISceneClassName: 'CPTemplateApplicationScene', UISceneConfigurationName: 'CarPlay', UISceneDelegateClassName: CAR_SCENE_DELEGATE },
  ];
  manifest.UISceneConfigurations = configs;
  infoPlist.UIApplicationSceneManifest = manifest;
  return infoPlist;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withCarPlay = (config) => {
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.carplay-audio'] = true;
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applySceneManifest(cfg.modResults);
    const modes = Array.isArray(cfg.modResults.UIBackgroundModes) ? cfg.modResults.UIBackgroundModes : [];
    if (!modes.includes('audio')) cfg.modResults.UIBackgroundModes = [...modes, 'audio'];
    return cfg;
  });
  // MediaMaxPhoneSceneDelegate needs the SDK 58 scene life cycle (AppDelegate adopting
  // ExpoReactNativeFactoryProvider). Warn instead of failing so an unexpected template is visible.
  config = withDangerousMod(config, [
    'ios',
    (cfg) => {
      const root = cfg.modRequest.platformProjectRoot;
      const dir = fs.readdirSync(root, { withFileTypes: true }).find((d) => d.isDirectory() && fs.existsSync(path.join(root, d.name, 'AppDelegate.swift')));
      const source = dir ? fs.readFileSync(path.join(root, dir.name, 'AppDelegate.swift'), 'utf8') : '';
      if (!source.includes('ExpoReactNativeFactoryProvider')) {
        WarningAggregator.addWarningIOS(
          'withMediaMaxCar',
          'AppDelegate.swift does not adopt ExpoReactNativeFactoryProvider (Expo SDK 58 scene life cycle). CarPlay and the phone scene delegate will not work until the iOS project is regenerated with `npx expo prebuild --clean`.',
        );
      }
      return cfg;
    },
  ]);
  return config;
};

// ------------------------------------------------------------------------- Android

/**
 * @param {any[] | undefined} list
 * @param {string} name
 * @param {any} entry
 */
function upsertByName(list, name, entry) {
  const items = (list ?? []).filter((/** @type {any} */ item) => item?.$?.['android:name'] !== name);
  items.push(entry);
  return items;
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withAndroidAuto = (config) => {
  config = withAndroidManifest(config, (cfg) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(cfg.modResults);
    const pkg = cfg.android?.package ?? cfg.modResults.manifest.$.package ?? 'tv.mediamax.app';

    app.service = upsertByName(app.service, SERVICE_CLASS, {
      $: {
        'android:name': SERVICE_CLASS,
        'android:exported': 'true',
        'android:foregroundServiceType': 'mediaPlayback',
      },
      'intent-filter': [
        {
          action: [
            { $: { 'android:name': 'androidx.media3.session.MediaLibraryService' } },
            { $: { 'android:name': 'android.media.browse.MediaBrowserService' } },
          ],
        },
      ],
    });

    app.provider = upsertByName(app.provider, PROVIDER_CLASS, {
      $: {
        'android:name': PROVIDER_CLASS,
        'android:authorities': `${pkg}.mediamax.artwork`,
        'android:exported': 'true',
      },
    });

    AndroidConfig.Manifest.addMetaDataItemToMainApplication(app, AUTOMOTIVE_META, `@xml/${AUTOMOTIVE_XML}`, 'resource');
    return cfg;
  });

  config = withDangerousMod(config, [
    'android',
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res', 'xml');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(
        path.join(dir, `${AUTOMOTIVE_XML}.xml`),
        '<?xml version="1.0" encoding="utf-8"?>\n<!-- Generated by plugins/withMediaMaxCar.js: Android Auto media app. -->\n<automotiveApp>\n  <uses name="media" />\n</automotiveApp>\n',
      );
      return cfg;
    },
  ]);
  return config;
};

/** TV builds: keep the module out of the Android TV app entirely. */
/** @type {import('expo/config-plugins').ConfigPlugin} */
const withTvExclusion = (config) =>
  withSettingsGradle(config, (cfg) => {
    const marker = `// ${MODULE_NAME}: excluded from TV builds`;
    let contents = cfg.modResults.contents;
    if (contents.includes(marker)) return cfg;
    const call = 'expoAutolinking.useExpoModules()';
    if (!contents.includes(call)) {
      WarningAggregator.addWarningAndroid('withMediaMaxCar', `Could not find ${call} in settings.gradle; ${MODULE_NAME} stays linked in this TV build (it is inert without its manifest entries).`);
      return cfg;
    }
    const line =
      cfg.modResults.language === 'kt'
        ? `expoAutolinking.exclude = (expoAutolinking.exclude ?: emptyList()) + listOf("${MODULE_NAME}") ${marker}`
        : `expoAutolinking.exclude = (expoAutolinking.exclude ?: []) + ['${MODULE_NAME}'] ${marker}`;
    contents = contents.replace(call, `${line}\n${call}`);
    cfg.modResults.contents = contents;
    return cfg;
  });

/** @type {Plugin} */
const withMediaMaxCar = (config, props) => {
  if (props && props.isTV) return withTvExclusion(config);
  config = withCarPlay(config);
  config = withAndroidAuto(config);
  return config;
};

module.exports = createRunOncePlugin(withMediaMaxCar, 'withMediaMaxCar', '1.0.0');
module.exports.applySceneManifest = applySceneManifest;
