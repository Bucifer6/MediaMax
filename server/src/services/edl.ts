import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { Marker } from '@mediamax/shared';
import { db } from '../db.js';
import { parseJson } from '../util/misc.js';
import { getSettings } from './settings.js';
import { logger } from '../util/log.js';
import { config } from '../config.js';

const log = logger('edl');

export { parseEdl } from '../util/edl.js';
import { parseEdl } from '../util/edl.js';

export const edlPathFor = (mediaPath: string) => path.join(path.dirname(mediaPath), `${path.basename(mediaPath, path.extname(mediaPath))}.edl`);

/** Replace an item's commercial markers with those from `<video>.edl`, if present. Returns the number imported. */
export function importSidecarEdl(itemId: string, mediaPath: string): number {
  const edl = edlPathFor(mediaPath);
  let text: string;
  try {
    const st = fs.statSync(edl);
    if (!st.isFile() || st.size > 1024 * 1024) return 0;
    text = fs.readFileSync(edl, 'utf8');
  } catch {
    return 0;
  }
  return applyEdl(itemId, text);
}

/** importSidecarEdl without blocking the server: the scanner checks every file, usually on a network share. */
export async function importSidecarEdlAsync(itemId: string, mediaPath: string): Promise<number> {
  const edl = edlPathFor(mediaPath);
  let text: string;
  try {
    const st = await fs.promises.stat(edl);
    if (!st.isFile() || st.size > 1024 * 1024) return 0;
    text = await fs.promises.readFile(edl, 'utf8');
  } catch {
    return 0;
  }
  return applyEdl(itemId, text);
}

function applyEdl(itemId: string, text: string): number {
  const commercials = parseEdl(text);
  const row = db.get<{ markers: string }>('SELECT markers FROM items WHERE id = ?', itemId);
  if (!row) return 0;
  const current = parseJson<Marker[]>(row.markers, []);
  const next = [...current.filter((m) => m.type !== 'commercial'), ...commercials].sort((a, b) => a.startMs - b.startMs);
  if (JSON.stringify(next) !== JSON.stringify(current)) db.run('UPDATE items SET markers = ? WHERE id = ?', JSON.stringify(next), itemId);
  return commercials.length;
}

/**
 * Run comskip on a finished recording (when enabled) so it writes `<recording>.edl` next to the file.
 * Resolves true when an EDL was produced.
 */
export function runComskip(file: string): Promise<boolean> {
  const cfg = getSettings().dvr;
  if (!cfg.commercialDetection) return Promise.resolve(false);
  const bin = cfg.comskipPath || 'comskip';
  const args = ['--quiet', `--output=${path.dirname(file)}`];
  let ini = cfg.comskipIni;
  if (!ini) {
    // comskip's built-in defaults write a .txt list, not an EDL; use a minimal ini that asks for EDL only.
    ini = path.join(config.cacheDir, 'comskip-mediamax.ini');
    if (!fs.existsSync(ini)) fs.mkdirSync(path.dirname(ini), { recursive: true }), fs.writeFileSync(ini, 'output_edl=1\noutput_default=0\noutput_framearray=0\n');
  }
  args.push(`--ini=${ini}`);
  args.push(file);
  return new Promise((resolve) => {
    let p;
    try {
      p = spawn(bin, args, { stdio: 'ignore' });
    } catch (e) {
      log.warn(`comskip could not start: ${(e as Error).message}`);
      return resolve(false);
    }
    const timer = setTimeout(() => p.kill('SIGKILL'), 3 * 3600_000);
    p.on('error', (e) => {
      clearTimeout(timer);
      log.warn(`comskip could not start (${bin}): ${e.message}`);
      resolve(false);
    });
    p.on('exit', () => {
      clearTimeout(timer);
      // comskip exits 1 when it finds commercials, 0 when it finds none; both are fine.
      for (const ext of ['.log', '.logo.txt']) fs.rmSync(path.join(path.dirname(file), path.basename(file, path.extname(file)) + ext), { force: true });
      resolve(fs.existsSync(edlPathFor(file)));
    });
  });
}
