import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(config.logLevel as Level) ?? 'info'] ?? 20;
const ring: string[] = [];
const logFile = path.join(config.logDir, 'mediamax.log');
let stream: fs.WriteStream | null = null;
try {
  stream = fs.createWriteStream(logFile, { flags: 'a' });
} catch {
  stream = null;
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${scope}: ${msg}`;
  if (extra !== undefined) {
    line += ' ' + (extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra));
  }
  ring.push(line);
  if (ring.length > 2000) ring.shift();
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  stream?.write(line + '\n');
}

function safeJson(v: unknown) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function logger(scope: string) {
  return {
    debug: (m: string, e?: unknown) => write('debug', scope, m, e),
    info: (m: string, e?: unknown) => write('info', scope, m, e),
    warn: (m: string, e?: unknown) => write('warn', scope, m, e),
    error: (m: string, e?: unknown) => write('error', scope, m, e),
  };
}

export const recentLogLines = (n: number) => ring.slice(-n);
