#!/usr/bin/env node
/**
 * Builds a standalone Vibe server: one executable (a Node single executable application, "SEA")
 * plus the web app, packed into a release archive.
 *
 *   npm run build                      # shared + server + web (web/dist must exist)
 *   node scripts/package.mjs           # archive for this machine (windows-x64, linux-x64 or linux-arm64)
 *
 * Options:
 *   --target <windows-x64|linux-x64|linux-arm64>  default: this machine
 *   --version <x.y.z | vX.Y.Z>        default: root package.json version (or $KINORA_VERSION / $MEDIAMAX_VERSION)
 *   --node <path>                     Node 22 binary to turn into the executable (default: the one running
 *                                     this script). Pass an official node(.exe) of the target platform to
 *                                     cross-build, e.g. a Windows exe from Linux.
 *   --ffmpeg-dir <dir>                folder holding ffmpeg(.exe) and ffprobe(.exe) to ship beside the binary
 *                                     (see scripts/fetch-ffmpeg.mjs); omitted = no bundled ffmpeg
 *   --out <dir>                       default: release/
 *
 * Layout: the executable embeds only the bundled server code. web/ and ffmpeg sit next to it, because the
 * server serves the web app straight from disk with @fastify/static (per-request files, Range/ETag
 * support) and runs ffmpeg as a separate process; neither can be read from inside the executable without
 * changing server code or unpacking to a temp folder at every start. Keeping them as plain files also
 * lets users swap in their own ffmpeg build.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import zlib from 'node:zlib';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SEA_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';
const TARGETS = { 'windows-x64': ['win32', 'x64'], 'linux-x64': ['linux', 'x64'], 'linux-arm64': ['linux', 'arm64'] };

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument ${a}`);
    const [k, v] = a.includes('=') ? a.slice(2).split(/=(.*)/s) : [a.slice(2), argv[++i]];
    if (v === undefined) throw new Error(`Missing value for --${k}`);
    out[k] = v;
  }
  return out;
}

function hostTarget() {
  const os = process.platform === 'win32' ? 'windows' : process.platform;
  return `${os}-${process.arch}`;
}

function log(msg) {
  process.stdout.write(`[package] ${msg}\n`);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

function copyDir(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

/** Minimal ZIP writer (deflate, no zip64): enough for a release archive and no extra dependency. */
function writeZip(zipPath, dir) {
  const files = [];
  const walk = (d, rel) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p, r);
      else files.push([p, r]);
    }
  };
  walk(dir, '');
  const chunks = [];
  const central = [];
  let offset = 0;
  // DOS date/time of "now", so extracted files don't show 1980.
  const d = new Date();
  const dosTime = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const dosDate = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  for (const [abs, rel] of files) {
    const data = fs.readFileSync(abs);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const name = Buffer.from(rel, 'utf8');
    const crc = zlib.crc32(data);
    if (offset + body.length > 0xfffffff0) throw new Error('Archive too large for a non-zip64 zip');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(dosTime, 10);
    local.writeUInt16LE(dosDate, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(dosTime, 12);
    cen.writeUInt16LE(dosDate, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    chunks.push(local, name, body);
    offset += local.length + name.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(zipPath, Buffer.concat([...chunks, cenBuf, end]));
}

/**
 * Removes the Authenticode signature from a PE file (what `signtool remove /s` does). node.exe is signed by
 * the Node.js project; injecting the app would leave a broken signature, which Windows treats worse than
 * none. The certificate table is always the last thing in the file, so drop it and clear its directory entry.
 */
function stripAuthenticode(file) {
  const buf = fs.readFileSync(file);
  const pe = buf.readUInt32LE(0x3c);
  if (buf.toString('latin1', pe, pe + 4) !== 'PE\0\0') throw new Error(`${file} is not a PE file`);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : 96); // PE32+ : PE32
  const entry = dirs + 4 * 8; // IMAGE_DIRECTORY_ENTRY_SECURITY
  const offset = buf.readUInt32LE(entry);
  const size = buf.readUInt32LE(entry + 4);
  if (!offset || !size) return false;
  if (offset + size !== buf.length) throw new Error('Unexpected PE layout: the signature is not at the end of the file');
  buf.writeUInt32LE(0, entry);
  buf.writeUInt32LE(0, entry + 4);
  buf.writeUInt32LE(0, opt + 64); // header checksum: optional for user-mode programs
  fs.writeFileSync(file, buf.subarray(0, offset));
  return true;
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function bundle(outFile) {
  const esbuild = await import('esbuild');
  const shared = path.join(root, 'shared', 'dist', 'types.js');
  if (!fs.existsSync(shared)) throw new Error('shared/dist is missing: run `npm run build` first');
  const result = await esbuild.build({
    entryPoints: [path.join(root, 'server', 'src', 'index.ts')],
    outfile: outFile,
    bundle: true,
    platform: 'node',
    target: 'node22',
    // Node 22 single executables run a CommonJS main script.
    format: 'cjs',
    // import.meta.url has no CJS equivalent; config.ts only uses it outside the executable, but it must resolve.
    define: { 'import.meta.url': '__mediamax_import_meta_url' },
    banner: {
      js: [
        "var __mediamax_import_meta_url = require('node:url').pathToFileURL(typeof __filename === 'string' ? __filename : process.execPath).href;",
        // Same effect as `--disable-warning=ExperimentalWarning` in `npm start` (node:sqlite is still flagged experimental).
        "{ const emit = process.emitWarning; process.emitWarning = function (w, o, ...rest) { const type = typeof o === 'string' ? o : o && o.type; if (type === 'ExperimentalWarning' || (w && w.name === 'ExperimentalWarning')) return; return emit.call(this, w, o, ...rest); }; }",
      ].join('\n'),
    },
    // ws' optional native speed-ups: loaded in try/catch, absent at runtime.
    external: ['bufferutil', 'utf-8-validate'],
    legalComments: 'eof',
    logLevel: 'warning',
    metafile: true,
  });
  const kb = Math.round(fs.statSync(outFile).size / 1024);
  log(`bundled server -> ${path.relative(root, outFile)} (${kb} KB, ${Object.keys(result.metafile.inputs).length} modules)`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = args.target ?? hostTarget();
  if (!TARGETS[target]) throw new Error(`Unsupported target ${target}; use one of ${Object.keys(TARGETS).join(', ')}`);
  const [platform] = TARGETS[target];
  const isWin = platform === 'win32';
  const version = String(args.version ?? process.env.KINORA_VERSION ?? process.env.MEDIAMAX_VERSION ?? JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
  if (!/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`Bad version "${version}"`);
  const nodeBin = path.resolve(args.node ?? process.execPath);
  if (!args.node && target !== hostTarget()) throw new Error(`Cross-building ${target} needs --node <official Node 22 binary for ${target}>`);
  const outDir = path.resolve(root, args.out ?? 'release');
  const webDist = path.join(root, 'web', 'dist');
  if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('web/dist is missing: run `npm run build` first');

  const work = path.join(outDir, `.work-${target}`);
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });

  // 1. One CommonJS file with every dependency.
  const bundleFile = path.join(work, 'kinora.cjs');
  await bundle(bundleFile);

  // 2. SEA preparation blob. It must be generated by the same Node version as the binary it goes into;
  //    the version check below catches a mismatched --node.
  const blob = path.join(work, 'sea-prep.blob');
  const seaConfig = path.join(work, 'sea-config.json');
  fs.writeFileSync(seaConfig, JSON.stringify({ main: bundleFile, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
  if (args.node && target === hostTarget()) {
    const v = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
    if (v !== process.version) throw new Error(`--node is ${v} but this script runs on ${process.version}; they must match`);
  }
  run(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: work });

  // 3. Copy the Node binary and inject the blob.
  const stageName = `vibe-${version}-${target}`;
  const stage = path.join(work, stageName);
  fs.mkdirSync(stage, { recursive: true });
  const exeName = isWin ? 'vibe.exe' : 'vibe';
  const exePath = path.join(stage, exeName);
  fs.copyFileSync(nodeBin, exePath);
  fs.chmodSync(exePath, 0o755);
  if (isWin && stripAuthenticode(exePath)) log('removed the Node.js signature from the copy (the result is unsigned)');
  const { inject } = require('postject');
  await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: SEA_FUSE });
  log(`built ${exeName} (${Math.round(fs.statSync(exePath).size / 1048576)} MB, from Node ${process.version})`);

  // 4. Web app, ffmpeg, helpers, docs.
  copyDir(webDist, path.join(stage, 'web'));
  // Help Centre articles (read from disk at startup, like the web app; config.helpDir = help/ next to the binary).
  copyDir(path.join(root, 'server', 'help'), path.join(stage, 'help'));
  if (args['ffmpeg-dir']) {
    const ffDir = path.resolve(args['ffmpeg-dir']);
    for (const tool of ['ffmpeg', 'ffprobe']) {
      const f = path.join(ffDir, tool + (isWin ? '.exe' : ''));
      if (!fs.existsSync(f)) throw new Error(`${f} not found`);
      fs.copyFileSync(f, path.join(stage, path.basename(f)));
      fs.chmodSync(path.join(stage, path.basename(f)), 0o755);
    }
    for (const extra of ['FFMPEG-LICENSE.txt', 'FFMPEG-SOURCE.txt']) {
      if (fs.existsSync(path.join(ffDir, extra))) fs.copyFileSync(path.join(ffDir, extra), path.join(stage, extra));
    }
    log(`bundled ffmpeg/ffprobe from ${ffDir}`);
  } else {
    log('no --ffmpeg-dir: the archive will use ffmpeg from the PATH');
  }
  const pkgDir = path.join(root, 'packaging', isWin ? 'windows' : 'linux');
  for (const f of fs.readdirSync(pkgDir)) {
    let text = fs.readFileSync(path.join(pkgDir, f), 'utf8').replaceAll('@VERSION@', version);
    // Windows tools (cmd.exe in particular) expect CRLF line endings.
    if (isWin) text = text.replace(/\r?\n/g, '\r\n');
    fs.writeFileSync(path.join(stage, f), text);
  }
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(stage, isWin ? 'LICENSE.txt' : 'LICENSE'));

  // 5. Archive + checksum.
  fs.mkdirSync(outDir, { recursive: true });
  const archive = path.join(outDir, isWin ? `${stageName}.zip` : `${stageName}.tar.gz`);
  fs.rmSync(archive, { force: true });
  if (isWin) writeZip(archive, stage); // files at the zip root: "Extract All" already makes a folder
  else run('tar', ['-czf', archive, '--owner=0', '--group=0', '-C', work, stageName]);
  fs.writeFileSync(`${archive}.sha256`, `${sha256(archive)}  ${path.basename(archive)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  log(`wrote ${path.relative(root, archive)} (${Math.round(fs.statSync(archive).size / 1048576)} MB) + .sha256`);
}

main().catch((e) => {
  process.stderr.write(`[package] ${e.message}\n`);
  process.exit(1);
});
