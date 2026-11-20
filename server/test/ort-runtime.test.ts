import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createOrtRuntime } from '../src/services/ortRuntime.js';

/** A tiny stand-in for the onnxruntime-web npm tarball: package/dist/{ort*.mjs, ort*.wasm, other files}. */
function makeTarball(dir: string): Buffer {
  const pkg = path.join(dir, 'package');
  fs.mkdirSync(path.join(pkg, 'dist', 'nested'), { recursive: true });
  fs.writeFileSync(path.join(pkg, 'package.json'), '{"name":"onnxruntime-web","version":"1.23.2"}');
  fs.writeFileSync(path.join(pkg, 'dist', 'ort.webgpu.min.mjs'), 'export const ok = 1;\n');
  fs.writeFileSync(path.join(pkg, 'dist', 'ort-wasm-simd-threaded.jsep.wasm'), crypto.randomBytes(300_000));
  fs.writeFileSync(path.join(pkg, 'dist', 'ort.node.min.js'), 'node build, not kept');
  fs.writeFileSync(path.join(pkg, 'dist', 'nested', 'ort.evil.mjs'), 'nested, not kept');
  execFileSync('tar', ['-czf', path.join(dir, 'ort.tgz'), '-C', dir, 'package']);
  return fs.readFileSync(path.join(dir, 'ort.tgz'));
}

const integrityOf = (b: Buffer) => 'sha512-' + crypto.createHash('sha512').update(b).digest('base64');
const fetchServing = (body: Buffer, calls: { n: number }) =>
  (async () => {
    calls.n++;
    return new Response(new Uint8Array(body), { status: 200, headers: { 'content-length': String(body.length) } });
  }) as unknown as typeof fetch;

test('AI runtime: downloads on first use, keeps only top-level dist/ort*.mjs|wasm, verifies SHA-512', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ort-'));
  try {
    const tgz = makeTarball(work);
    const calls = { n: 0 };
    const rt = createOrtRuntime({ dataDir: path.join(work, 'data'), fetchImpl: fetchServing(tgz, calls), url: 'https://example.invalid/ort.tgz', integrity: integrityOf(tgz) });
    assert.equal(rt.status().state, 'idle');
    await Promise.all([rt.ensure(), rt.ensure()]); // concurrent callers share one download
    assert.equal(calls.n, 1);
    assert.equal(rt.status().state, 'ready');
    assert.deepEqual(fs.readdirSync(rt.dir).sort(), ['.complete', 'ort-wasm-simd-threaded.jsep.wasm', 'ort.webgpu.min.mjs']);
    assert.equal(fs.statSync(path.join(rt.dir, 'ort-wasm-simd-threaded.jsep.wasm')).size, 300_000);
    await rt.ensure(); // already there: no second download
    assert.equal(calls.n, 1);
    // No temporary folders left behind.
    assert.deepEqual(fs.readdirSync(path.dirname(rt.dir)), [path.basename(rt.dir)]);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('AI runtime: a tampered or wrong download is rejected and nothing is installed', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-ort-'));
  try {
    const tgz = makeTarball(work);
    const tampered = Buffer.from(tgz);
    tampered[tampered.length - 20] ^= 0xff;
    for (const [body, integrity] of [
      [tgz, integrityOf(Buffer.from('something else'))],
      [tampered, integrityOf(tgz)],
    ] as const) {
      const rt = createOrtRuntime({ dataDir: path.join(work, 'data-' + crypto.randomUUID()), fetchImpl: fetchServing(body, { n: 0 }), url: 'https://example.invalid/ort.tgz', integrity });
      await assert.rejects(rt.ensure());
      assert.equal(rt.status().state, 'error');
      assert.ok(rt.status().error);
      assert.equal(fs.existsSync(rt.dir), false);
      const parent = path.dirname(rt.dir);
      assert.deepEqual(fs.existsSync(parent) ? fs.readdirSync(parent) : [], []);
    }
    // HTTP errors are reported too.
    const rt = createOrtRuntime({ dataDir: path.join(work, 'data-404'), fetchImpl: (async () => new Response('no', { status: 404 })) as unknown as typeof fetch, url: 'https://example.invalid/x', integrity: integrityOf(tgz) });
    await assert.rejects(rt.ensure(), /HTTP 404/);
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
});
