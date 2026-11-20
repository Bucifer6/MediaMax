import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { decode, encodeCommand } from '../src/services/security/pickle.ts';
import { proxyStats } from '../src/services/security/dashboard.ts';

test('pickle: encodes fail2ban commands and decodes fail2ban replies', () => {
  // Python: pickle.dumps(['status', 'mediamax'], 2) == this encoding's structure; decode round-trips it.
  assert.deepEqual(decode(encodeCommand(['set', 'mediamax', 'unbanip', '203.0.113.9'])), ['set', 'mediamax', 'unbanip', '203.0.113.9']);
  // A real reply to `status mediamax` captured from fail2ban 1.0.2 (protocol 5; banned IPs are builtins.str(...) objects).
  const raw = Buffer.from(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'fail2ban-status-jail.hex'), 'utf8').trim(), 'hex');
  const reply = decode(raw) as unknown[];
  assert.equal(reply[0], 0);
  const actions = (reply[1] as [string, unknown][]).find((p) => p[0] === 'Actions')![1] as [string, unknown][];
  const banned = actions.find((p) => p[0] === 'Banned IP list')![1] as string[];
  assert.ok(banned.length >= 1 && banned.every((ip) => typeof ip === 'string' && /^[\d.:a-f]+$/.test(ip)), JSON.stringify(banned));
});

test('pickle: refuses anything that would run code', () => {
  // pickle.dumps(os.system, 5)
  const evil = Buffer.from('80059515000000000000008c05706f736978948c0673797374656d9493942e', 'hex');
  assert.throws(() => decode(evil), /refusing posix\.system/);
  // builtins.eval is not an allowed constructor
  const evalPickle = Buffer.from('80058c086275696c74696e73948c046576616c94939458010000003194855294' + '2e', 'hex');
  assert.throws(() => decode(evalPickle), /refusing builtins\.eval/);
});

test('proxy stats from Caddy JSON and Nginx combined logs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-proxy-'));
  const now = Date.now();
  const caddy = path.join(dir, 'access.log');
  const line = (secAgo: number, ip: string, uri: string, status: number) => JSON.stringify({ level: 'info', ts: (now - secAgo * 1000) / 1000, logger: 'http.log.access', msg: 'handled request', request: { client_ip: ip, remote_ip: '172.30.84.1', method: 'GET', uri }, status, size: 1000 });
  fs.writeFileSync(caddy, [line(10, '203.0.113.5', '/api/v1/items?token=REDACTED', 200), line(20, '203.0.113.5', '/wp-login.php', 404), line(30, '198.51.100.7', '/', 200), line(90000, '192.0.2.1', '/', 200), 'not json'].join('\n') + '\n');
  const c = proxyStats('caddy', caddy, now);
  assert.equal(c.requests24h, 3);
  assert.equal(c.uniqueIps24h, 2);
  assert.deepEqual(c.status, { s2xx: 2, s3xx: 0, s4xx: 1, s5xx: 0 });
  assert.equal(c.topIps[0].key, '203.0.113.5');
  assert.equal(c.topErrors[0].key, '404 /wp-login.php');
  const ng = path.join(dir, 'nginx.log');
  const d = new Date(now - 60000);
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  const ts = `${String(d.getUTCDate()).padStart(2, '0')}/${mon}/${d.getUTCFullYear()}:${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}:${String(d.getUTCSeconds()).padStart(2, '0')} +0000`;
  fs.writeFileSync(ng, `203.0.113.9 - - [${ts}] "GET /api/v1/auth/login HTTP/2.0" 401 50 "-" "curl"\n203.0.113.9 - - [${ts}] "GET / HTTP/2.0" 200 5000 "-" "Mozilla"\n`);
  const n = proxyStats('nginx', ng, now);
  assert.equal(n.requests24h, 2);
  assert.equal(n.status.s4xx, 1);
  assert.equal(n.bytes24h, 5050);
  assert.equal(proxyStats('nginx', path.join(dir, 'missing.log'), now).ok, false);
});
