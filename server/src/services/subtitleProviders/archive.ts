/**
 * Subtitle archives: ZIP in-process (util/zip.ts reader), RAR / 7z through unrar or 7z when installed.
 * `pickSubtitleFile` chooses the right file from season packs by SxxEyy and ignores non-subtitle files.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readZip } from '../../util/zip.js';
import { HttpError } from '../../util/errors.js';
import { parseRelease, scoreRelease, type ReleaseInfo } from './release.js';
import { runTool, subtitleTools } from './tools.js';

export type ArchiveKind = 'zip' | 'rar' | '7z';
export interface ArchiveEntry { name: string; data: Buffer }

/** Subtitle formats we keep (MicroDVD .sub / VobSub need a frame rate or bitmaps: skipped). */
export const KEEP_EXT = new Set(['srt', 'ass', 'ssa', 'vtt']);
const MAX_ENTRY = 20 * 1024 * 1024;

export function archiveKind(buf: Buffer): ArchiveKind | null {
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x04034b50) return 'zip';
  // RAR 4 ("Rar!\x1a\x07\x00") and RAR 5 ("Rar!\x1a\x07\x01\x00") share this prefix.
  if (buf.length >= 6 && buf.subarray(0, 6).toString('latin1') === 'Rar!\x1a\x07') return 'rar';
  if (buf.length >= 6 && buf.subarray(0, 6).equals(Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]))) return '7z';
  return null;
}

/** Why an archive of this kind can't be opened here (null = it can). */
export function archiveUnsupportedReason(kind: ArchiveKind | null | undefined): string | null {
  if (kind !== 'rar' && kind !== '7z') return null;
  const t = subtitleTools();
  if (kind === 'rar' && (t.unrar || t.sevenZip)) return null;
  if (kind === '7z' && t.sevenZip) return null;
  return kind === 'rar' ? 'RAR archive: install unrar or 7z on the server to use it' : '7-Zip archive: install 7z on the server to use it';
}

function walk(dir: string, root = dir, out: ArchiveEntry[] = []): ArchiveEntry[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, root, out);
    else if (e.isFile() && fs.statSync(p).size <= MAX_ENTRY) out.push({ name: path.relative(root, p).split(path.sep).join('/'), data: fs.readFileSync(p) });
  }
  return out;
}

/** Unpack an archive into memory. Throws HttpError 422 ('unsupported_archive') when no tool can open it. */
export async function extractArchive(buf: Buffer, kind: ArchiveKind): Promise<ArchiveEntry[]> {
  if (kind === 'zip') {
    try {
      return [...readZip(buf)].filter(([name, data]) => !name.endsWith('/') && data.length <= MAX_ENTRY).map(([name, data]) => ({ name, data }));
    } catch (e) {
      throw new HttpError(422, `Could not open the ZIP archive: ${(e as Error).message}`, 'unsupported_archive');
    }
  }
  const reason = archiveUnsupportedReason(kind);
  if (reason) throw new HttpError(422, reason, 'unsupported_archive');
  const t = subtitleTools();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-subarc-'));
  try {
    const file = path.join(tmp, `archive.${kind}`);
    const out = path.join(tmp, 'out');
    fs.mkdirSync(out);
    fs.writeFileSync(file, buf);
    // Both tools refuse absolute paths and ".." by default; -p- / -p stop password prompts.
    const r = kind === 'rar' && t.unrar
      ? await runTool(t.unrar, ['x', '-o+', '-p-', '-inul', '-y', file, out + path.sep], 60000)
      : await runTool(t.sevenZip!, ['x', '-y', '-bd', '-p', `-o${out}`, file], 60000);
    if (!r.ok) throw new HttpError(422, `Could not unpack the ${kind.toUpperCase()} archive: ${r.error}`, 'unsupported_archive');
    return walk(out);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const extOf = (name: string) => (name.match(/\.([a-z0-9]+)$/i)?.[1] ?? '').toLowerCase();

/**
 * Choose the subtitle file for this media from an archive's entries.
 *  - Non-subtitle files, macOS metadata and empty files are ignored.
 *  - With a season/episode: files named for another episode are dropped; if files carry episode numbers and none
 *    is ours, there is no match (null) rather than a wrong episode.
 *  - Ties: best release match against the media name, then a language tag in the name, then size.
 */
export function pickSubtitleFile(entries: ArchiveEntry[], target: { season?: number | null; episode?: number | null; media?: ReleaseInfo | null; language?: string | null }): ArchiveEntry | null {
  const subs = entries.filter((e) => KEEP_EXT.has(extOf(e.name)) && e.data.length > 0 && !/(^|\/)(__MACOSX|\.)/.test(e.name));
  if (!subs.length) return null;
  let pool = subs;
  if (target.episode != null) {
    const parsed = subs.map((e) => ({ e, r: parseRelease(e.name.split('/').pop()!) }));
    const withEp = parsed.filter((p) => p.r.episode != null);
    const ours = withEp.filter((p) => (target.season == null || p.r.season == null || p.r.season === target.season)
      && (p.r.episode === target.episode || (p.r.episodeEnd != null && target.episode! >= p.r.episode! && target.episode! <= p.r.episodeEnd)));
    if (ours.length) pool = ours.map((p) => p.e);
    else if (withEp.length) return null;
  }
  if (pool.length === 1) return pool[0];
  const lang = (target.language ?? '').toLowerCase();
  const langRe = lang ? new RegExp(`(^|[._ \\-\\[(])(${lang === 'ro' ? 'ro|rum|ron|romanian|romana' : lang === 'en' ? 'en|eng|english' : lang})([._ \\-\\])]|$)`, 'i') : null;
  const rank = (e: ArchiveEntry) => {
    const base = e.name.split('/').pop()!;
    const s = target.media ? scoreRelease(target.media, base, { season: target.season, episode: target.episode }).score : 0;
    return s * 1e9 + (langRe?.test(base) ? 1e8 : 0) + (extOf(base) === 'srt' ? 1e7 : 0) + Math.min(e.data.length, 9e6);
  };
  return [...pool].sort((a, b) => rank(b) - rank(a))[0];
}
