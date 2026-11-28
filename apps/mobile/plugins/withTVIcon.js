// @ts-check
/**
 * Android TV / Fire TV app icon (TV builds only): res/drawable-nodpi/tv_icon.png as the application icon.
 *
 * Fire TV builds a sideloaded app's 16:9 home-screen tile from the APK's icon. @react-native-tvos/config-tv copies the
 * same file into drawable/ and every drawable-<density>/ folder; the Android build then drops the density copies as
 * duplicates of drawable/, which counts as mdpi, so the TV scaled the 512 px icon up twice and the tile showed a
 * cropped corner of it. In drawable-nodpi the bitmap is never rescaled.
 *
 * The Fire TV launcher doesn't always read android:icon: it can pick the round icon or the mipmap/ic_launcher files,
 * which in an Expo build are the phone's adaptive icon (a foreground layer meant to be masked, so the tile showed it
 * zoomed in). TV builds therefore point roundIcon at the TV icon too, replace every mipmap ic_launcher bitmap with it
 * and drop the adaptive-icon XML, so whichever one the launcher reads is the same flat TV icon.
 * Used from app.config.ts as ['./plugins/withTVIcon', { isTV, icon }] instead of config-tv's androidTVIcon.
 */
const fs = require('fs');
const path = require('path');
const { withAndroidManifest, withDangerousMod } = require('expo/config-plugins');

/** @type {import('expo/config-plugins').ConfigPlugin<{ isTV?: boolean; icon?: string }>} */
module.exports = function withTVIcon(config, { isTV, icon } = {}) {
  if (!isTV || !icon) return config;
  config = withDangerousMod(config, [
    'android',
    async (cfg) => {
      const src = path.resolve(cfg.modRequest.projectRoot, icon);
      if (!fs.existsSync(src)) throw new Error(`withTVIcon: ${icon} not found`);
      const res = path.join(cfg.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      for (const dir of fs.existsSync(res) ? fs.readdirSync(res) : []) {
        const full = path.join(res, dir);
        if (dir.startsWith('drawable')) fs.rmSync(path.join(full, 'tv_icon.png'), { force: true });
        if (!dir.startsWith('mipmap')) continue;
        for (const f of fs.readdirSync(full)) {
          if (!/^ic_launcher(_round)?\.(png|webp|xml)$/.test(f)) continue;
          fs.rmSync(path.join(full, f), { force: true });
          // Adaptive-icon XML (mipmap-anydpi-v26) goes; each density's bitmap becomes the TV icon.
          if (!dir.includes('anydpi')) fs.copyFileSync(src, path.join(full, f.replace(/\.(webp|xml)$/, '.png')));
        }
      }
      const nodpi = path.join(res, 'drawable-nodpi');
      fs.mkdirSync(nodpi, { recursive: true });
      fs.copyFileSync(src, path.join(nodpi, 'tv_icon.png'));
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) {
      app.$['android:icon'] = '@drawable/tv_icon';
      app.$['android:roundIcon'] = '@drawable/tv_icon';
    }
    return cfg;
  });
};
