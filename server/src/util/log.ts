import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

type Level = 'debug' | 'info' | 'warn' | 'error';
const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const min = order[(config.logLevel as Level) ?? 'info'] ?? 20;
const ring: string[] = [];
const logFile = path.join(config.logDir, 'vibe.log');
let stream: fs.WriteStream | null = null;
try {
  stream = fs.createWriteStream(logFile, { flags: 'a' });
  // A failing log file (disk full, folder removed) must not turn into an uncaught exception that is logged again.
  stream.on('error', () => (stream = null));
} catch {
  stream = null;
}

/*
 * The console can go away while the server keeps running: the tray app that started it (and reads its output) quits
 * before setup stops the server during an update, or a terminal is closed. Writes then fail with EPIPE, emitted as an
 * 'error' event; without a listener that is an uncaught exception, which is logged, which writes to the console again,
 * and so on: an update filled vibe.log with ~100,000 lines in 16 seconds. Stop using the console once it has failed;
 * the log file keeps everything.
 */
let consoleOpen = true;
for (const s of [process.stdout, process.stderr]) s.on('error', () => (consoleOpen = false));

function toConsole(level: Level, line: string) {
  if (!consoleOpen) return;
  try {
    (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  } catch {
    consoleOpen = false;
  }
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (order[level] < min) return;
  let line = `${new Date().toISOString()} [${level.toUpperCase()}] ${scope}: ${msg}`;
  if (extra !== undefined) {
    line += ' ' + (extra instanceof Error ? extra.stack ?? extra.message : safeJson(extra));
  }
  ring.push(line);
  if (ring.length > 2000) ring.shift();
  toConsole(level, line);
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
