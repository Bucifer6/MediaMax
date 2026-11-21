import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      const v = await fn();
      if (v) return v;
    } catch (e) {
      last = e;
    }
    await sleep(400);
  }
  throw new Error(`Timed out waiting for ${what}${last ? ` (${last.message})` : ''}`);
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** Boots `server/dist/index.js` exactly like scripts/e2e-smoke.cjs, on a free port with its own data folder. */
export async function bootServer({ repo, data, env = {} }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/dist/index.js'], {
    cwd: repo,
    env: { ...process.env, MEDIAMAX_DATA: data, MEDIAMAX_PORT: String(port), MEDIAMAX_HOST: '127.0.0.1', MEDIAMAX_NO_SCHEDULER: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  await waitFor(async () => (await fetch(`${base}/api/v1/system/info`)).ok, 40000, 'server start');
  return {
    base, port, proc,
    get log() {
      return log;
    },
    stop: () => new Promise((r) => {
      if (proc.exitCode != null) return r();
      proc.once('exit', () => r());
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }),
  };
}

/** Tiny JSON client bound to a token. */
export function client(base, token) {
  const call = async (p, init = {}) => {
    const res = await fetch(`${base}/api/v1${p}`, {
      ...init,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.body && !(init.body instanceof FormData) ? { 'content-type': 'application/json' } : {}), 'X-Kinora-Device-Id': 'screenshots', 'X-Kinora-Device-Name': 'Screenshot pipeline', ...(init.headers ?? {}) },
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${init.method ?? 'GET'} ${p} → ${res.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };
  return {
    token,
    get: (p) => call(p),
    post: (p, body) => call(p, { method: 'POST', body: body instanceof FormData ? body : JSON.stringify(body ?? {}) }),
    patch: (p, body) => call(p, { method: 'PATCH', body: JSON.stringify(body ?? {}) }),
    put: (p, body) => call(p, { method: 'PUT', body: JSON.stringify(body ?? {}) }),
    del: (p) => call(p, { method: 'DELETE' }),
    upload: (p, file, type = 'image/jpeg') => {
      const fd = new FormData();
      fd.append('file', new Blob([fs.readFileSync(file)], { type }), path.basename(file));
      return call(p, { method: 'POST', body: fd });
    },
  };
}
