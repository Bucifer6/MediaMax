// Copies the shared API contract into the mobile app (Metro can't easily import outside its root), and the pure
// LRC lyrics library (shared/src/lrc.ts) to the server, web and mobile app, which each compile it on their own.
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('apps/mobile/src/api', { recursive: true });
copyFileSync('shared/src/types.ts', 'apps/mobile/src/api/types.ts');
console.log('Synced shared/src/types.ts -> apps/mobile/src/api/types.ts');
for (const dest of ['server/src/services/lrc.ts', 'web/src/lyrics/lrc.ts', 'apps/mobile/src/player/lrc.ts']) {
  mkdirSync(dest.replace(/\/[^/]+$/, ''), { recursive: true });
  copyFileSync('shared/src/lrc.ts', dest);
  console.log(`Synced shared/src/lrc.ts -> ${dest}`);
}
// Playback preferences (track choice, auto-skip, subtitle clean-up, HDR colours, AutoSync maps) for every player.
for (const dest of ['server/src/services/playerPrefs.ts', 'web/src/player/playerPrefs.ts', 'apps/mobile/src/player/playerPrefs.ts']) {
  copyFileSync('shared/src/playerPrefs.ts', dest);
  console.log(`Synced shared/src/playerPrefs.ts -> ${dest}`);
}
// The stem separation DSP and model runner (shared/src/stems/) for the browser worker and the server's separation process.
for (const dir of ['web/src/stems', 'server/src/services/separation']) {
  mkdirSync(dir, { recursive: true });
  for (const f of ['dsp.ts', 'model.ts']) {
    copyFileSync(`shared/src/stems/${f}`, `${dir}/${f}`);
    console.log(`Synced shared/src/stems/${f} -> ${dir}/${f}`);
  }
}
