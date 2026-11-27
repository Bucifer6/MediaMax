import fs from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import { Worker } from 'node:worker_threads';
import type { FastifyInstance } from 'fastify';
import { logger } from './log.js';
import { dbTrace } from '../db.js';

/**
 * Leaves a trace when the server stops answering or dies, which the normal log can't do by itself: a blocked main
 * thread writes nothing, and a fatal error (out of memory) ends the process before the buffered log reaches disk.
 *
 * - A watchdog thread notices when the main thread misses its heartbeat and writes, straight to mediamax.log, how
 *   long it has been stuck, the last known memory use, which requests were in progress and the main thread's
 *   JavaScript stack at that moment (read through the inspector), and the database query running, if any.
 * - Database queries slower than 2 s are logged with their SQL when they finish.
 * - After a stall the main thread logs how long it was blocked.
 * - The JavaScript heap nearing its limit is logged (with the requests in progress) before it becomes a crash.
 * - A fatal error writes a Node diagnostic report (stack, heap, handles) into the logs folder.
 * - Every exit is logged synchronously with its exit code.
 */

const log = logger('watchdog');

/** How long the main thread may go without a heartbeat before the watchdog reports it. */
export const STALL_REPORT_MS = 10_000;
const HEARTBEAT_MS = 500;
const SLOTS = 4; // Float64: heartbeat time, heap used, heap limit, rss
const INFLIGHT_BYTES = 4096;
const QUERY_BYTES = 2048;
/** Queries slower than this are logged with their SQL when they finish. */
export const SLOW_QUERY_MS = 2000;

const inflight = new Map<object, { label: string; at: number }>();

/** "GET /api/v1/dj/status (12.3 s)" for the oldest requests still running, oldest first. */
export function inflightSummary(now = Date.now(), max = 10): string {
  const all = [...inflight.values()].sort((a, b) => a.at - b.at);
  if (!all.length) return 'none';
  const shown = all.slice(0, max).map((r) => `${r.label} (${((now - r.at) / 1000).toFixed(1)} s)`);
  return shown.join(', ') + (all.length > max ? ` and ${all.length - max} more` : '');
}

/** Tracks the requests in progress, for stall and memory reports. */
export function trackRequests(app: FastifyInstance) {
  app.addHook('onRequest', async (req) => {
    // Path only: query strings can carry tokens.
    inflight.set(req.raw, { label: `${req.method} ${(req.raw.url ?? '').split('?')[0].slice(0, 200)}`, at: Date.now() });
  });
  const done = async (req: { raw: object }) => {
    inflight.delete(req.raw);
  };
  app.addHook('onResponse', done);
  app.addHook('onRequestAbort', done);
  // A socket closed mid-request without either hook (rare): don't keep it forever.
  app.addHook('onTimeout', done);
}

const mb = (n: number) => `${Math.round(n / 1048576)} MB`;

/** Watchdog thread: reads the heartbeat; appends to the log file synchronously (the main thread may be stuck). */
const WORKER_SRC = `
const { workerData } = require('node:worker_threads');
const fs = require('node:fs');
const inspector = require('node:inspector');
const nums = new Float64Array(workerData.nums);
const lenArr = new Int32Array(workerData.len);
const text = new Uint8Array(workerData.text);
const qLen = new Int32Array(workerData.qLen);
const qText = new Uint8Array(workerData.qText);
const mb = (n) => Math.round(n / 1048576) + ' MB';
const write = (line) => { try { fs.appendFileSync(workerData.logFile, new Date().toISOString() + ' ' + line + '\\n'); } catch {} };

// Where the main thread is stuck: pause it through the inspector, read its JavaScript stack, resume it at once.
// JavaScript that loops is interrupted mid-loop; a single long native call (a read on a stalled share, a database
// lock, a synchronous child process) only answers when that call returns, which the timeout reports instead.
let capturing = false;
function captureStack(cb) {
  if (capturing) return;
  let s;
  try { s = new inspector.Session(); s.connectToMainThread(); } catch (e) { cb('unavailable (' + e.message + ')'); return; }
  capturing = true;
  let done = false;
  const finish = (txt) => {
    if (done) return;
    done = true;
    capturing = false;
    try { s.post('Debugger.resume'); } catch {}
    try { s.post('Debugger.disable'); } catch {}
    try { s.disconnect(); } catch {}
    cb(txt);
  };
  const urls = new Map();
  s.on('Debugger.scriptParsed', (m) => urls.set(m.params.scriptId, m.params.url));
  s.on('Debugger.paused', (m) => {
    const frames = (m.params.callFrames || []).slice(0, 30).map((f) =>
      (f.functionName || '(anonymous)') + ' (' + String(f.url || urls.get(f.location.scriptId) || '?').split(/[\\\\/]/).pop() + ':' + (f.location.lineNumber + 1) + ')');
    finish(frames.join(' <- ') || 'no JavaScript frames');
  });
  try { s.post('Debugger.enable', () => { try { s.post('Debugger.pause'); } catch {} }); } catch (e) { finish('unavailable (' + e.message + ')'); return; }
  setTimeout(() => finish('not in JavaScript for 5 s: stuck inside one native call (file system, database or child process)'), 5000);
}

let reportedFor = 0, nextReportAt = 0;
setInterval(() => {
  const beat = nums[0];
  if (!beat) return;
  const stuck = Date.now() - beat;
  if (stuck < workerData.stallMs) { reportedFor = 0; return; }
  if (reportedFor === beat && Date.now() < nextReportAt) return;
  reportedFor = beat;
  nextReportAt = Date.now() + 30000;
  const n = Atomics.load(lenArr, 0);
  const reqs = Buffer.from(text.slice(0, n)).toString('utf8') || 'none';
  const qn = Atomics.load(qLen, 0);
  const query = qn > 0 ? Buffer.from(qText.slice(0, qn)).toString('utf8') : null;
  write('[ERROR] watchdog: The server has not responded for ' + Math.round(stuck / 1000) +
    ' s (main thread blocked). Last known memory: heap ' + mb(nums[1]) + ' of ' + mb(nums[2]) + ', process ' + mb(nums[3]) +
    '. Requests in progress: ' + reqs + (query ? '. Database query running: ' + query : ''));
  captureStack((stack) => write('[ERROR] watchdog: Main thread stack: ' + stack));
}, 1000); // keeps this thread alive; the main side unrefs the worker, so it never holds the process open
`;

let started = false;

export function startWatchdog(logDir: string, stallMs = STALL_REPORT_MS) {
  if (started) return;
  started = true;
  const logFile = path.join(logDir, 'mediamax.log');

  // Fatal errors (out of memory, native crashes) write a diagnostic report: the only record of why the process died.
  try {
    const report = process.report as NodeJS.ProcessReport & { excludeEnv?: boolean; excludeNetwork?: boolean };
    report.directory = logDir;
    report.reportOnFatalError = true;
    report.excludeNetwork = true;
    if ('excludeEnv' in report) report.excludeEnv = true; // environment variables can hold secrets
  } catch {
    /* reports not supported in this build */
  }

  let exitLogged = false;
  process.on('exit', (code) => {
    if (exitLogged) return;
    exitLogged = true;
    try {
      fs.appendFileSync(logFile, `${new Date().toISOString()} [INFO] main: Server process exiting (code ${code})\n`);
    } catch {
      /* ignore */
    }
  });

  const numsBuf = new SharedArrayBuffer(SLOTS * 8);
  const lenBuf = new SharedArrayBuffer(4);
  const textBuf = new SharedArrayBuffer(INFLIGHT_BYTES);
  const nums = new Float64Array(numsBuf);
  const lenArr = new Int32Array(lenBuf);
  const text = new Uint8Array(textBuf);
  const qLenBuf = new SharedArrayBuffer(4);
  const qTextBuf = new SharedArrayBuffer(QUERY_BYTES);
  const qLen = new Int32Array(qLenBuf);
  const qText = new Uint8Array(qTextBuf);
  // The statement running now (one line, capped), readable by the watchdog thread while the main thread is stuck.
  const oneLine = new Map<string, Buffer>();
  dbTrace.start = (sql) => {
    let b = oneLine.get(sql);
    if (!b) {
      b = Buffer.from(sql.replace(/\s+/g, ' ').trim(), 'utf8').subarray(0, QUERY_BYTES);
      if (oneLine.size < 5000) oneLine.set(sql, b);
    }
    qText.set(b);
    Atomics.store(qLen, 0, b.length);
  };
  dbTrace.end = (sql, ms) => {
    Atomics.store(qLen, 0, 0);
    if (ms >= SLOW_QUERY_MS) log.warn(`Slow database query (${(ms / 1000).toFixed(1)} s): ${sql.replace(/\s+/g, ' ').trim().slice(0, 1500)}. Requests in progress: ${inflightSummary()}`);
  };
  const limit = v8.getHeapStatistics().heap_size_limit;

  let last = Date.now();
  let memWarnedAt = 0;
  const beat = () => {
    const now = Date.now();
    const gap = now - last - HEARTBEAT_MS;
    last = now;
    if (gap >= 2000) log.warn(`The server was blocked for ${(gap / 1000).toFixed(1)} s. Requests in progress: ${inflightSummary(now)}`);
    const mem = process.memoryUsage();
    nums[1] = mem.heapUsed;
    nums[2] = limit;
    nums[3] = mem.rss;
    const enc = Buffer.from(inflightSummary(now), 'utf8').subarray(0, INFLIGHT_BYTES);
    text.set(enc);
    Atomics.store(lenArr, 0, enc.length);
    nums[0] = now; // last: the heartbeat marks a complete snapshot
    if (mem.heapUsed > limit * 0.85 && now - memWarnedAt > 60_000) {
      memWarnedAt = now;
      log.warn(`Memory is nearly full: heap ${mb(mem.heapUsed)} of ${mb(limit)}, process ${mb(mem.rss)}. Requests in progress: ${inflightSummary(now)}`);
    }
  };
  beat();
  setInterval(beat, HEARTBEAT_MS).unref();

  try {
    const w = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { nums: numsBuf, len: lenBuf, text: textBuf, qLen: qLenBuf, qText: qTextBuf, logFile, stallMs },
      resourceLimits: { maxOldGenerationSizeMb: 16 },
    });
    w.unref();
    w.on('error', (e: Error) => log.warn(`Watchdog stopped: ${e.message}`));
  } catch (e) {
    log.warn(`Watchdog not started: ${(e as Error).message}`);
  }
}
