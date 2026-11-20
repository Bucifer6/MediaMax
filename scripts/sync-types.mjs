// Copies the shared API contract into the mobile app (Metro can't easily import outside its root).
import { copyFileSync, mkdirSync } from 'node:fs';
mkdirSync('apps/mobile/src/api', { recursive: true });
copyFileSync('shared/src/types.ts', 'apps/mobile/src/api/types.ts');
console.log('Synced shared/src/types.ts -> apps/mobile/src/api/types.ts');
