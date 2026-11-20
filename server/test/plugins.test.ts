import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
process.env.MEDIAMAX_DATA ??= os.tmpdir() + '/mediamax-plg-' + process.pid;
const { extractTarGz } = await import('../src/util/tar.ts');
const { compareVersions } = await import('../src/services/plugins.ts');

/** Build a tar archive in memory (ustar headers) — enough to test the extractor. */
function tarOf(entries: { name: string; data?: string; type?: string }[]): Buffer {
  const blocks: Buffer[] = [];
  for (const e of entries) {
    const data = Buffer.from(e.data ?? '');
    const h = Buffer.alloc(512);
    h.write(e.name, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124);
    h.write('00000000000\0', 136);
    h.write('        ', 148);
    h.write(e.type ?? '0', 156);
    h.write('ustar\0' + '00', 257);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('tar extraction writes files and refuses path traversal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-tar-'));
  const files = extractTarGz(tarOf([{ name: 'plugin.json', data: '{}' }, { name: 'ui/', type: '5' }, { name: 'ui/index.html', data: '<p>hi</p>' }, { name: 'evil-link', type: '2' }]), dir);
  assert.deepEqual(files.sort(), ['plugin.json', 'ui/index.html']);
  assert.equal(fs.readFileSync(path.join(dir, 'ui/index.html'), 'utf8'), '<p>hi</p>');
  assert.throws(() => extractTarGz(tarOf([{ name: '../../escape.txt', data: 'x' }]), dir), /Unsafe path/);
  assert.throws(() => extractTarGz(tarOf([{ name: '/etc/passwd-x', data: 'x' }]), dir), /Unsafe path/);
  assert.ok(!fs.existsSync(path.join(dir, '..', '..', 'escape.txt')));
});

test('version comparison', () => {
  assert.ok(compareVersions('1.10.0', '1.9.3') > 0);
  assert.ok(compareVersions('0.1.0', '0.1.0') === 0);
  assert.ok(compareVersions('2.0.0-beta', '2.0.1') < 0);
});
