/**
 * Linux block-device awareness for library paths: which mount (and which physical disks) a path lives on, and
 * whether those disks are spun down. Everything here reads /proc and /sys only (never the media disks themselves);
 * power state comes from `hdparm -C` / `smartctl -n standby`, both of which answer without waking a sleeping disk.
 * On other systems, or without permission, everything degrades to "unknown".
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import type { DiskPowerState } from '@mediamax/shared';

export interface MountEntry {
  id: number;
  parent: number;
  /** "major:minor" as reported by the kernel. */
  dev: string;
  root: string;
  mountPoint: string;
  fsType: string;
  source: string;
}

const unescapeMount = (s: string) => s.replace(/\\(\d{3})/g, (_m, o) => String.fromCharCode(parseInt(o, 8)));

/** Parse /proc/self/mountinfo. */
export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split(' ');
    const sep = parts.indexOf('-', 6);
    if (parts.length < 10 || sep < 0) continue;
    out.push({
      id: Number(parts[0]), parent: Number(parts[1]), dev: parts[2], root: unescapeMount(parts[3]), mountPoint: unescapeMount(parts[4]),
      fsType: parts[sep + 1] ?? '', source: unescapeMount(parts[sep + 2] ?? ''),
    });
  }
  return out;
}

/** The mount a path lives on: the longest matching mount point (later mounts shadow earlier ones). No I/O. */
export function findMount(p: string, mounts: MountEntry[]): MountEntry | null {
  const target = path.posix.normalize(p.replace(/\\/g, '/'));
  let best: MountEntry | null = null;
  for (const m of mounts) {
    const mp = m.mountPoint;
    const match = mp === '/' || target === mp || target.startsWith(mp.endsWith('/') ? mp : mp + '/');
    if (match && (!best || mp.length >= best.mountPoint.length)) best = m;
  }
  return best;
}

const NETWORK_FS = /^(nfs|nfs4|cifs|smb3?|smbfs|afpfs|fuse\.sshfs|fuse\.rclone|9p|ceph|glusterfs|fuse\.glusterfs|davfs|fuse\.s3fs)$/;
export const isNetworkFs = (fsType: string) => NETWORK_FS.test(fsType);

/** Stable key used to group work per disk: the mount's device id (or the pool / source device for anonymous devices). */
export function diskKeyFor(m: MountEntry | null, p: string): string {
  if (!m) return `path:${p}`;
  // ZFS: all datasets of a pool share the pool's disks.
  if (m.fsType === 'zfs' && m.source) return `zfs:${m.source.split('/')[0]}`;
  // Anonymous devices (btrfs) are keyed by their /dev source so subvolumes group together.
  if (m.dev.startsWith('0:') && m.source.startsWith('/dev/')) return `src:${m.source}`;
  return `dev:${m.dev}`;
}

/**
 * Physical disks behind a mount, from sysfs: partitions resolve to their disk, md/dm (RAID, LVM, LUKS, Unraid's
 * md devices) to their member disks. Anonymous devices (btrfs, overlay) fall back to the mount source if it is a
 * /dev node. ZFS, FUSE (mergerfs, Unraid user shares) and network shares return [] (unknown).
 */
export function resolveDisks(m: MountEntry, sysRoot = '/sys'): string[] {
  let name: string | null = null;
  if (!m.dev.startsWith('0:')) {
    try {
      name = path.basename(fs.readlinkSync(path.join(sysRoot, 'dev/block', m.dev)));
    } catch {
      name = null;
    }
  }
  if (!name && m.source.startsWith('/dev/')) {
    let src = m.source;
    try {
      // /dev/mapper/x and /dev/disk/by-* are symlinks to /dev/dm-N, /dev/sdX…
      if (sysRoot === '/sys') src = fs.realpathSync(src);
    } catch {
      /* keep */
    }
    name = path.basename(src);
  }
  if (!name) return [];
  const seen = new Set<string>();
  const walk = (n: string, depth: number): string[] => {
    if (depth > 6 || seen.has(n)) return [];
    seen.add(n);
    const cls = path.join(sysRoot, 'class/block', n);
    // A partition: its parent directory in /sys/block/<disk>/<part> is the disk.
    if (fs.existsSync(path.join(cls, 'partition'))) {
      try {
        const parent = path.basename(path.dirname(fs.realpathSync(cls)));
        return walk(parent, depth + 1);
      } catch {
        return [n];
      }
    }
    let slaves: string[] = [];
    try {
      slaves = fs.readdirSync(path.join(cls, 'slaves'));
    } catch {
      /* none */
    }
    if (slaves.length) return slaves.flatMap((s) => walk(s, depth + 1));
    return fs.existsSync(cls) || fs.existsSync(path.join(sysRoot, 'block', n)) ? [n] : [];
  };
  return [...new Set(walk(name, 0))];
}

export function isRotational(disk: string, sysRoot = '/sys'): boolean | null {
  try {
    return fs.readFileSync(path.join(sysRoot, 'block', disk, 'queue/rotational'), 'utf8').trim() === '1';
  } catch {
    return null;
  }
}

/** Completed read + write requests for a disk (sysfs; reading it never touches the disk). */
export function ioCount(disk: string, sysRoot = '/sys'): number | null {
  try {
    const f = fs.readFileSync(path.join(sysRoot, 'block', disk, 'stat'), 'utf8').trim().split(/\s+/).map(Number);
    return (f[0] ?? 0) + (f[4] ?? 0);
  } catch {
    return null;
  }
}

/** `hdparm -C` output → state. */
export function parseHdparm(out: string): DiskPowerState | null {
  const m = /drive state is:\s*(.+)/i.exec(out);
  if (!m) return null;
  const s = m[1].trim().toLowerCase();
  if (/standby|sleeping/.test(s)) return 'standby';
  if (/active|idle/.test(s)) return 'active';
  return 'unknown';
}

/** `smartctl -n standby -i` output and exit code → state. */
export function parseSmartctl(out: string, code: number | null): DiskPowerState | null {
  if (/in (STANDBY|SLEEP) mode/i.test(out) || code === 2 && /STANDBY|SLEEP/i.test(out)) return 'standby';
  if (/Power mode (was|is):\s*(ACTIVE|IDLE)/i.test(out)) return 'active';
  if (code === 0 && /Device Model|Model Number|Model Family|Product:/i.test(out)) return 'active';
  return null;
}

function run(cmd: string, args: string[]): Promise<{ out: string; code: number | null; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: string | number }) | null;
      resolve({ out: `${stdout ?? ''}${stderr ?? ''}`, code: e ? (typeof e.code === 'number' ? e.code : null) : 0, missing: e?.code === 'ENOENT' });
    });
  });
}

const tools = { hdparm: null as boolean | null, smartctl: null as boolean | null };

export async function detectTools(): Promise<{ hdparm: boolean; smartctl: boolean }> {
  if (process.platform !== 'linux') return { hdparm: false, smartctl: false };
  if (tools.hdparm == null) tools.hdparm = !(await run('hdparm', ['-V'])).missing;
  if (tools.smartctl == null) tools.smartctl = !(await run('smartctl', ['--version'])).missing;
  return { hdparm: tools.hdparm, smartctl: tools.smartctl };
}

export interface DiskStateResult { state: DiskPowerState; method: string | null; checkedAt: number }

const cache = new Map<string, DiskStateResult>();
const ioSamples = new Map<string, { count: number; at: number; changedAt: number }>();
/** Tools that failed for a disk (no permission, unsupported bridge): don't retry them every time. */
const toolFailed = new Map<string, number>();

/** Sample sysfs I/O counters: "active" if requests completed since the last sample, "idle" after 10 quiet minutes. */
export function sampleIo(disk: string, now = Date.now(), sysRoot = '/sys'): DiskPowerState {
  const c = ioCount(disk, sysRoot);
  if (c == null) return 'unknown';
  const prev = ioSamples.get(disk);
  if (!prev) {
    ioSamples.set(disk, { count: c, at: now, changedAt: now });
    return 'unknown';
  }
  if (c !== prev.count) {
    ioSamples.set(disk, { count: c, at: now, changedAt: now });
    return 'active';
  }
  prev.at = now;
  return now - prev.changedAt > 10 * 60000 ? 'idle' : 'unknown';
}

/**
 * Power state of one disk. Never wakes it: hdparm -C / smartctl -n standby issue CHECK POWER MODE, sysfs is memory.
 * Results are cached for `maxAgeMs`.
 */
export async function diskState(disk: string, opts: { maxAgeMs?: number; useTools?: boolean } = {}): Promise<DiskStateResult> {
  const hit = cache.get(disk);
  if (hit && Date.now() - hit.checkedAt < (opts.maxAgeMs ?? 60000)) return hit;
  const now = Date.now();
  let res: DiskStateResult | null = null;
  if (isRotational(disk) === false) res = { state: 'active', method: 'ssd', checkedAt: now };
  if (!res && opts.useTools !== false && /^[a-zA-Z0-9_-]+$/.test(disk)) {
    const t = await detectTools();
    const failedAt = toolFailed.get(disk) ?? 0;
    if (now - failedAt > 30 * 60000) {
      if (t.hdparm) {
        const r = await run('hdparm', ['-C', `/dev/${disk}`]);
        const st = parseHdparm(r.out);
        if (st && st !== 'unknown') res = { state: st, method: 'hdparm', checkedAt: now };
      }
      if (!res && t.smartctl) {
        const r = await run('smartctl', ['-n', 'standby', '-i', `/dev/${disk}`]);
        const st = parseSmartctl(r.out, r.code);
        if (st) res = { state: st, method: 'smartctl', checkedAt: now };
      }
      if (!res && (t.hdparm || t.smartctl)) toolFailed.set(disk, now);
    }
  }
  if (!res) {
    const st = sampleIo(disk, now);
    res = { state: st, method: st === 'unknown' ? null : 'sysfs', checkedAt: now };
  }
  cache.set(disk, res);
  return res;
}

/** Combine several disks (RAID members…) into one state for a path. */
export function combineStates(states: DiskPowerState[]): DiskPowerState {
  if (!states.length) return 'unknown';
  if (states.some((s) => s === 'active')) return 'active';
  if (states.every((s) => s === 'standby')) return 'standby';
  if (states.every((s) => s === 'standby' || s === 'idle')) return 'idle';
  return 'unknown';
}

let mountCache: { at: number; mounts: MountEntry[] } | null = null;

/** Current mount table (cached 5 min). Empty off Linux. */
export function mounts(): MountEntry[] {
  if (process.platform !== 'linux') return [];
  if (mountCache && Date.now() - mountCache.at < 5 * 60000) return mountCache.mounts;
  let list: MountEntry[] = [];
  try {
    list = parseMountInfo(fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  } catch {
    list = [];
  }
  mountCache = { at: Date.now(), mounts: list };
  return list;
}

export const resetMountCache = () => {
  mountCache = null;
};
