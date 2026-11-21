/**
 * Optional external tools for the subtitle pipeline, found on PATH: alass (re-timing against the video) and
 * unrar / 7z (RAR and 7-Zip archives; ZIP is handled in-process).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { SubtitleToolsReport } from '@mediamax/shared';
import { logger } from '../../util/log.js';

const log = logger('subtitles');

/** Absolute path of an executable on PATH, or null. */
export function findOnPath(names: string[], envPath = process.env.PATH ?? ''): string | null {
  const exts = process.platform === 'win32' ? ['', ...(process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').map((e) => e.toLowerCase())] : [''];
  for (const dir of envPath.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      for (const e of exts) {
        const p = path.join(dir, name + e);
        try {
          const st = fs.statSync(p);
          if (st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0)) return p;
        } catch {
          /* not here */
        }
      }
    }
  }
  return null;
}

let cached: { at: number; report: SubtitleToolsReport } | null = null;

export function subtitleTools(force = false): SubtitleToolsReport {
  if (!force && cached && Date.now() - cached.at < 60000) return cached.report;
  const report: SubtitleToolsReport = {
    alass: process.env.MEDIAMAX_ALASS || findOnPath(['alass', 'alass-cli']),
    unrar: findOnPath(['unrar', 'unrar-free']),
    sevenZip: findOnPath(['7z', '7zz', '7za']),
  };
  cached = { at: Date.now(), report };
  return report;
}

export interface RunResult { ok: boolean; code: number | null; error: string | null; timedOut: boolean }

/** Run a tool with a timeout (killed on expiry); stderr tail is kept for the error. */
export function runTool(bin: string, args: string[], timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve) => {
    let err = '';
    let timedOut = false;
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, code: null, error: (e as Error).message, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stderr?.on('data', (d) => (err = (err + d).slice(-2000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, error: e.message, timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, error: timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : code === 0 ? null : err.trim() || `exited with ${code}`, timedOut });
    });
  });
}

/**
 * Re-time `subtitle` against `video` with alass. Returns the synced text, or null (keep the original) when alass is
 * missing, fails, times out or produces an empty file.
 */
export async function syncWithAlass(video: string, subtitle: Buffer, ext: string, timeoutMs = 5 * 60000, bin = subtitleTools().alass): Promise<Buffer | null> {
  if (!bin || !fs.existsSync(video)) return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-alass-'));
  try {
    const input = path.join(dir, `in.${ext}`);
    const output = path.join(dir, `out.${ext}`);
    fs.writeFileSync(input, subtitle);
    const r = await runTool(bin, [video, input, output], timeoutMs);
    if (!r.ok) {
      log.warn(`alass failed, keeping the original timing: ${r.error}`);
      return null;
    }
    const out = fs.existsSync(output) ? fs.readFileSync(output) : null;
    return out && out.length > 0 ? out : null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
