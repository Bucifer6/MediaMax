#!/usr/bin/env node
/**
 * Builds the Windows setup program (vibe-<version>-windows-x64-setup.exe) from the Windows release zip.
 * Runs on Windows only: it compiles the tray app with the C# compiler that ships with the .NET Framework and
 * packs everything with Inno Setup 6 (`choco install innosetup`, or set ISCC to ISCC.exe).
 *
 *   node scripts/package.mjs --target windows-x64 --ffmpeg-dir build/ffmpeg    # -> release/vibe-<v>-windows-x64.zip
 *   node scripts/build-installer.mjs                                           # -> release/vibe-<v>-windows-x64-setup.exe
 *
 * Options:
 *   --version <x.y.z>   default: root package.json version (or $KINORA_VERSION / $MEDIAMAX_VERSION)
 *   --zip <file>        default: release/vibe-<version>-windows-x64.zip
 *   --out <dir>         default: release/
 *
 * The installer itself is packaging/windows-installer/vibe.iss; the tray app is VibeTray.cs next to it.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'packaging', 'windows-installer');

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

const log = (msg) => process.stdout.write(`[installer] ${msg}\n`);

function run(cmd, args, opts = {}) {
  log(`${path.basename(cmd)} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

function firstExisting(paths) {
  return paths.filter(Boolean).find((p) => fs.existsSync(p));
}

function main() {
  if (process.platform !== 'win32') throw new Error('The Windows installer is built on Windows (it needs csc.exe and Inno Setup)');
  const args = parseArgs(process.argv.slice(2));
  const version = String(args.version ?? process.env.KINORA_VERSION ?? process.env.MEDIAMAX_VERSION ??
    JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version).replace(/^v/, '');
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m || !/^[0-9A-Za-z.+-]+$/.test(version)) throw new Error(`Bad version "${version}"`);
  const numeric = `${m[1]}.${m[2]}.${m[3]}.0`; // Windows file versions are four numbers; pre-release tags drop out
  const outDir = path.resolve(root, args.out ?? 'release');
  const zip = path.resolve(root, args.zip ?? path.join('release', `vibe-${version}-windows-x64.zip`));
  if (!fs.existsSync(zip)) throw new Error(`${zip} not found: run scripts/package.mjs --target windows-x64 first`);

  const winDir = process.env.WINDIR ?? 'C:\\Windows';
  const csc = firstExisting([path.join(winDir, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')]);
  if (!csc) throw new Error('csc.exe (.NET Framework 4) not found');
  const iscc = firstExisting([
    process.env.ISCC,
    path.join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Inno Setup 6', 'ISCC.exe'),
    path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Inno Setup 6', 'ISCC.exe'),
  ]);
  if (!iscc) throw new Error('Inno Setup 6 not found: `choco install innosetup`, or set ISCC to the path of ISCC.exe');

  const work = path.join(outDir, '.work-installer');
  const app = path.join(work, 'app');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(app, { recursive: true });

  // 1. The same files as the zip.
  // Windows' own bsdtar reads zips (Expand-Archive breaks when Windows PowerShell inherits PowerShell 7's module path).
  run(path.join(winDir, 'System32', 'tar.exe'), ['-xf', zip, '-C', app]);
  if (!fs.existsSync(path.join(app, 'vibe.exe'))) throw new Error('vibe.exe missing from the zip');

  // 2. Tray app (x64, so it sees the same registry view as the 64-bit installer).
  const tray = path.join(work, 'VibeTray.exe');
  run(csc, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', `/win32icon:${path.join(srcDir, 'vibe.ico')}`,
    '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll', `/out:${tray}`, path.join(srcDir, 'VibeTray.cs')]);

  // 3. Setup program.
  const base = `vibe-${version}-windows-x64-setup`;
  run(iscc, ['/Qp', `/DAppVersion=${version}`, `/DNumericVersion=${numeric}`, `/DSourceDir=${app}`, `/DTrayExe=${tray}`,
    `/DOutputDir=${outDir}`, `/DOutputBase=${base}`, path.join(srcDir, 'vibe.iss')]);
  const exe = path.join(outDir, `${base}.exe`);
  const hash = createHash('sha256').update(fs.readFileSync(exe)).digest('hex');
  fs.writeFileSync(`${exe}.sha256`, `${hash}  ${path.basename(exe)}\n`);
  fs.rmSync(work, { recursive: true, force: true });
  log(`wrote ${path.relative(root, exe)} (${Math.round(fs.statSync(exe).size / 1048576)} MB) + .sha256`);
}

try {
  main();
} catch (e) {
  process.stderr.write(`[installer] ${e.message}\n`);
  process.exit(1);
}
