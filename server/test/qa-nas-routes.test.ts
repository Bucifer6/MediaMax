import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { createUser, issueToken } from '../src/services/auth.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-qa-nas-'));
fs.mkdirSync(path.join(root, 'Movies'));
const admin = await createUser({ username: 'qa-nas-admin', password: 'testpass123', isAdmin: true });
const token = issueToken(admin.id, { deviceId: 'qa-nas', deviceName: 'QA', platform: 'web' }).token;
const headers = { authorization: `Bearer ${token}` };
const app = await buildApp();
after(async () => { await app.close(); fs.rmSync(root, { recursive: true, force: true }); });

async function noBlockingShareCalls<T>(fn: () => Promise<T>) {
  const names = ['readdirSync', 'statSync', 'existsSync'] as const;
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const blocking: string[] = [];
  for (const name of names) (fs as any)[name] = (target: unknown, ...args: unknown[]) => {
    if (typeof target === 'string' && path.resolve(target).startsWith(root)) blocking.push(name);
    return originals[name](target, ...args);
  };
  try {
    const result = await fn();
    assert.deepEqual(blocking, [], 'share access must not hold the main server thread');
    return result;
  } finally {
    for (const name of names) (fs as any)[name] = originals[name];
  }
}

test('the admin folder picker reads share directories asynchronously', async () => {
  const r = await noBlockingShareCalls(() => app.inject({ url: `/api/v1/system/browse?path=${encodeURIComponent(root)}`, headers }));
  assert.equal(r.statusCode, 200, r.body);
  assert.ok(r.json().some((entry: any) => entry.name === 'Movies' && entry.isDirectory));
});

test('adding and editing library paths validates shares asynchronously', async () => {
  const created = await noBlockingShareCalls(() => app.inject({ method: 'POST', url: '/api/v1/libraries', headers,
    payload: { name: 'QA share', type: 'movies', paths: [root], fetchMetadata: false } }));
  assert.equal(created.statusCode, 200, created.body);
  const id = created.json().id;
  const edited = await noBlockingShareCalls(() => app.inject({ method: 'PATCH', url: `/api/v1/libraries/${id}`, headers, payload: { paths: [root] } }));
  assert.equal(edited.statusCode, 200, edited.body);
  // Let the empty background scan finish before removing its folder.
  for (let i = 0; i < 100; i++) {
    const libs = (await app.inject({ url: '/api/v1/libraries', headers })).json();
    if (!libs.find((lib: any) => lib.id === id)?.scanning) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
});
