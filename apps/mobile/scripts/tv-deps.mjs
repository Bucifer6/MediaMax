#!/usr/bin/env node
/**
 * Switch the `react-native` dependency between stock React Native and the
 * react-native-tvos fork (which supports phones AND Apple TV / Android TV).
 *
 *   node scripts/tv-deps.mjs on     -> "react-native": "npm:react-native-tvos@<matching>"
 *   node scripts/tv-deps.mjs off    -> "react-native": "<stock version>"
 *   node scripts/tv-deps.mjs auto   -> "on" when EXPO_TV=1|true, otherwise no-op
 *                                     (used as the EAS `eas-build-pre-install` hook)
 *   add --install to run `npm install` afterwards.
 *
 * The tvOS fork publishes versions as <rn-version>-<patch>, e.g. 0.88.1-0, so we
 * keep the same React Native minor that the Expo SDK pins.
 *
 * package.json also carries `"overrides": { "react-native": "$react-native" }`. Without it, npm
 * satisfies the `react-native` peer dependency of @react-native-tvos/virtualized-lists with a second,
 * stock copy nested under node_modules/react-native/node_modules. Both copies end up in the TV
 * bundle, `fetch` is still undefined when expo-router wraps it, and the app dies at launch with
 * "TypeError: Cannot convert undefined value to object". The override pins every `react-native`
 * request to whatever the root dependency is (stock or the tvOS alias).
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const mode = process.argv[2] ?? 'auto';
const doInstall = process.argv.includes('--install');

const STOCK = pkg.mediamax?.reactNativeStock ?? '0.88.1';
const TVOS = pkg.mediamax?.reactNativeTvos ?? '0.88.1-0';
const current = pkg.dependencies['react-native'];
const isTvEnv = process.env.EXPO_TV === '1' || process.env.EXPO_TV === 'true';

let target = current;
if (mode === 'on' || (mode === 'auto' && isTvEnv)) target = `npm:react-native-tvos@${TVOS}`;
else if (mode === 'off') target = STOCK;

if (target === current) {
  console.log(`[tv-deps] react-native already ${current}`);
} else {
  pkg.dependencies['react-native'] = target;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  // The lockfile pins the other flavour; drop it so EAS / npm resolve the alias.
  const lock = path.join(root, 'package-lock.json');
  if (mode === 'auto' && existsSync(lock)) unlinkSync(lock);
  console.log(`[tv-deps] react-native: ${current} -> ${target}`);
}
if (doInstall) execSync('npm install', { cwd: root, stdio: 'inherit' });
