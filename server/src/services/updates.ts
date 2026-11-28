/**
 * Server updates from GitHub releases.
 *
 * Finding: the "check-updates" scheduled task (every 12 hours unless Admin → Updates turns it off) and the
 * Check now button read the repository's releases and remember the newest one.
 *
 * Installing (Update now, or automatically when Admin → Updates allows it): only an install made by the Windows
 * setup program updates itself. Setup stops Vibe, upgrades it in the folder it is in (keeping tray or service mode,
 * the port and the data) and starts it again. Three ways to run setup, best first:
 *   - the "Vibe updater" scheduled task that setup registers (update-vibe.ps1, running as SYSTEM, startable by any
 *     signed-in user): the server only writes the version wanted to <data>/update-request.json and starts the task,
 *     which downloads the release from GitHub itself, checks it against SHA256SUMS.txt and runs setup. No Windows
 *     permission prompt and nobody at the server. In tray mode a small helper, running as the signed-in user, waits
 *     for the task and starts the tray app again (setup can't: it runs as SYSTEM there);
 *   - background service without that task (installs made before it existed): the server downloads and checks
 *     setup and runs it through a one-off "Vibe update" scheduled task, so setup is not part of the server's own
 *     task, which setup ends;
 *   - tray app without that task: with Start-Process -Verb RunAs, so Windows asks that user for permission, as
 *     setup needs administrator rights. Such installs are never updated automatically; installing this way once
 *     registers the task, and later updates need no prompt.
 * Docker, the Linux binary and the portable zip cannot replace themselves (the image, or root-owned files),
 * so they get the steps to update instead.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { isSea } from 'node:sea';
import type { UpdateInstallKind, UpdateRelease, UpdateStatus } from '@mediamax/shared';
import { config } from '../config.js';
import { getKv, getSettings, setKv } from './settings.js';
import { events } from './events.js';
import { logActivity } from './activity.js';
import { logger } from '../util/log.js';
import { HttpError, conflict } from '../util/errors.js';
import { runningAsSystem } from '../util/winpaths.js';

const log = logger('updates');

/** owner/name of the GitHub repository releases come from (MEDIAMAX_UPDATE_REPO / KINORA_UPDATE_REPO for forks). */
export const updateRepo = () => process.env.MEDIAMAX_UPDATE_REPO || 'Bucifer6/MediaMax';
const apiBase = () => (process.env.MEDIAMAX_UPDATE_API || 'https://api.github.com').replace(/\/+$/, '');
const UPDATE_TASK = 'Vibe update';
const UPDATER_TASK = 'Vibe updater';

/* ------------------------------ versions ------------------------------ */

/** Semantic version order: 1.10.0 > 1.9.3, and a pre-release sorts before its release (1.2.0-beta.1 < 1.2.0). */
export function compareSemver(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre = ''] = v.trim().replace(/^v/i, '').split('+')[0].split(/-(.*)/s);
    return { core: core.split('.').map((x) => parseInt(x, 10) || 0), pre: pre ? pre.split('.') : [] };
  };
  const x = split(a), y = split(b);
  for (let i = 0; i < 3; i++) if ((x.core[i] ?? 0) !== (y.core[i] ?? 0)) return (x.core[i] ?? 0) - (y.core[i] ?? 0);
  if (!x.pre.length || !y.pre.length) return (x.pre.length ? -1 : 0) + (y.pre.length ? 1 : 0);
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn && +p !== +q) return +p - +q;
    if (pn !== qn) return pn ? -1 : 1;
    if (!pn && p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/* ------------------------------ install kind ------------------------------ */

export function detectInstall(opts: { platform?: NodeJS.Platform; sea?: boolean; exeDir?: string; exists?: (p: string) => boolean } = {}): UpdateInstallKind {
  const platform = opts.platform ?? process.platform;
  const exists = opts.exists ?? fs.existsSync;
  const sea = opts.sea ?? isSea();
  const exeDir = opts.exeDir ?? path.dirname(process.execPath);
  if (exists('/.dockerenv') || exists('/run/.containerenv')) return 'docker';
  if (!sea) return 'source';
  if (platform === 'win32') return exists(path.join(exeDir, 'unins000.exe')) ? 'windows-setup' : 'windows-portable';
  return 'linux';
}

const MANUAL_STEPS: Record<Exclude<UpdateInstallKind, 'windows-setup'>, string> = {
  docker: 'Pull the new image and re-create the container: `docker compose pull && docker compose up -d` (Docker Compose), ' +
    'update the container in your NAS’s container manager, or run `sudo /opt/vibe/install.sh --upgrade` for the deploy kit.',
  linux: 'Download the new `vibe-<version>-linux-<arch>.tar.gz` from the release page, `sudo systemctl stop vibe`, ' +
    'remove the old `web` folder, copy the new files over the old ones, then `sudo systemctl start vibe`.',
  'windows-portable': 'This copy was installed from the zip. Download and run the new `vibe-<version>-windows-x64-setup.exe` ' +
    'from the release page (it takes over this install), or extract the new zip and run `install-service.ps1` again.',
  source: 'Pull the new release tag, then `npm ci && npm run build` and restart the server.',
};

/* ------------------------------ state ------------------------------ */

export interface Asset { name: string; browser_download_url: string; size: number }
interface GhRelease { tag_name: string; name: string | null; body: string | null; html_url: string; published_at: string | null; prerelease: boolean; draft: boolean; assets: Asset[] }

interface Saved {
  latest: UpdateRelease | null;
  checkedAt: string | null;
  lastError: string | null;
  notifiedVersion: string | null;
  /** The last automatic install: which version and when, so a failing one is not retried every half hour. */
  autoTried: { version: string; at: string } | null;
  /** `at` of the updater task's result.json already reported. */
  resultSeen: string | null;
}

const KV_KEY = 'updates.lastCheck';
const EMPTY: Saved = { latest: null, checkedAt: null, lastError: null, notifiedVersion: null, autoTried: null, resultSeen: null };
let saved: Saved | null = null;
let assets: Asset[] = [];
let state: UpdateStatus['state'] = 'idle';
let progress: number | null = null;
/** Found at start-up (Windows setup installs): the "Vibe updater" task exists, and Vibe runs as the background service. */
let updaterTask = false;
let serviceMode = false;

function load(): Saved {
  if (saved) return saved;
  saved = { ...EMPTY, ...getKv<Partial<Saved>>(KV_KEY, {}) };
  return saved;
}

function save(patch: Partial<Saved>) {
  saved = { ...load(), ...patch };
  setKv(KV_KEY, saved);
}

export function updateStatus(): UpdateStatus {
  const s = load();
  const install = detectInstall();
  const updateAvailable = !!s.latest && compareSemver(s.latest.version, config.version) > 0;
  return {
    currentVersion: config.version,
    latest: s.latest,
    updateAvailable,
    checkedAt: s.checkedAt,
    lastError: s.lastError,
    install,
    canSelfUpdate: install === 'windows-setup',
    manualSteps: install === 'windows-setup' ? null : MANUAL_STEPS[install],
    state,
    progress,
    autoCheck: getSettings().updates.autoCheck,
    autoInstall: getSettings().updates.autoInstall,
    canAutoInstall: canAutoInstall(install),
  };
}

/** Installing needs nobody at the server: the updater task, or the service (which can run setup itself). */
function canAutoInstall(install = detectInstall()) {
  return install === 'windows-setup' && (updaterTask || serviceMode);
}

function publish() {
  events.toAdmins({ type: 'update.status', status: updateStatus() });
}

/* ------------------------------ checking ------------------------------ */

const headers = () => ({ Accept: 'application/vnd.github+json', 'User-Agent': `Vibe/${config.version} (update check)` });

function toRelease(r: GhRelease): UpdateRelease {
  const notes = (r.body ?? '').trim();
  return {
    version: r.tag_name.replace(/^v/i, ''),
    name: r.name?.trim() || r.tag_name,
    notes: notes.length > 8000 ? notes.slice(0, 8000) + '\n\n…' : notes,
    publishedAt: r.published_at,
    prerelease: r.prerelease,
    url: r.html_url,
  };
}

/** Ask GitHub for the newest release (pre-releases too when the setting is on). */
export async function checkForUpdates(): Promise<UpdateStatus> {
  if (state !== 'idle') return updateStatus();
  state = 'checking';
  publish();
  try {
    const pre = getSettings().updates.includePrereleases;
    const url = `${apiBase()}/repos/${updateRepo()}/releases${pre ? '?per_page=20' : '/latest'}`;
    const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new Error(res.status === 404 ? 'No releases found' : `GitHub answered HTTP ${res.status}`);
    const body = (await res.json()) as GhRelease | GhRelease[];
    const list = (Array.isArray(body) ? body : [body]).filter((r) => !r.draft && /^v?\d+\.\d+\.\d+/.test(r.tag_name) && (pre || !r.prerelease));
    const newest = list.sort((a, b) => compareSemver(b.tag_name, a.tag_name))[0];
    if (!newest) throw new Error('No releases found');
    assets = newest.assets ?? [];
    const latest = toRelease(newest);
    save({ latest, checkedAt: new Date().toISOString(), lastError: null });
    if (compareSemver(latest.version, config.version) > 0 && load().notifiedVersion !== latest.version) {
      logActivity('server', `Vibe ${latest.version} is available (this server runs ${config.version}). Install it from Admin → Updates.`, { severity: 'info' });
      save({ notifiedVersion: latest.version });
    }
  } catch (e) {
    const msg = (e as Error).name === 'TimeoutError' ? 'GitHub did not answer in time' : (e as Error).message;
    log.warn(`Update check failed: ${msg}`);
    save({ checkedAt: new Date().toISOString(), lastError: msg });
  } finally {
    state = 'idle';
    publish();
  }
  return updateStatus();
}

/* ------------------------------ installing ------------------------------ */

/** The setup program and SHA256SUMS.txt of a release, from GitHub's own download host only. */
export function pickWindowsAssets(list: Asset[], version: string): { setup: Asset; sums: Asset } | null {
  const setup = list.find((a) => a.name === `vibe-${version}-windows-x64-setup.exe`);
  const sums = list.find((a) => a.name === 'SHA256SUMS.txt');
  // An overridden API base (tests, a GitHub Enterprise mirror) may also serve the downloads.
  const custom = process.env.MEDIAMAX_UPDATE_API ? apiBase() + '/' : null;
  const ok = (a?: Asset) => !!a && (/^https:\/\/github\.com\//i.test(a.browser_download_url) || (!!custom && a.browser_download_url.startsWith(custom)));
  return setup && sums && ok(setup) && ok(sums) ? { setup, sums } : null;
}

/** The checksum listed for `file` in a sha256sum-style file ("<hex>  <name>" or "<hex> *<name>"). */
export function checksumFor(sums: string, file: string): string | null {
  for (const line of sums.split(/\r?\n/)) {
    const m = /^([0-9a-f]{64})\s+\*?(.+?)\s*$/i.exec(line);
    if (m && m[2] === file) return m[1].toLowerCase();
  }
  return null;
}

async function download(url: string, dest: string, size: number): Promise<string> {
  const res = await fetch(url, { headers: { 'User-Agent': headers()['User-Agent'] }, signal: AbortSignal.timeout(30 * 60000) });
  if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || size || 0;
  const hash = crypto.createHash('sha256');
  const part = dest + '.part';
  const out = fs.createWriteStream(part);
  let got = 0, lastSent = 0;
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      hash.update(chunk);
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total && Date.now() - lastSent > 500) {
        progress = Math.min(1, got / total);
        lastSent = Date.now();
        publish();
      }
    }
    await new Promise<void>((resolve, reject) => out.end((e?: Error | null) => (e ? reject(e) : resolve())));
  } catch (e) {
    out.destroy();
    fs.rmSync(part, { force: true });
    throw e;
  }
  fs.renameSync(part, dest);
  return hash.digest('hex');
}

/** Download a release's setup program and check it against the release's SHA256SUMS.txt; returns the file. */
export async function downloadVerified(picked: { setup: Asset; sums: Asset }, dir = path.join(config.cacheDir, 'updates')): Promise<string> {
  const sumsRes = await fetch(picked.sums.browser_download_url, { headers: { 'User-Agent': headers()['User-Agent'] }, signal: AbortSignal.timeout(60000) });
  if (!sumsRes.ok) throw new Error(`Could not download SHA256SUMS.txt (HTTP ${sumsRes.status})`);
  const expected = checksumFor(await sumsRes.text(), picked.setup.name);
  if (!expected) throw new Error(`SHA256SUMS.txt has no checksum for ${picked.setup.name}`);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, picked.setup.name);
  const got = await download(picked.setup.browser_download_url, dest, picked.setup.size);
  if (got !== expected) {
    fs.rmSync(dest, { force: true });
    throw new HttpError(502, 'Checksum mismatch: the downloaded setup program does not match SHA256SUMS.txt. Nothing was installed.', 'checksum');
  }
  return dest;
}

/** Installed as the background service (SYSTEM, or a Windows account chosen in setup), as setup records it. */
async function isServiceMode(): Promise<boolean> {
  if (runningAsSystem()) return true;
  // Setup keeps this under SOFTWARE\Vibe (SOFTWARE\Kinora before the rename; setup moves it on upgrade).
  for (const key of ['HKLM\\SOFTWARE\\Vibe', 'HKLM\\SOFTWARE\\Kinora']) {
    const r = await run(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe'), ['query', key, '/v', 'ServiceMode']);
    if (r.code === 0) return /ServiceMode\s+REG_DWORD\s+0x1\b/i.test(r.out);
  }
  return false;
}

function run(exe: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve({ code, out: `${stdout}${stderr}`.trim() });
    });
  });
}

const sysRoot = () => process.env.SystemRoot ?? 'C:\\Windows';
const powershell = () => path.join(sysRoot(), 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const schtasksExe = () => path.join(sysRoot(), 'System32', 'schtasks.exe');
/** Where the updater task keeps its downloads and result.json (the program folder: only administrators write there). */
const updaterDir = () => path.join(path.dirname(process.execPath), 'updates');

/**
 * The PowerShell the helper runs as the signed-in user (tray mode): start the updater task, wait for it to finish,
 * then start the tray app again unless it is already running (the update failed before setup stopped it).
 */
export function trayRelaunchScript(trayExe: string): string {
  const exe = trayExe.replace(/'/g, "''");
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    `& "$env:SystemRoot\\System32\\schtasks.exe" /Run /TN '${UPDATER_TASK}' | Out-Null`,
    "$svc = New-Object -ComObject 'Schedule.Service'; $svc.Connect()",
    `$task = $svc.GetFolder('\\').GetTask('${UPDATER_TASK}')`,
    // 4 = running. Give it a moment to start, then wait (at most an hour, the task's own limit) for it to end.
    '$t = 0; while ($task.State -ne 4 -and $t -lt 30) { Start-Sleep 1; $t++ }',
    '$t = 0; while ($task.State -eq 4 -and $t -lt 3600) { Start-Sleep 2; $t += 2 }',
    'Start-Sleep 2',
    `if (-not (Get-Process VibeTray)) { Start-Process -FilePath '${exe}' }`,
  ].join('\n');
}

/** `start` arguments (after `cmd /d /c`) that run the tray helper script in its own hidden PowerShell console. */
export function helperStartArgs(powershellExe: string, encodedScript: string): string[] {
  return ['start', '""', '/min', powershellExe, '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-EncodedCommand', encodedScript];
}

/** Ask the "Vibe updater" task to install `version` (see update-vibe.ps1). */
async function startUpdaterTask(version: string) {
  fs.writeFileSync(path.join(config.dataDir, 'update-request.json'), JSON.stringify({ version }));
  if (serviceMode) {
    // Setup ends the server's own task (and what it started), but not this separate one.
    const started = await run(schtasksExe(), ['/Run', '/TN', UPDATER_TASK]);
    if (started.code) throw new Error(`Could not start the update: ${started.out || `schtasks exited with ${started.code}`}`);
    return;
  }
  // Tray app: setup stops the tray app and this server, so a detached helper starts the tray app again afterwards.
  const tray = path.join(path.dirname(process.execPath), 'VibeTray.exe');
  const encoded = Buffer.from(trayRelaunchScript(tray), 'utf16le').toString('base64');
  // Detached so it outlives this process (setup stops it). But a detached child gets no console, and PowerShell 5.1
  // exits without running anything then: Update now never started the updater task. `cmd /c start` gives PowerShell
  // its own (minimised, then hidden) console window, outside this process's job object.
  const child = spawn(path.join(sysRoot(), 'System32', 'cmd.exe'), ['/d', '/c', ...helperStartArgs(powershell(), encoded)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', (e) => reject(new Error(`Could not start the update: ${e.message}`)));
    child.once('spawn', () => resolve());
  });
  child.unref();
}

/** Start the downloaded setup program so that it outlives this process. */
async function launchSetup(setup: string) {
  const sys = sysRoot();
  const args = '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /LOG';
  if (serviceMode || (await isServiceMode())) {
    // The service (SYSTEM, or an administrator account running with highest privileges) can register a SYSTEM task.
    const schtasks = path.join(sys, 'System32', 'schtasks.exe');
    const created = await run(schtasks, ['/Create', '/F', '/TN', UPDATE_TASK, '/SC', 'ONCE', '/ST', '00:00', '/RU', 'SYSTEM', '/RL', 'HIGHEST', '/TR', `"${setup}" ${args}`]);
    if (created.code) {
      throw new Error(`Could not schedule the update: ${created.out || `schtasks exited with ${created.code}`}. ` +
        'If the service runs as a Windows account, that account must be an administrator; or run the new setup program yourself.');
    }
    const started = await run(schtasks, ['/Run', '/TN', UPDATE_TASK]);
    if (started.code) throw new Error(`Could not start the update: ${started.out || `schtasks exited with ${started.code}`}`);
    return;
  }
  // Signed-in user (tray app): setup needs administrator rights, so Windows asks for permission.
  const ps = path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const quoted = setup.replace(/'/g, "''");
  const r = await run(ps, ['-NoProfile', '-NonInteractive', '-Command',
    `Start-Process -FilePath '${quoted}' -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/LOG' -Verb RunAs -ErrorAction Stop`]);
  if (r.code) throw new HttpError(409, 'The update was not started: Windows did not get permission to run the setup program.', 'update_cancelled');
}

/** The outcome the updater task wrote (update-vibe.ps1), if any. */
export function readUpdaterResult(file = path.join(updaterDir(), 'result.json')): { ok: boolean; version: string; message: string; at: string } | null {
  try {
    const r = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<string, unknown>;
    return { ok: r.ok === true, version: String(r.version ?? ''), message: String(r.message ?? ''), at: String(r.at ?? '') };
  } catch {
    return null;
  }
}

/** Windows setup installs: is the updater task there, does Vibe run as the service, and how did the last update go. */
export async function initUpdates() {
  cleanupAfterUpdate();
  if (detectInstall() !== 'windows-setup') return;
  const [task, service] = await Promise.all([run(schtasksExe(), ['/Query', '/TN', UPDATER_TASK]), isServiceMode()]);
  updaterTask = task.code === 0;
  serviceMode = service;
  const result = readUpdaterResult();
  if (result && result.at && result.at !== load().resultSeen) {
    save({ resultSeen: result.at, ...(!result.ok && result.message ? { lastError: `The last update did not install: ${result.message}` } : {}) });
  }
  log.info(`Updates: ${updaterTask ? 'installed by the Vibe updater task' : serviceMode ? 'installed by the service' : 'need permission on this PC (no Vibe updater task)'}`);
  publish();
}

/** Remove what an earlier update left behind (old downloads, the one-off scheduled task). */
export function cleanupAfterUpdate() {
  const dir = path.join(config.cacheDir, 'updates');
  try {
    for (const f of fs.readdirSync(dir)) fs.rmSync(path.join(dir, f), { force: true });
  } catch {
    /* nothing downloaded yet */
  }
  if (detectInstall() === 'windows-setup') {
    const child = spawn(schtasksExe(), ['/Delete', '/TN', UPDATE_TASK, '/F'], { stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
  }
}

/** Update now (or an automatic update, with no actor): install the newest release (Windows setup installs only). */
export async function installUpdate(actor: { id: string; displayName: string } | null): Promise<UpdateStatus> {
  const st = updateStatus();
  if (!st.canSelfUpdate) throw conflict(`This server can't update itself. ${st.manualSteps}`);
  if (state !== 'idle') throw conflict('An update check or install is already running');
  if (!st.updateAvailable || !st.latest) throw conflict('No newer version is available. Check for updates first.');
  if (!assets.length) await checkForUpdates(); // after a restart only the summary is remembered
  const version = load().latest?.version ?? st.latest.version;
  const picked = pickWindowsAssets(assets, version);
  if (!picked) throw new HttpError(502, `Release ${version} has no Windows setup program or SHA256SUMS.txt`, 'update_assets');

  const who = actor ? { userId: actor.id, userName: actor.displayName } : {};
  const how = actor ? '' : ' (automatic update)';
  try {
    if (updaterTask) {
      // The updater task downloads and checks the release itself; it trusts nothing this process downloads.
      state = 'installing';
      progress = null;
      publish();
      logActivity('server', `Updating Vibe ${config.version} → ${version}${how}`, { ...who, severity: 'warning' });
      const startedAt = new Date().toISOString();
      await startUpdaterTask(version);
      // A failure before setup stops Vibe (download, checksum) leaves this server running: show it straight away.
      const watch = setInterval(() => {
        const r = readUpdaterResult();
        if (state !== 'installing') return clearInterval(watch);
        if (!r || !(Date.parse(r.at) > Date.parse(startedAt)) || r.ok) return;
        clearInterval(watch);
        state = 'idle';
        save({ resultSeen: r.at, lastError: `The update did not install: ${r.message}` });
        logActivity('server', `Updating Vibe to ${version} failed: ${r.message}`, { severity: 'error' });
        publish();
      }, 5000);
      watch.unref();
    } else {
      state = 'downloading';
      progress = 0;
      publish();
      const dest = await downloadVerified(picked);
      state = 'installing';
      progress = null;
      publish();
      logActivity('server', `Updating Vibe ${config.version} → ${version}${how}`, { ...who, severity: 'warning' });
      await launchSetup(dest);
    }
    // Setup now stops this process, installs, and starts Vibe again; clients wait for the new version.
    save({ lastError: null });
    // Still running long after that: setup failed or was cancelled, so allow another try.
    setTimeout(() => {
      if (state !== 'installing') return;
      state = 'idle';
      const r = updaterTask ? readUpdaterResult() : null;
      save({
        lastError: r && !r.ok && r.message
          ? `The update did not install: ${r.message}`
          : updaterTask
            ? `The setup program did not restart Vibe. See its log (${path.join(updaterDir(), 'setup.log')}).`
            : 'The setup program did not restart Vibe. See its log (Setup Log *.txt in the Windows temp folder).',
      });
      publish();
    }, 10 * 60000).unref();
    return updateStatus();
  } catch (e) {
    state = 'idle';
    progress = null;
    const msg = (e as Error).message;
    save({ lastError: msg });
    log.warn(`Update failed: ${msg}`);
    publish();
    throw e instanceof HttpError ? e : new HttpError(502, msg, 'update_failed');
  }
}

/**
 * Automatic updates (scheduled, every half hour): install a newer release when Admin → Updates allows it, nobody
 * needs to be at the server for it, and nothing would be interrupted (`busy`: playback or recordings). A version
 * that failed to install automatically is tried again a day later at the soonest.
 */
export async function maybeAutoInstall(busy: boolean, now = Date.now()): Promise<'installed' | 'skipped'> {
  const st = updateStatus();
  if (!st.autoInstall || !st.canAutoInstall || !st.updateAvailable || !st.latest || state !== 'idle' || busy) return 'skipped';
  const tried = load().autoTried;
  if (tried && tried.version === st.latest.version && now - Date.parse(tried.at) < 24 * 3600_000) return 'skipped';
  save({ autoTried: { version: st.latest.version, at: new Date(now).toISOString() } });
  log.info(`Installing Vibe ${st.latest.version} automatically`);
  await installUpdate(null);
  return 'installed';
}

/** For tests: pretend the updater task / service mode was found at start-up. */
export function setUpdateEnvironment(env: { updaterTask?: boolean; serviceMode?: boolean }) {
  if (env.updaterTask !== undefined) updaterTask = env.updaterTask;
  if (env.serviceMode !== undefined) serviceMode = env.serviceMode;
}

/** For tests. */
export function resetUpdateState() {
  saved = null;
  assets = [];
  state = 'idle';
  progress = null;
  setKv(KV_KEY, EMPTY);
}
