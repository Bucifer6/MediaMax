// @ts-check
/**
 * Android TV / Fire TV app icon (TV builds only): res/drawable-nodpi/tv_icon.png as the application icon.
 *
 * Fire TV builds a sideloaded app's 16:9 home-screen tile from this icon. @react-native-tvos/config-tv copies the same
 * file into drawable/ and every drawable-<density>/ folder; the Android build then drops the density copies as
 * duplicates of drawable/, which counts as mdpi, so the TV scaled the 512 px icon up twice and the tile showed a
 * cropped corner of it. In drawable-nodpi the bitmap is never rescaled. Used from app.config.ts as
 * ['./plugins/withTVIcon', { isTV, icon }] instead of config-tv's androidTVIcon.
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
        if (dir.startsWith('drawable')) fs.rmSync(path.join(res, dir, 'tv_icon.png'), { force: true });
      }
      const nodpi = path.join(res, 'drawable-nodpi');
      fs.mkdirSync(nodpi, { recursive: true });
      fs.copyFileSync(src, path.join(nodpi, 'tv_icon.png'));
      return cfg;
    },
  ]);
  return withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application?.[0];
    if (app) app.$['android:icon'] = '@drawable/tv_icon';
    return cfg;
  });
};
