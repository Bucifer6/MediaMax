import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import buffer from 'node:buffer';

/**
 * Minimal, safe extractor for .tar.gz plugin packages.
 * Only regular files and directories are written; symlinks, hard links and device files are ignored.
 * Every path is resolved under `dest` (no absolute paths or "..").
 */
export function extractTarGz(archive: Buffer, dest: string, limits = { maxFiles: 2000, maxBytes: 100 * 1024 * 1024 }): string[] {
  const tar = zlib.gunzipSync(archive, { maxOutputLength: Math.min(limits.maxBytes, buffer.constants.MAX_LENGTH) });
  const written: string[] = [];
  let offset = 0;
  let longName: string | null = null;
  let total = 0;
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const str = (start: number, len: number) => header.subarray(start, start + len).toString('utf8').replace(/\0.*$/s, '');
    let name = str(0, 100);
    const prefix = str(345, 155);
    if (prefix) name = `${prefix}/${name}`;
    const size = parseInt(str(124, 12).trim() || '0', 8) || 0;
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/s, '');
      continue;
    }
    if (type === 'x' || type === 'g') {
      const m = /\d+ path=([^\n]+)\n/.exec(data.toString('utf8'));
      if (m && type === 'x') longName = m[1];
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    name = name.replace(/^\.\//, '');
    if (!name || name === '.') continue;
    const target = path.resolve(root, name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${name}`);
    if (type === '5') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (type !== '0' && type !== '\0' && type !== '7') continue; // skip links, devices, fifos
    total += size;
    if (written.length >= limits.maxFiles || total > limits.maxBytes) throw new Error('Archive is too large');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data, { mode: 0o644 });
    written.push(path.relative(root, target));
  }
  return written;
}

/** Strip a single top-level folder (archives often wrap everything in "package/"). */
export function flattenSingleRoot(dir: string) {
  const entries = fs.readdirSync(dir);
  if (entries.length === 1 && fs.statSync(path.join(dir, entries[0])).isDirectory() && !fs.existsSync(path.join(dir, 'plugin.json'))) {
    const inner = path.join(dir, entries[0]);
    for (const e of fs.readdirSync(inner)) fs.renameSync(path.join(inner, e), path.join(dir, e));
    fs.rmdirSync(inner);
  }
}

/** Create a .tar.gz from files on disk. `entries` map archive paths → absolute file paths. */
export function createTarGz(entries: { name: string; file: string }[]): Buffer {
  const blocks: Buffer[] = [];
  const header = (name: string, size: number, mtime: number) => {
    const h = Buffer.alloc(512);
    let n = name;
    let prefix = '';
    if (Buffer.byteLength(n) > 100) {
      const cut = n.lastIndexOf('/', 154);
      prefix = n.slice(0, cut);
      n = n.slice(cut + 1);
      if (Buffer.byteLength(n) > 100 || Buffer.byteLength(prefix) > 155) throw new Error(`Path too long for archive: ${name}`);
    }
    h.write(n, 0, 100);
    h.write('0000644\0', 100);
    h.write('0000000\0', 108);
    h.write('0000000\0', 116);
    h.write(size.toString(8).padStart(11, '0') + '\0', 124);
    h.write(Math.floor(mtime / 1000).toString(8).padStart(11, '0') + '\0', 136);
    h.write('        ', 148);
    h.write('0', 156);
    h.write('ustar\0' + '00', 257);
    if (prefix) h.write(prefix, 345, 155);
    let sum = 0;
    for (const b of h) sum += b;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
    return h;
  };
  for (const e of entries) {
    const st = fs.statSync(e.file);
    if (!st.isFile()) continue;
    const data = fs.readFileSync(e.file);
    blocks.push(header(e.name, data.length, st.mtimeMs), data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks), { level: 6 });
}

/** Recursively list files under `dir` as archive entries prefixed with `as`. */
export function walkFiles(dir: string, as: string): { name: string; file: string }[] {
  const out: { name: string; file: string }[] = [];
  if (!fs.existsSync(dir)) return out;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile()) out.push({ name: `${as}/${path.relative(dir, p).split(path.sep).join('/')}`, file: p });
    }
  }
  return out;
}
