// Server-side AI stem separation: the onnxruntime-node first-use download (pinned, platform-filtered) and the
// separation queue running the real child process with the stub model (frequency bands) end to end.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { spawnSync, execFileSync } from 'node:child_process';

const ortNode = await import('../src/services/ortNode.ts');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-stems-native-'));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
const skip = hasFfmpeg ? false : 'ffmpeg not available';
const ff = (...args: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

/** A minimal .tar.gz (ustar, regular files only) built in memory: no tar binary needed. */
function tarGz(files: { name: string; data: Buffer | string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data);
    const h = Buffer.alloc(512);
    h.write(f.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0', 257);
    h.write('00', 263);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

/** Power of `freq` in interleaved s16le stereo (left channel), Goertzel. */
function tonePower(pcm: Buffer, freq: number, rate = 44100) {
  const n = Math.floor(pcm.length / 4);
  const k = (2 * Math.PI * freq) / rate;
  const c = 2 * Math.cos(k);
  let s1 = 0, s2 = 0;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 4) / 32768 + c * s1 - s2;
    s2 = s1;
    s1 = s;
  }
  return (s1 * s1 + s2 * s2 - c * s1 * s2) / (n * n);
}

test('GPU output check: sources must add up to the mix', async () => {
  const { chunkLooksValid } = await import('../src/services/separation/checks.ts');
  const n = 1000;
  const mix = Float32Array.from({ length: 2 * n }, (_, i) => Math.sin(i / 7) * 0.5);
  const good = new Float32Array(4 * 2 * n);
  for (let i = 0; i < 2 * n; i++) for (let k = 0; k < 4; k++) good[k * 2 * n + i] = mix[i] / 4 + (k === 0 ? 0.01 : 0);
  assert.equal(chunkLooksValid(mix, good, 4), true);
  const noise = good.map(() => Math.random() * 2 - 1);
  assert.equal(chunkLooksValid(mix, noise, 4), false, 'full-scale noise (a broken GPU driver)');
  const nan = good.slice();
  nan[123] = NaN;
  assert.equal(chunkLooksValid(mix, nan, 4), false);
  assert.equal(chunkLooksValid(new Float32Array(2 * n), new Float32Array(4 * 2 * n), 4), true, 'silence in, silence out');
});

test('native runtime: platform support and the files kept from the npm tarballs', () => {
  assert.equal(ortNode.platformUnsupported('win32', 'x64'), null);
  assert.equal(ortNode.platformUnsupported('linux', 'arm64', true), null);
  assert.match(ortNode.platformUnsupported('linux', 'x64', false)!, /glibc/);
  assert.match(ortNode.platformUnsupported('darwin', 'x64')!, /darwin\/x64/);
  assert.match(ortNode.platformUnsupported('freebsd', 'x64')!, /freebsd/);
  const keep = (pkg: string, n: string) => ortNode.keepMember(pkg, n, 'linux', 'x64');
  assert.equal(keep('onnxruntime-node', 'package/package.json'), 'package.json');
  assert.equal(keep('onnxruntime-node', 'package/dist/index.js'), 'dist/index.js');
  assert.equal(keep('onnxruntime-node', 'package/dist/index.d.ts'), null);
  assert.equal(keep('onnxruntime-node', 'package/bin/napi-v6/linux/x64/libonnxruntime.so.1'), 'bin/napi-v6/linux/x64/libonnxruntime.so.1');
  assert.equal(keep('onnxruntime-node', 'package/bin/napi-v6/win32/x64/onnxruntime.dll'), null, 'other platforms are dropped');
  assert.equal(keep('onnxruntime-common', 'package/bin/napi-v6/linux/x64/x.node'), null);
  assert.equal(keep('onnxruntime-node', 'package/../evil.js'), null);
  assert.equal(keep('onnxruntime-node', 'package/script/install.js'), null);
});

test('native runtime: both packages downloaded, SHA-512 checked, loadable; bad hash installs nothing', async () => {
  // A fake onnxruntime-node that requires onnxruntime-common, as the real one does.
  const node = tarGz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'onnxruntime-node', version: '9.9.9', main: 'dist/index.js' }) },
    { name: 'package/dist/index.js', data: "module.exports = { common: require('onnxruntime-common').marker };" },
    { name: `package/bin/napi-v6/${process.platform}/${process.arch}/binding.node`, data: 'bin' },
    { name: 'package/bin/napi-v6/other/arch/binding.node', data: 'other' },
  ]);
  const common = tarGz([
    { name: 'package/package.json', data: JSON.stringify({ name: 'onnxruntime-common', version: '9.9.9', main: 'dist/cjs/index.js' }) },
    { name: 'package/dist/cjs/index.js', data: "module.exports = { marker: 'common-ok' };" },
  ]);
  const integ = (b: Buffer) => 'sha512-' + crypto.createHash('sha512').update(b).digest('base64');
  const srv = http.createServer((req, res) => res.end(req.url === '/node.tgz' ? node : req.url === '/common.tgz' ? common : ''));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(srv.address() as any).port}`;
  try {
    const dataDir = fs.mkdtempSync(path.join(tmp, 'ortnode-'));
    const packages = [{ name: 'onnxruntime-node', url: `${base}/node.tgz`, integrity: integ(node) }, { name: 'onnxruntime-common', url: `${base}/common.tgz`, integrity: integ(common) }];
    const rt = ortNode.createOrtNodeRuntime({ dataDir, packages, unsupported: null });
    assert.equal(rt.status().state, 'idle');
    await rt.ensure();
    assert.equal(rt.status().state, 'ready');
    const found = ortNode.findOrtNode(undefined, dataDir);
    assert.equal(found?.version, '9.9.9');
    assert.equal(createRequire(import.meta.url)(found!.module).common, 'common-ok', 'loads, with its dependency beside it');
    assert.ok(fs.existsSync(path.join(rt.dir, 'node_modules/onnxruntime-node/bin/napi-v6', process.platform, process.arch, 'binding.node')));
    assert.ok(!fs.existsSync(path.join(rt.dir, 'node_modules/onnxruntime-node/bin/napi-v6/other')));

    const bad = ortNode.createOrtNodeRuntime({ dataDir: fs.mkdtempSync(path.join(tmp, 'ortnode-bad-')), packages: [packages[0], { ...packages[1], integrity: integ(node) }], unsupported: null });
    await assert.rejects(bad.ensure(), /SHA-512 mismatch/);
    assert.equal(bad.status().state, 'error');
    assert.ok(!fs.existsSync(bad.dir), 'nothing installed after a bad download');
    assert.equal(fs.readdirSync(path.dirname(bad.dir)).length, 0, 'no temp folder left behind');

    const no = ortNode.createOrtNodeRuntime({ dataDir, packages, unsupported: 'No build here' });
    assert.equal(no.status().state, 'unsupported');
    await assert.rejects(no.ensure(), /No build here/);
  } finally {
    srv.close();
  }
});

test('server separation: queued job in the child process (stub model) → FLAC stems; cancel; errors; routes', { skip }, async () => {
  const { createUser, issueToken } = await import('../src/services/auth.ts');
  const { buildApp } = await import('../src/app.ts');
  const { db } = await import('../src/db.ts');
  const now = new Date().toISOString();
  db.run('INSERT OR IGNORE INTO libraries (id, name, type, paths, created_at) VALUES (?, ?, ?, ?, ?)', 'lib-n', 'Music', 'music', JSON.stringify([tmp]), now);
  const addTrack = (id: string, file: string) => {
    db.run('INSERT INTO items (id, library_id, type, title, sort_title, added_at, updated_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', id, 'lib-n', 'track', `Track ${id}`, id, now, now, 3000);
    db.run('INSERT INTO media (id, item_id, path, container, duration_ms, size, mtime) VALUES (?,?,?,?,?,?,?)', `m-${id}`, id, file, path.extname(file).slice(1), 3000, 1, 0);
  };
  const admin = await createUser({ username: 'nadmin', password: 'pw-123456', isAdmin: true });
  const user = await createUser({ username: 'nuser', password: 'pw-123456', isAdmin: false });
  const A = { authorization: `Bearer ${issueToken(admin.id, { deviceId: 'n-a', deviceName: 'test', platform: 'web' }).token}` };
  const U = { authorization: `Bearer ${issueToken(user.id, { deviceId: 'n-u', deviceName: 'test', platform: 'web' }).token}` };
  const app = await buildApp();
  const routes = await import('../src/routes/karaoke.ts');
  const { createSeparationQueue } = await import('../src/services/separation/native.ts');
  const { updateSettings } = await import('../src/services/settings.ts');
  const k = { stemsEnabled: true, stemsModelUrl: null, stemsModelSha256: null, writeLrcSidecars: false };
  updateSettings({ karaoke: { ...k, stemsEngine: 'server' } });
  routes.setSeparationQueue(createSeparationQueue({ store: routes.stemStore(), settings: () => ({}), stub: true }));
  try {
    const f = path.join(tmp, 'native-src.flac');
    ff('-f', 'lavfi', '-i', 'sine=frequency=1000:duration=3', '-f', 'lavfi', '-i', 'sine=frequency=100:duration=3', '-filter_complex', 'amix=inputs=2', '-ac', '2', f);
    addTrack('t-native', f);
    const st = (await app.inject({ url: '/api/v1/stems/status', headers: A })).json();
    assert.equal(st.engine, 'server');
    assert.equal(typeof st.native.supported, 'boolean');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/items/t-native/stems/prepare', headers: U })).statusCode, 403);
    const r = await app.inject({ method: 'POST', url: '/api/v1/items/t-native/stems/prepare', headers: A });
    assert.equal(r.statusCode, 200, r.body);
    assert.equal(r.json().preparing, true);
    assert.ok(['queued', 'running'].includes(r.json().job.state));
    await routes.separationQueue().idle();
    const done = (await app.inject({ url: '/api/v1/items/t-native/stems', headers: U })).json();
    assert.equal(done.error, null, done.error);
    assert.equal(done.ready, true);
    assert.equal(done.job, null);
    assert.equal(done.backend, 'stub');
    assert.equal(done.model, 'stub-bands');
    assert.ok(Math.abs(done.frames - 3 * 44100) < 2048, `frames ${done.frames}`);
    // The stub splits by frequency band: 1 kHz lands in "vocals" (300 Hz – 3 kHz), 100 Hz in "bass".
    const pcm = (stem: string) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', routes.stemStore().stemFile('t-native', stem), '-f', 's16le', '-ac', '2', '-ar', '44100', '-']);
    const v = pcm('vocals'), b = pcm('bass');
    assert.ok(tonePower(v, 1000) > 100 * tonePower(v, 100), 'vocals stem holds the 1 kHz tone');
    assert.ok(tonePower(b, 100) > 100 * tonePower(b, 1000), 'bass stem holds the 100 Hz tone');
    assert.equal(fs.readdirSync(routes.stemStore().root).filter((n) => n.startsWith('.native-')).length, 0, 'temp folder removed');

    // Cancel: nothing is installed and no error is reported.
    await app.inject({ method: 'DELETE', url: '/api/v1/items/t-native/stems', headers: A });
    await app.inject({ method: 'POST', url: '/api/v1/items/t-native/stems/prepare', headers: A });
    assert.deepEqual((await app.inject({ method: 'DELETE', url: '/api/v1/items/t-native/stems/prepare', headers: A })).json(), { cancelled: true });
    await routes.separationQueue().idle();
    const cancelled = (await app.inject({ url: '/api/v1/items/t-native/stems', headers: U })).json();
    assert.equal(cancelled.ready, false);
    assert.equal(cancelled.error, null);

    // A file FFmpeg can't decode: the error is reported on the track.
    const broken = path.join(tmp, 'broken.flac');
    fs.writeFileSync(broken, 'not audio');
    addTrack('t-broken', broken);
    await app.inject({ method: 'POST', url: '/api/v1/items/t-broken/stems/prepare', headers: A });
    await routes.separationQueue().idle();
    assert.match((await app.inject({ url: '/api/v1/items/t-broken/stems', headers: U })).json().error, /decode/);

    // Browser engine: the server route refuses.
    updateSettings({ karaoke: { ...k, stemsEngine: 'browser' } });
    assert.equal((await app.inject({ url: '/api/v1/stems/status', headers: A })).json().engine, 'browser');
    assert.equal((await app.inject({ method: 'POST', url: '/api/v1/items/t-native/stems/prepare', headers: A })).statusCode, 400);
  } finally {
    routes.setSeparationQueue(null);
    await app.close();
  }
});
