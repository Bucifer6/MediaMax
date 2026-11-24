/** An install set up before the Kinora (now Vibe) brand theme existed keeps its old default (Midnight). */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const settings = await import('../src/services/settings.ts');
const auth = await import('../src/services/auth.ts');
// State of an older server: an account and saved branding without a theme choice.
await auth.createUser({ username: 'admin', password: 'pass1234', isAdmin: true });
settings.setKv('branding', { serverName: 'Home Cinema' });
const branding = await import('../src/services/branding.ts');

test('existing installs keep Midnight; an explicit choice is never overridden', () => {
  const b = branding.getBranding();
  assert.equal(b.defaultThemeId, 'midnight');
  assert.equal(b.serverName, 'Home Cinema');
  assert.equal(branding.updateBranding({ defaultThemeId: 'mediamax' }).defaultThemeId, 'mediamax');
  assert.equal(branding.getBranding().defaultThemeId, 'mediamax');
});
