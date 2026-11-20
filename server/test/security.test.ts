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
