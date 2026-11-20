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
