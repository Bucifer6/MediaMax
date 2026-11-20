import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.MEDIAMAX_DATA = (await import('node:os')).tmpdir() + '/mediamax-sec-' + process.pid;
const { ratingLevel } = await import('../src/util/misc.ts');
const { isPrivateAddress } = await import('../src/util/net.ts');
const { validateRedirect } = await import('../src/services/oidc.ts');
const { registerImage, registerRemoteImage } = await import('../src/services/images.ts');

test('rating levels cover common systems; unknown is -1, unrated is null', () => {
  assert.equal(ratingLevel('PG-13'), 13);
  assert.equal(ratingLevel(' tv-ma '), 17);
  assert.equal(ratingLevel('MA 15+'), 15);
  assert.equal(ratingLevel('R18+'), 18);
  assert.equal(ratingLevel('FSK 16'), 16);
  assert.equal(ratingLevel('DE-12'), 12);
  assert.equal(ratingLevel('18+'), 18);
  assert.equal(ratingLevel('Ab 6'), 6);
  assert.equal(ratingLevel('NR'), null);
  assert.equal(ratingLevel(null), null);
  assert.equal(ratingLevel('Weird-Rating'), -1);
});

test('private address detection', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.5', '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('SSO redirects only to our own origin or the app scheme', () => {
  assert.equal(validateRedirect('https://media.example.com/login', 'https://media.example.com'), 'https://media.example.com/login');
  assert.equal(validateRedirect('mediamax://oidc', 'https://media.example.com'), 'mediamax://oidc');
  assert.throws(() => validateRedirect('https://evil.example/x', 'https://media.example.com'));
  assert.throws(() => validateRedirect('https://media.example.com.evil.example/', 'https://media.example.com'));
  assert.throws(() => validateRedirect('javascript:alert(1)', 'https://media.example.com'));
});

test('images: no local paths from remote content, no non-image local files', () => {
  assert.equal(registerRemoteImage('/config/mediamax.db'), null);
  assert.equal(registerRemoteImage('file:///etc/passwd'), null);
  assert.ok(registerRemoteImage('https://img.example/a.jpg', { untrusted: true }));
  assert.equal(registerImage('/config/mediamax.db'), null);
  assert.equal(registerImage('relative/poster.jpg'), null);
  assert.ok(registerImage('/media/movies/poster.jpg'));
});

test('smart list rules compile to bound parameters only', async () => {
  const { buildSmartWhere, normaliseFilter } = await import('../src/services/smart.ts');
  const f = normaliseFilter({ match: 'any', rules: [{ field: 'title', op: 'contains', value: "x') OR 1=1 --" }, { field: 'genre', op: 'is', value: 'Drama' }], sort: 'title', order: 'asc', limit: null });
  const w = buildSmartWhere(f);
  assert.ok(!w.sql.includes('OR 1=1'));
  assert.ok(w.params.includes("%x') OR 1=1 --%"));
  assert.match(w.sql, / OR /);
  assert.throws(() => buildSmartWhere(normaliseFilter({ match: 'all', rules: [{ field: 'year', op: 'gte', value: '1; DROP' }], sort: 'title', order: 'asc', limit: null })));
  assert.throws(() => normaliseFilter({ match: 'all', rules: [], sort: 'title', order: 'asc', limit: null } as any) && buildSmartWhere({ match: 'all', rules: [{ field: 'bogus' as any, op: 'is', value: 1 }], sort: 'title', order: 'asc', limit: null }));
});

test('smart lists never include collections or playlists', async () => {
  const { buildSmartWhere, normaliseFilter } = await import('../src/services/smart.ts');
  const w = buildSmartWhere(normaliseFilter({ match: 'any', rules: [{ field: 'type', op: 'is', value: 'track' }, { field: 'year', op: 'gte', value: 2000 }], sort: 'title', order: 'asc', limit: null }));
  assert.ok(!w.params.includes('collection') && !w.params.includes('playlist'));
  assert.ok(w.params.includes('track') && w.params.includes('movie'));
});

test('TOTP matches RFC 6238 test vectors', async () => {
  const { hotp, base32Encode, verifyTotp, totp } = await import('../src/util/totp.ts');
  const secret = Buffer.from('12345678901234567890');
  // RFC 6238 (SHA-1) at T=59s → 94287082 (8 digits); 6-digit truncation → 287082
  assert.equal(hotp(secret, Math.floor(59 / 30), 8), '94287082');
  assert.equal(hotp(secret, Math.floor(1111111109 / 30), 8), '07081804');
  const b32 = base32Encode(secret);
  assert.equal(b32, 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  const now = Date.now();
  assert.ok(verifyTotp(b32, totp(b32, now), now));
  assert.ok(verifyTotp(b32, totp(b32, now - 30000), now));
  assert.ok(!verifyTotp(b32, totp(b32, now - 120000), now));
  assert.ok(!verifyTotp(b32, 'abcdef', now));
});
