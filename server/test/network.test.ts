import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { caddyfile, DEFAULT_NETWORK, findCaddy } from '../src/services/network.js';

const settings = (p: Partial<typeof DEFAULT_NETWORK.builtinHttps> = {}) => ({
  ...DEFAULT_NETWORK, mode: 'builtin' as const,
  builtinHttps: { ...DEFAULT_NETWORK.builtinHttps, domain: 'media.example.com', email: 'admin@example.com', ...p },
});

test('network defaults: direct mode, built-in proxy off, private networks trusted', () => {
  assert.equal(DEFAULT_NETWORK.mode, 'direct');
  assert.deepEqual(DEFAULT_NETWORK.trustedProxies, ['loopback', 'linklocal', 'uniquelocal']);
});

test('caddyfile proxies to Vibe, streams unbuffered, redacts tokens in the access log', () => {
  const c = caddyfile(settings(), 8484, '/logs/caddy-access.log');
  assert.match(c, /^\tadmin off$/m);
  assert.match(c, /^media\.example\.com \{$/m);
  assert.match(c, /reverse_proxy 127\.0\.0\.1:8484 \{\n\t\tflush_interval -1/);
  assert.match(c, /email admin@example\.com/);
  assert.match(c, /Strict-Transport-Security/);
  assert.match(c, /replace token REDACTED/);
  assert.doesNotMatch(c, /acme-staging/);
  // Balanced braces.
  assert.equal((c.match(/\{/g) ?? []).length, (c.match(/\}/g) ?? []).length);
});

test('caddyfile honours staging, custom ports and HSTS off', () => {
  const c = caddyfile(settings({ staging: true, hsts: false, httpPort: 8080, httpsPort: 8443, email: null }), 9000, '/x.log');
  assert.match(c, /acme-staging-v02/);
  assert.match(c, /http_port 8080/);
  assert.match(c, /https_port 8443/);
  assert.match(c, /127\.0\.0\.1:9000/);
  assert.doesNotMatch(c, /Strict-Transport-Security/);
  assert.doesNotMatch(c, /^\temail/m);
});

// When a Caddy binary is present (CI image, dev machine with MEDIAMAX_CADDY), let Caddy itself check the config.
const caddy = findCaddy();
test('caddyfile passes `caddy validate`', { skip: !caddy && 'no caddy binary' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-caddy-'));
  try {
    const file = path.join(dir, 'Caddyfile');
    fs.writeFileSync(file, caddyfile(settings({ staging: true }), 8484, path.join(dir, 'access.log')));
    execFileSync(caddy!, ['validate', '--config', file, '--adapter', 'caddyfile'], {
      env: { ...process.env, XDG_DATA_HOME: dir, XDG_CONFIG_HOME: dir }, stdio: 'pipe',
    });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
