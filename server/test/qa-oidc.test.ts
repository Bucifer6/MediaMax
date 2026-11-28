import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSettings, updateSettings } from '../src/services/settings.js';
import { startLogin, finishLogin } from '../src/services/oidc.js';

test('SSO rejects missing/invalid expiry and a UserInfo identity that differs from the ID token', async () => {
  const originalSettings = getSettings().oidc;
  updateSettings({ oidc: { ...originalSettings, enabled: true, issuer: 'https://qa-idp.test', clientId: 'vibe-qa', autoCreateUsers: true } });
  const originalFetch = globalThis.fetch;
  let idToken = '';
  let userInfo: { sub: string; name: string } | null = null;
  const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) return json({ issuer: 'https://qa-idp.test', authorization_endpoint: 'https://qa-idp.test/authorize', token_endpoint: 'https://qa-idp.test/token', userinfo_endpoint: 'https://qa-idp.test/userinfo' });
    if (url.endsWith('/token')) return json({ id_token: idToken, access_token: userInfo ? 'qa-access-token' : undefined });
    if (url.endsWith('/userinfo')) return json(userInfo);
    throw new Error(`Unexpected QA request ${url}`);
  }) as typeof fetch;
  try {
    const cases = [
      { exp: undefined, sub: null, ok: false },
      { exp: 'invalid', sub: null, ok: false },
      { exp: 0, sub: null, ok: false },
      { exp: Math.floor(Date.now() / 1000) + 300, sub: 'different-user', ok: false },
      { exp: Math.floor(Date.now() / 1000) + 300, sub: 'alice', ok: true },
    ];
    const wronglyAccepted: string[] = [];
    for (const c of cases) {
      const pending = await startLogin('https://qa-media.test', 'https://qa-media.test/login', { deviceId: 'sso-qa', deviceName: 'QA', platform: 'web' });
      const claims = { iss: 'https://qa-idp.test', aud: 'vibe-qa', nonce: new URL(pending.url).searchParams.get('nonce'), sub: 'alice', preferred_username: 'qa-alice', exp: c.exp };
      idToken = `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.qa-signature`;
      userInfo = c.sub ? { sub: c.sub, name: c.sub } : null;
      const redirect = await finishLogin(pending.state, 'qa-code', pending.state);
      if (redirect.includes('#token=') !== c.ok) wronglyAccepted.push(`expiry=${String(c.exp)}, UserInfo sub=${c.sub}, expected token=${c.ok}`);
    }
    assert.deepEqual(wronglyAccepted, []);
  } finally {
    globalThis.fetch = originalFetch;
    updateSettings({ oidc: originalSettings });
  }
});
