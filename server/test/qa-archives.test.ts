import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { extractTarGz } from '../src/util/tar.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-qa-archives-'));
after(() => fs.rmSync(root, { recursive: true, force: true }));

function archive(size: string, type = '0', body = Buffer.alloc(0)) {
  const h = Buffer.alloc(512);
  h.write('entry'); h.write(size, 124, 12); h.write(type, 156);
  return zlib.gzipSync(Buffer.concat([h, body]));
}

test('truncated tar entries and non-octal sizes are rejected instead of staging incomplete data', () => {
  assert.throws(() => extractTarGz(archive('00000001000\0', '0', Buffer.from('short')), root), /archive|size|truncat/i);
  assert.throws(() => extractTarGz(archive('12garbage\0'), root), /archive|size/i);
});

test('a negative tar directory size cannot trap the main server thread in an endless loop', () => {
  const file = path.join(root, 'negative.tar.gz');
  fs.writeFileSync(file, archive('-0000001000\0', '5'));
  // A separate process and a hard timeout make this regression safe even against the broken extractor.
  const module = new URL('../src/util/tar.ts', import.meta.url).href;
  const code = `import fs from 'node:fs'; import { extractTarGz } from ${JSON.stringify(module)}; try { extractTarGz(fs.readFileSync(process.argv[1]), process.argv[2]); process.exit(2); } catch { process.exit(0); }`;
  const r = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file, path.join(root, 'negative')], { timeout: 10000 });
  assert.equal(r.error, undefined, 'the extractor hung until the subprocess timeout');
  assert.equal(r.status, 0, String(r.stderr));
});
