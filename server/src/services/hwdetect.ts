/**
 * Hardware transcoding detection: what the ffmpeg build supports, which GPUs/devices exist, and — for each
 * method — real 2-second test transcodes built with the same pipeline builders playback uses.
 *
 * POST /api/v1/admin/transcoding/detect runs it; the last report is kept in memory for the server's lifetime
 * and also steers playback (failed encoders and tone-mappers are skipped).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import type { HwAccel, HwDetectReport, HwDevice, HwMethodResult, HwTestResult, ToneMapPath, TranscodeVideoCodec } from '@mediamax/shared';
import { config } from '../config.js';
import { logger } from '../util/log.js';
import { getSettings } from './settings.js';
import { listCaps, setDetectReport, getDetectReport } from './transcoder.js';
import { HW_LABELS, TONEMAP_FILTERS, buildVideoPipeline, encoderArgs, encoderFor, rateArgs, toneMapCandidates, type HwTarget } from './hwaccel.js';

const log = logger('hwdetect');
const CODECS: TranscodeVideoCodec[] = ['h264', 'hevc', 'av1'];
const TEST_TIMEOUT_MS = 20000;

/* ------------------------------ helpers ------------------------------ */

export interface RunResult { ok: boolean; error: string | null; fps: number | null; timedOut: boolean }

/** Run ffmpeg with a timeout; parse -progress output for the frame rate. */
export function runFfmpeg(args: string[], timeoutMs = TEST_TIMEOUT_MS, bin = config.ffmpeg): Promise<RunResult> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let out = '';
    let err = '';
    let timedOut = false;
    let p: ReturnType<typeof spawn>;
    try {
      p = spawn(bin, ['-hide_banner', '-nostdin', '-loglevel', 'error', '-progress', 'pipe:1', '-nostats', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, error: (e as Error).message, fps: null, timedOut: false });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGKILL');
    }, timeoutMs);
    p.stdout?.on('data', (d) => (out = (out + d).slice(-4000)));
    p.stderr?.on('data', (d) => (err = (err + d).slice(-8000)));
    p.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.message, fps: null, timedOut });
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      const frames = [...out.matchAll(/^frame=(\d+)/gm)].pop()?.[1];
      const secs = (Date.now() - t0) / 1000;
      const fps = frames && Number(frames) > 0 ? Math.round((Number(frames) / Math.max(secs, 0.05)) * 10) / 10 : null;
      if (code === 0 && !timedOut) resolve({ ok: true, error: null, fps, timedOut });
      else resolve({ ok: false, error: timedOut ? `Timed out after ${Math.round(timeoutMs / 1000)}s` : errorSnippet(err) || `ffmpeg exited with code ${code}`, fps: null, timedOut });
    });
  });
}

/** The useful part of ffmpeg's error output: the last few distinct lines. */
export function errorSnippet(stderr: string): string {
  const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
  return [...new Set(lines)].slice(-4).join(' | ').slice(0, 500);
}

function cmd(bin: string, args: string[], timeout = 5000): string | null {
  try {
    const r = spawnSync(bin, args, { encoding: 'utf8', timeout });
    if (r.error || r.status !== 0) return null;
    return `${r.stdout ?? ''}${r.stderr ?? ''}`;
  } catch {
    return null;
  }
}

const readText = (p: string) => { try { return fs.readFileSync(p, 'utf8').trim(); } catch { return null; } };

export function parseHwaccels(out: string): string[] {
  return out.split('\n').map((l) => l.trim()).filter((l) => l && !/hardware acceleration methods/i.test(l));
}

const RELEVANT_ENCODER = /^(h264|hevc|av1)_(vaapi|nvenc|qsv|videotoolbox|v4l2m2m|amf|rkmpp|mf)$|^(libx264|libx265|libsvtav1|libaom-av1)$/;
const RELEVANT_FILTER = /^(scale_(vaapi|cuda|qsv|rkrga|vt|npp)|vpp_qsv|tonemap(_vaapi|_opencl|_cuda|_videotoolbox)?|libplacebo|zscale|hwupload(_cuda)?|hwmap|hwdownload|overlay_(vaapi|cuda|qsv))$/;

/* ------------------------------ devices ------------------------------ */

const VENDORS: Record<string, HwDevice['vendor']> = { '0x8086': 'intel', '0x1002': 'amd', '0x1022': 'amd', '0x10de': 'nvidia' };
const DRIVER_VENDOR: Record<string, HwDevice['vendor']> = { i915: 'intel', xe: 'intel', amdgpu: 'amd', radeon: 'amd', nouveau: 'nvidia', nvidia: 'nvidia', v3d: 'broadcom', vc4: 'broadcom', rockchip: 'rockchip', panfrost: 'rockchip', panthor: 'rockchip' };

export function vendorFromName(name: string): HwDevice['vendor'] {
  if (/nvidia|geforce|quadro|tesla|rtx/i.test(name)) return 'nvidia';
  if (/amd|radeon|ati /i.test(name)) return 'amd';
  if (/intel|arc|uhd|iris/i.test(name)) return 'intel';
  if (/apple/i.test(name)) return 'apple';
  return 'unknown';
}

/** Parse `nvidia-smi -L`: "GPU 0: NVIDIA GeForce RTX 3060 (UUID: GPU-…)". */
export function parseNvidiaSmi(out: string): HwDevice[] {
  return [...out.matchAll(/^GPU (\d+):\s*(.+?)(?:\s*\(UUID.*)?$/gm)].map((m) => ({
    kind: 'nvidia' as const, path: null, name: m[2].trim(), driver: 'nvidia', vendor: 'nvidia' as const, index: Number(m[1]),
  }));
}

/** VA-API driver name from vainfo output, e.g. "Intel iHD driver …" or "Mesa Gallium driver … for AMD Radeon …". */
export function parseVainfo(out: string): string | null {
  const m = out.match(/Driver version:\s*(.+)/i);
  return m ? m[1].trim() : null;
}

function linuxDevices(): HwDevice[] {
  const devs: HwDevice[] = [];
  let nodes: string[] = [];
  try { nodes = fs.readdirSync('/dev/dri').filter((n) => /^renderD\d+$/.test(n)).sort(); } catch { /* none */ }
  for (const n of nodes) {
    const sys = `/sys/class/drm/${n}/device`;
    let driver: string | null = null;
    try { driver = path.basename(fs.readlinkSync(`${sys}/driver`)); } catch { /* unknown */ }
    const vendorId = readText(`${sys}/vendor`);
    const vendor = (vendorId && VENDORS[vendorId]) || (driver && DRIVER_VENDOR[driver]) || 'unknown';
    const va = cmd('vainfo', ['--display', 'drm', '--device', `/dev/dri/${n}`]);
    const vaDriver = va ? parseVainfo(va) : null;
    devs.push({ kind: 'dri', path: `/dev/dri/${n}`, name: vaDriver ?? `${vendor === 'unknown' ? 'GPU' : vendor.toUpperCase()} (${driver ?? 'unknown driver'})`, driver: vaDriver ? `${driver ?? '?'} / ${vaDriver}` : driver, vendor, index: null });
  }
  const smi = cmd('nvidia-smi', ['-L']);
  if (smi) devs.push(...parseNvidiaSmi(smi));
  else if (fs.existsSync('/dev/nvidia0')) devs.push({ kind: 'nvidia', path: '/dev/nvidia0', name: 'NVIDIA GPU (nvidia-smi not found)', driver: 'nvidia', vendor: 'nvidia', index: 0 });
  // V4L2 memory-to-memory encoders (Raspberry Pi 4 and other ARM boards).
  try {
    for (const v of fs.readdirSync('/sys/class/video4linux')) {
      const name = readText(`/sys/class/video4linux/${v}/name`) ?? '';
      if (/enc/i.test(name)) devs.push({ kind: 'v4l2', path: `/dev/${v}`, name, driver: null, vendor: /bcm2835/i.test(name) ? 'broadcom' : 'unknown', index: null });
    }
  } catch { /* none */ }
  const compat = readText('/proc/device-tree/compatible')?.replace(/\0/g, ' ') ?? '';
  const rk = compat.match(/rockchip,(rk\d+)/);
  if (rk || fs.existsSync('/dev/mpp_service')) devs.push({ kind: 'rockchip', path: fs.existsSync('/dev/mpp_service') ? '/dev/mpp_service' : null, name: `Rockchip ${rk?.[1]?.toUpperCase() ?? 'SoC'}`, driver: 'rkmpp', vendor: 'rockchip', index: null });
  return devs;
}

function windowsDevices(): HwDevice[] {
  const out = cmd('powershell', ['-NoProfile', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'], 10000)
    ?? cmd('wmic', ['path', 'win32_VideoController', 'get', 'name'], 10000);
  if (!out) return [];
  return out.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l.toLowerCase() !== 'name' && !/basic display|remote display/i.test(l))
    .map((name, index) => ({ kind: 'windows-gpu' as const, path: null, name, driver: null, vendor: vendorFromName(name), index }));
}

export function findDevices(platform = process.platform): HwDevice[] {
  if (platform === 'linux') return linuxDevices();
  if (platform === 'win32') return windowsDevices();
  if (platform === 'darwin') return [{ kind: 'apple', path: null, name: cmd('sysctl', ['-n', 'machdep.cpu.brand_string'])?.trim() || 'Apple VideoToolbox', driver: null, vendor: 'apple', index: null }];
  return [];
}

/* ------------------------------ methods ------------------------------ */

/** A method to test (or to report as unavailable). */
export interface Candidate {
  hwAccel: HwAccel;
  label: string;
  device: string | null;
  gpuIndex: number | null;
  deviceName: string | null;
  /** Why it can't be tested here (null = test it). */
  unavailable: string | null;
}

/** Which methods apply to this platform, with the device each one would use. Pure: unit tested. */
export function planCandidates(platform: string, devices: HwDevice[], encoders: Set<string>): Candidate[] {
  const out: Candidate[] = [];
  const has = (e: string) => encoders.has(e);
  const missingEnc = (hw: HwAccel) => (has(encoderFor(hw, 'h264')!) ? null : `This ffmpeg build has no ${encoderFor(hw, 'h264')} encoder.`);
  const c = (hw: HwAccel, d: Partial<Candidate>): Candidate => ({ hwAccel: hw, label: HW_LABELS[hw], device: null, gpuIndex: null, deviceName: null, unavailable: null, ...d });
  if (platform === 'linux') {
    const dri = devices.filter((d) => d.kind === 'dri' && d.vendor !== 'nvidia');
    if (!dri.length) out.push(c('vaapi', { unavailable: 'No /dev/dri/renderD* device found. In Docker, pass --device /dev/dri (and add the render group).' }));
    for (const d of dri) {
      const amd = d.vendor === 'amd';
      out.push(c('vaapi', { label: amd ? 'VA-API (AMD Radeon)' : d.vendor === 'intel' ? 'VA-API (Intel)' : HW_LABELS.vaapi, device: d.path, deviceName: d.name, unavailable: missingEnc('vaapi') }));
    }
    const intel = dri.filter((d) => d.vendor === 'intel');
    if (!intel.length) out.push(c('qsv', { unavailable: dri.length ? 'No Intel GPU found (Quick Sync needs an Intel iGPU or Arc card).' : 'No /dev/dri render device found.' }));
    for (const d of intel) out.push(c('qsv', { device: d.path, deviceName: d.name, unavailable: missingEnc('qsv') }));
    const nv = devices.filter((d) => d.kind === 'nvidia');
    if (!nv.length) out.push(c('nvenc', { unavailable: 'No NVIDIA GPU found (nvidia-smi not available). In Docker, use the NVIDIA Container Toolkit (--gpus all).' }));
    for (const d of nv) out.push(c('nvenc', { gpuIndex: d.index ?? 0, deviceName: d.name, unavailable: missingEnc('nvenc') }));
    const v4l = devices.filter((d) => d.kind === 'v4l2');
    out.push(c('v4l2m2m', v4l.length ? { device: v4l[0].path, deviceName: v4l[0].name, unavailable: missingEnc('v4l2m2m') } : { unavailable: 'No V4L2 memory-to-memory encoder found (/dev/video*). Raspberry Pi 5 has no hardware H.264 encoder.' }));
    const rk = devices.find((d) => d.kind === 'rockchip');
    out.push(c('rkmpp', rk
      ? { deviceName: rk.name, device: rk.path, unavailable: has('h264_rkmpp') ? null : `${rk.name} detected, but this ffmpeg build has no rkmpp encoders — use an ffmpeg-rockchip / jellyfin-ffmpeg build.` }
      : { unavailable: has('h264_rkmpp') ? 'No Rockchip MPP device (/dev/mpp_service) found.' : 'Not a Rockchip device (and this ffmpeg build has no rkmpp encoders).' }));
  } else if (platform === 'win32') {
    const gpus = devices.filter((d) => d.kind === 'windows-gpu');
    const pick = (vendor: HwDevice['vendor']) => gpus.filter((g) => g.vendor === vendor || g.vendor === 'unknown');
    const add = (hw: HwAccel, vendor: HwDevice['vendor'], none: string) => {
      const list = pick(vendor);
      if (!list.length) out.push(c(hw, { unavailable: none }));
      for (const g of list) out.push(c(hw, { gpuIndex: g.index ?? 0, deviceName: g.name, unavailable: missingEnc(hw) }));
    };
    add('nvenc', 'nvidia', 'No NVIDIA GPU found.');
    add('qsv', 'intel', 'No Intel GPU found.');
    add('amf', 'amd', 'No AMD GPU found.');
  } else if (platform === 'darwin') {
    out.push(c('videotoolbox', { deviceName: devices[0]?.name ?? null, unavailable: missingEnc('videotoolbox') }));
  }
  out.push(c('none', { deviceName: `CPU (${os.cpus()[0]?.model?.trim() ?? os.arch()}, ${os.cpus().length} threads)`, unavailable: has('libx264') ? null : 'This ffmpeg build has no libx264 encoder.' }));
  return out;
}

const PRIORITY: Record<HwAccel, number> = { nvenc: 1, qsv: 2, vaapi: 3, amf: 3, videotoolbox: 3, rkmpp: 4, v4l2m2m: 5, none: 9 };

/** Pick the method to recommend: the highest-priority one where H.264 encode works (decode working breaks ties, then speed). */
export function recommend(methods: HwMethodResult[]): HwDetectReport['recommendation'] {
  const ok = methods.filter((m) => m.works && m.hwAccel !== 'none');
  ok.sort((a, b) => PRIORITY[a.hwAccel] - PRIORITY[b.hwAccel] || Number(!!b.decode?.works) - Number(!!a.decode?.works) || (b.fps ?? 0) - (a.fps ?? 0));
  const best = ok[0];
  if (!best) {
    const sw = methods.find((m) => m.hwAccel === 'none');
    return { id: sw?.id ?? 'none', hwAccel: 'none', device: null, gpuIndex: null, reason: 'No working hardware encoder was found, so transcoding stays on the CPU.' };
  }
  const extras = [best.encode.hevc.works && 'HEVC', best.encode.av1.works && 'AV1'].filter(Boolean).join(' and ');
  const tm = best.toneMapping.path ? ` HDR tone-mapping: ${best.toneMapping.path}.` : '';
  return {
    id: best.id, hwAccel: best.hwAccel, device: best.device, gpuIndex: best.gpuIndex,
    reason: `${best.label}${best.deviceName ? ` on ${best.deviceName}` : ''} encodes H.264${extras ? ` and ${extras}` : ''}${best.fps ? ` at ${Math.round(best.fps)} fps` : ''}.${tm}`,
  };
}

/* ------------------------------- tests ------------------------------- */

const skipped = (error: string): HwTestResult => ({ works: false, error, fps: null, skipped: true });
const fromRun = (r: RunResult): HwTestResult => ({ works: r.ok, error: r.error, fps: r.fps });

/** Test clips: an 8-bit H.264 file (decode test) and an HDR10 10-bit HEVC file (10-bit and tone-mapping tests). */
async function ensureSamples(encoders: Set<string>): Promise<{ h264: string | null; hdr: string | null; notes: string[] }> {
  const dir = path.join(config.cacheDir, 'hwdetect');
  fs.mkdirSync(dir, { recursive: true });
  const notes: string[] = [];
  const h264 = path.join(dir, 'sample-h264.mp4');
  const hdr = path.join(dir, 'sample-hdr10.mp4');
  if (!fs.existsSync(h264) && encoders.has('libx264')) {
    const r = await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', h264 + '.tmp.mp4']);
    if (r.ok) fs.renameSync(h264 + '.tmp.mp4', h264);
    else notes.push(`Could not create the H.264 test clip: ${r.error}`);
  }
  if (!fs.existsSync(hdr) && encoders.has('libx265')) {
    const r = await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30', '-t', '2', '-pix_fmt', 'yuv420p10le',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400',
      '-color_primaries', 'bt2020', '-color_trc', 'smpte2084', '-colorspace', 'bt2020nc', '-tag:v', 'hvc1', hdr + '.tmp.mp4'], 60000);
    if (r.ok) fs.renameSync(hdr + '.tmp.mp4', hdr);
    else notes.push(`Could not create the HDR10 test clip: ${r.error}`);
  }
  if (!encoders.has('libx265') && !fs.existsSync(hdr)) notes.push('10-bit and tone-mapping tests need libx265 in ffmpeg to create the HDR test clip.');
  return { h264: fs.existsSync(h264) ? h264 : null, hdr: fs.existsSync(hdr) ? hdr : null, notes };
}

/** The ffmpeg command for one test, built with the playback pipeline builders. Exported for tests. */
export function testArgs(t: HwTarget, o: { codec: TranscodeVideoCodec; input: string | 'testsrc'; toneMap: ToneMapPath | null; decode: boolean }): string[] {
  const pipe = buildVideoPipeline({ target: t, codec: o.codec, height: 720, sourceHeight: 1080, toneMap: o.toneMap, decode: o.decode && o.input !== 'testsrc' });
  const input = o.input === 'testsrc' ? ['-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30'] : ['-i', o.input];
  return ['-y', ...pipe.inputArgs, ...input, '-t', '2', '-an', '-vf', pipe.filters.join(','), ...encoderArgs(pipe.encoder, { bitrate: 4000, preset: 'veryfast', threads: 0 }), ...rateArgs(4000), '-f', 'null', '-'];
}

async function testMethod(cand: Candidate, ctx: { platform: string; encoders: Set<string>; filters: Set<string>; samples: { h264: string | null; hdr: string | null } }): Promise<HwMethodResult> {
  const id = `${cand.hwAccel}:${cand.device ?? cand.gpuIndex ?? 'default'}`;
  const emptyEncode = Object.fromEntries(CODECS.map((c) => [c, { ...skipped('not tested'), encoder: encoderFor(cand.hwAccel, c) }])) as HwMethodResult['encode'];
  const base: HwMethodResult = {
    id, hwAccel: cand.hwAccel, label: cand.label, device: cand.device, gpuIndex: cand.gpuIndex, deviceName: cand.deviceName,
    available: !cand.unavailable, works: false, error: cand.unavailable, encode: emptyEncode, decode: null, tenBit: null,
    toneMapping: { path: null, tried: [] }, fps: null, recommended: false, notes: [],
  };
  if (cand.unavailable) return base;
  const target: HwTarget = { hw: cand.hwAccel, platform: ctx.platform, vaapiDevice: cand.device ?? getSettings().transcoding.vaapiDevice, gpuIndex: cand.gpuIndex ?? 0 };
  const sw = cand.hwAccel === 'none';

  // 1) Encode: testsrc2 → scale → encode, per codec. Software only tests H.264 (HEVC/AV1 are hardware-only at runtime).
  for (const codec of CODECS) {
    const enc = encoderFor(cand.hwAccel, codec);
    if (!enc) { base.encode[codec] = { ...skipped(`${cand.label} has no ${codec.toUpperCase()} encoder`), encoder: null }; continue; }
    if (sw && codec !== 'h264') { base.encode[codec] = { ...skipped('HEVC/AV1 are only encoded with hardware'), encoder: enc }; continue; }
    if (!ctx.encoders.has(enc)) { base.encode[codec] = { ...skipped(`${enc} is not in this ffmpeg build`), encoder: enc }; continue; }
    if (codec !== 'h264' && !base.encode.h264.works) { base.encode[codec] = { ...skipped('H.264 encoding failed, so this was not tried'), encoder: enc }; continue; }
    base.encode[codec] = { ...fromRun(await runFfmpeg(testArgs(target, { codec, input: 'testsrc', toneMap: null, decode: false }))), encoder: enc };
  }
  base.works = base.encode.h264.works;
  base.fps = base.encode.h264.fps;
  if (!base.works) {
    base.error = base.encode.h264.error;
    return base;
  }

  // 2) Decode → scale → encode (full GPU pipeline where the method has one).
  base.decode = ctx.samples.h264 ? fromRun(await runFfmpeg(testArgs(target, { codec: 'h264', input: ctx.samples.h264, toneMap: null, decode: true }))) : skipped('No H.264 test clip');
  // 3) 10-bit HEVC decode.
  base.tenBit = ctx.samples.hdr ? fromRun(await runFfmpeg(testArgs(target, { codec: 'h264', input: ctx.samples.hdr, toneMap: null, decode: true }))) : skipped('No 10-bit test clip (needs libx265)');
  // 4) HDR → SDR tone-mapping: first path that works.
  for (const path of toneMapCandidates(cand.hwAccel, ctx.platform)) {
    const missing = TONEMAP_FILTERS[path].filter((f) => !ctx.filters.has(f));
    if (missing.length) { base.toneMapping.tried.push({ path, ...skipped(`ffmpeg has no ${missing.join(', ')} filter`) }); continue; }
    if (!ctx.samples.hdr) { base.toneMapping.tried.push({ path, ...skipped('No HDR test clip (needs libx265)') }); continue; }
    const r = fromRun(await runFfmpeg(testArgs(target, { codec: 'h264', input: ctx.samples.hdr, toneMap: path, decode: true })));
    base.toneMapping.tried.push({ path, ...r });
    if (r.works) { base.toneMapping.path = path; break; }
  }
  if (base.decode && !base.decode.works && !base.decode.skipped) base.notes.push('Hardware decoding failed; encoding still works (frames are decoded on the CPU).');
  if (base.tenBit && !base.tenBit.works && !base.tenBit.skipped) base.notes.push('10-bit HEVC could not be decoded on this device.');
  if (cand.hwAccel === 'vaapi' && /amd|radeon|radeonsi/i.test(`${cand.deviceName}`)) base.notes.push('AMD on Linux uses VA-API through Mesa (radeonsi).');
  if (!base.toneMapping.path) base.notes.push('No HDR tone-mapping path works; HDR sources would look washed out on SDR screens.');
  return base;
}

/* ------------------------------ public ------------------------------- */

let inflight: Promise<HwDetectReport> | null = null;

export const cachedReport = () => getDetectReport();

/** Run detection (concurrent callers share one run). The result is cached until the next run. */
export function detectHardware(): Promise<HwDetectReport> {
  inflight ??= runDetection().finally(() => { inflight = null; });
  return inflight;
}

async function runDetection(): Promise<HwDetectReport> {
  const t0 = Date.now();
  const platform = process.platform;
  const versionOut = cmd(config.ffmpeg, ['-hide_banner', '-version']);
  const version = versionOut?.match(/ffmpeg version (\S+)/)?.[1] ?? null;
  const hwaccels = parseHwaccels(cmd(config.ffmpeg, ['-hide_banner', '-hwaccels']) ?? '');
  const encoders = listCaps('-encoders');
  const filters = listCaps('-filters');
  const devices = findDevices(platform);
  const candidates = planCandidates(platform, devices, encoders);
  const samples = versionOut ? await ensureSamples(encoders) : { h264: null, hdr: null, notes: ['ffmpeg was not found.'] };
  const methods: HwMethodResult[] = [];
  for (const cand of candidates) {
    if (!versionOut) cand.unavailable = `ffmpeg not found at ${config.ffmpeg}`;
    methods.push(await testMethod(cand, { platform, encoders, filters, samples }));
  }
  const recommendation = recommend(methods);
  for (const m of methods) m.recommended = m.id === recommendation.id;
  if (samples.notes.length) methods.find((m) => m.hwAccel === 'none')?.notes.push(...samples.notes);
  const report: HwDetectReport = {
    ranAt: new Date().toISOString(), durationMs: Date.now() - t0, platform, arch: process.arch,
    ffmpeg: { path: config.ffmpeg, version, hwaccels, encoders: [...encoders].filter((e) => RELEVANT_ENCODER.test(e)).sort(), filters: [...filters].filter((f) => RELEVANT_FILTER.test(f)).sort() },
    devices, methods, recommendation,
  };
  setDetectReport(report);
  log.info(`Hardware detection: ${methods.filter((m) => m.works).map((m) => m.id).join(', ') || 'nothing works'} — recommend ${recommendation.hwAccel} (${report.durationMs} ms)`);
  return report;
}
