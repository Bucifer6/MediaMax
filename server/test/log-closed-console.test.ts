/**
 * When whoever reads the server's console goes away (the tray app quitting before setup stops the server during an
 * update), logging must carry on into vibe.log without the EPIPE -> uncaught exception -> log -> EPIPE loop that once
 * wrote ~100,000 lines in 16 seconds.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same uncaughtException handler as src/index.ts. Waits for the parent to close the pipes, then logs 20 errors.
const child = `
const { logger } = await import('./src/util/log.ts');
const log = logger('t');
process.on('uncaughtException', (e) => log.error('Uncaught exception', e));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
await wait(700);
for (let i = 0; i < 20; i++) { log.error('line ' + i); await wait(25); }
await wait(700);
process.exit(0);
`;

test('logging carries on into the log file, without a flood, after the console is closed', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-log-'));
  try {
    const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', 'tsx', '--input-type=module', '-e', child], {
      cwd: serverDir,
      env: { ...process.env, MEDIAMAX_DATA: dir, MEDIAMAX_LOG_LEVEL: 'info' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Like the tray app quitting: nobody reads the server's output any more.
    p.stdout!.destroy();
    p.stderr!.destroy();
    const code = await new Promise<number | null>((resolve) => {
      const t = setTimeout(() => (p.kill(), resolve(null)), 20000);
      p.on('exit', (c) => (clearTimeout(t), resolve(c)));
    });
    assert.equal(code, 0, 'the process should finish normally');
    const lines = fs.readFileSync(path.join(dir, 'logs', 'vibe.log'), 'utf8').split('\n');
    assert.equal(lines.filter((l) => /\] t: line \d+$/.test(l)).length, 20, 'every line reaches the log file');
    const epipe = lines.filter((l) => l.includes('EPIPE')).length;
    assert.equal(epipe, 0, `${epipe} EPIPE lines were logged`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
