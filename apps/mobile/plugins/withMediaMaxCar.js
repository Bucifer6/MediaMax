// @ts-check
/**
 * Expo config plugin for CarPlay (iOS), Siri and Android Auto, backed by the local Expo module in
 * modules/mediamax-car. Used from app.config.ts as ['./plugins/withMediaMaxCar', { isTV, siri }].
 *
 * iOS (phones only):
 *   - entitlement com.apple.developer.carplay-audio (Apple must grant it to the team first, see README)
 *   - UIApplicationSceneManifest: a CarPlay template scene (MediaMaxCarSceneDelegate) and the phone
 *     scene switched to MediaMaxPhoneSceneDelegate (an ExpoAppSceneDelegate subclass that can adopt the
 *     React Native window after a CarPlay-first launch)
 *   - AppDelegate.swift: `application(_:handlerFor:)` handing Siri's INPlayMediaIntent to the module
 *     (always added, so CI compiles it; inert until the Info.plist lists the intent)
 *   - `siri: true` only (MEDIAMAX_SIRI=1): INIntentsSupported / INSupportedMediaCategories /
 *     NSSiriUsageDescription and the com.apple.developer.siri entitlement, which turn on
 *     "Play … in MediaMax". Off by default: the entitlement needs the Siri capability on the App ID
 *     (a paid Apple developer account), see README › Siri.
 *
 * Android (phones only):
 *   - the Media3 MediaLibraryService (tv.mediamax.car.MediaMaxCarService) with the
 *     MediaLibraryService and legacy MediaBrowserService intent filters
 *   - the artwork ContentProvider (Android Auto only loads content:// artwork)
 *   - com.google.android.gms.car.application meta-data + res/xml/automotive_app_desc.xml (<uses name="media"/>)
 *
 * TV builds (isTV): nothing is added (no Siri either), and the Android project excludes the module
 * from Expo autolinking (the iOS pod is iOS-only, so tvOS targets skip it on their own).
 */
const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  WarningAggregator,
  createRunOncePlugin,
  withAndroidManifest,
  withAppDelegate,
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

/** @typedef {import('expo/config-plugins').ConfigPlugin<{ isTV?: boolean; siri?: boolean } | void>} Plugin */

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

// ---------------------------------------------------------------------------- Siri

const SIRI_TAG = 'mediamax-siri';
const SIRI_METHOD = [
  `  // @generated begin ${SIRI_TAG}: Siri "Play … in MediaMax" (modules/mediamax-car/ios/SiriIntents.swift)`,
  '  @objc(application:handlerForIntent:)',
  '  public func application(_ application: UIApplication, handlerFor intent: INIntent) -> Any? {',
  '    MediaMaxSiri.handler(for: intent)',
  '  }',
  `  // @generated end ${SIRI_TAG}`,
].join('\n');

/**
 * Adds the in-app intent handler to AppDelegate.swift (idempotent). Returns the source unchanged when
 * the class cannot be found.
 * @param {string} src
 */
function addSiriHandler(src) {
  if (src.includes(`@generated begin ${SIRI_TAG}`)) return src;
  const cls = /^[ \t]*(?:@\w+[ \t]+)*(?:public[ \t]+|open[ \t]+|final[ \t]+)*class[ \t]+AppDelegate\b[^{]*\{[ \t]*$/m.exec(src);
  if (!cls) return src;
  const at = cls.index + cls[0].length;
  let out = `${src.slice(0, at)}\n${SIRI_METHOD}\n${src.slice(at)}`;
  for (const mod of ['MediaMaxCar', 'Intents']) {
    if (!new RegExp(`^import ${mod}$`, 'm').test(out)) out = out.replace(/^(import [^\n]+\n)/m, `$1import ${mod}\n`);
  }
  return out;
}

/** @type {import('expo/config-plugins').ConfigPlugin<{ enabled: boolean }>} */
const withSiri = (config, { enabled }) => {
  config = withAppDelegate(config, (cfg) => {
    if (cfg.modResults.language !== 'swift') {
      WarningAggregator.addWarningIOS('withMediaMaxCar', 'AppDelegate is not Swift; Siri "Play … in MediaMax" is not wired up.');
      return cfg;
    }
    const next = addSiriHandler(cfg.modResults.contents);
    if (next === cfg.modResults.contents && !next.includes(`@generated begin ${SIRI_TAG}`)) {
      WarningAggregator.addWarningIOS('withMediaMaxCar', 'Could not find `class AppDelegate` in AppDelegate.swift; Siri "Play … in MediaMax" is not wired up.');
    }
    cfg.modResults.contents = next;
    return cfg;
  });
  if (!enabled) return config;
  config = withEntitlementsPlist(config, (cfg) => {
    cfg.modResults['com.apple.developer.siri'] = true;
    return cfg;
  });
  config = withInfoPlist(config, (cfg) => {
    cfg.modResults = applySiriInfoPlist(cfg.modResults, cfg.name ?? 'MediaMax');
    return cfg;
  });
  return config;
};

/**
 * @param {Record<string, any>} infoPlist
 * @param {string} appName
 */
function applySiriInfoPlist(infoPlist, appName) {
  const intents = Array.isArray(infoPlist.INIntentsSupported) ? infoPlist.INIntentsSupported : [];
  if (!intents.includes('INPlayMediaIntent')) infoPlist.INIntentsSupported = [...intents, 'INPlayMediaIntent'];
  infoPlist.INSupportedMediaCategories = ['INMediaCategoryMusic', 'INMediaCategoryAudiobooks', 'INMediaCategoryPodcasts'];
  infoPlist.NSSiriUsageDescription = infoPlist.NSSiriUsageDescription ?? `Siri can play music, audiobooks and podcasts from your server in ${appName}.`;
  return infoPlist;
}

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
  config = withSiri(config, { enabled: !!(props && props.siri) });
  config = withAndroidAuto(config);
  return config;
};

module.exports = createRunOncePlugin(withMediaMaxCar, 'withMediaMaxCar', '1.0.0');
module.exports.applySceneManifest = applySceneManifest;
module.exports.addSiriHandler = addSiriHandler;
module.exports.applySiriInfoPlist = applySiriInfoPlist;
