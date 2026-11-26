/**
 * Windows network paths for the library folder picker and library checks.
 *
 * Mapped drive letters (Z: → \\nas\media) belong to one Windows sign-in, so a server running as the background
 * service (SYSTEM, or another account) can't use the letters a user mapped in Explorer. Each user's mappings are
 * kept in the registry (HKEY_USERS\<sid>\Network\<letter>\RemotePath) while they are signed in, so the picker
 * reads them there and offers the \\server\share path behind each letter, which works for any account that may
 * open the share.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

export interface MappedDrive {
  letter: string;
  remotePath: string;
}

/** \\server\share or \\server\share\folder (also //server/share). */
export const isUncPath = (p: string) => /^(\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(p.trim());

/** The share root of a UNC path (\\server\share), or null. */
export function uncShareRoot(p: string): string | null {
  const m = /^(?:\\\\|\/\/)([^\\/]+)[\\/]([^\\/]+)/.exec(p.trim());
  return m ? `\\\\${m[1]}\\${m[2]}` : null;
}

/** Parse `reg query <hive>\Network /s` output into drive letter → remote path. */
export function parseRegNetwork(out: string): MappedDrive[] {
  const drives: MappedDrive[] = [];
  let letter: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const key = /\\Network\\([A-Za-z])\s*$/.exec(line);
    if (key) {
      letter = key[1].toUpperCase();
      continue;
    }
    const val = /^\s+RemotePath\s+REG_(?:EXPAND_)?SZ\s+(.+?)\s*$/i.exec(line);
    if (val && letter) {
      drives.push({ letter, remotePath: val[1] });
      letter = null;
    }
  }
  return drives;
}

function reg(args: string[]): Promise<string> {
  const exe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'reg.exe');
  return new Promise((resolve) => {
    execFile(exe, args, { windowsHide: true, timeout: 10000 }, (_e, stdout) => resolve(String(stdout ?? '')));
  });
}

/** Drive letters mapped by this account and by every signed-in user, with the share behind each. */
export async function mappedDrives(): Promise<MappedDrive[]> {
  if (process.platform !== 'win32') return [];
  const hives = ['HKCU'];
  for (const line of (await reg(['query', 'HKU'])).split(/\r?\n/)) {
    const m = /^HKEY_USERS\\(S-1-5-21-[\d-]+)\s*$/.exec(line.trim()); // real user accounts, not *_Classes
    if (m) hives.push(`HKU\\${m[1]}`);
  }
  const all = (await Promise.all(hives.map((h) => reg(['query', `${h}\\Network`, '/s']).then(parseRegNetwork)))).flat();
  const seen = new Set<string>();
  return all.filter((d) => {
    const k = `${d.letter}|${d.remotePath.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).sort((a, b) => a.letter.localeCompare(b.letter));
}

/** SYSTEM runs with the systemprofile home and a "COMPUTER$" user name. */
export const runningAsSystem = () =>
  process.platform === 'win32' && (/\\systemprofile\\?$/i.test(process.env.USERPROFILE ?? '') || /\$$/.test(process.env.USERNAME ?? ''));

/** The account this server runs as, for messages ("SYSTEM", "PC\nasuser"). */
export function serverAccount(): string {
  if (runningAsSystem()) return 'SYSTEM';
  try {
    const u = os.userInfo().username;
    return process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${u}` : u;
  } catch {
    return process.env.USERNAME ?? 'this account';
  }
}

/** Stat with a time limit: an unreachable server can make a network path hang for a long time. */
export function statWithin(p: string, ms = 4000): Promise<fs.Stats | null> {
  return Promise.race([
    fs.promises.stat(p).catch(() => null),
    new Promise<null>((r) => setTimeout(() => r(null), ms).unref()),
  ]);
}

/**
 * Why a folder can't be used, for "Folder not found" errors: Windows network paths and drive letters depend on the
 * account Vibe runs as. Empty for other paths and platforms.
 */
export function networkPathHint(p: string, platform: NodeJS.Platform = process.platform, account = serverAccount()): string {
  if (platform !== 'win32') return '';
  const trimmed = p.trim();
  if (isUncPath(trimmed)) {
    return ` Vibe opens network shares as the Windows account it runs as (${account}). ` +
      (account === 'SYSTEM'
        ? 'SYSTEM connects as this computer, which most NAS shares refuse. Run setup again and choose a Windows account ' +
          'for the background service (one that can open this share in File Explorer), or use the tray app.'
        : `Check that ${account} can open ${uncShareRoot(trimmed) ?? trimmed} in File Explorer (its saved password is used).`);
  }
  const letter = /^([A-Za-z]):/.exec(trimmed)?.[1];
  if (letter && !/^[cC]$/.test(letter)) {
    return ` If ${letter.toUpperCase()}: is a mapped network drive, use its network path instead (for example \\\\nas\\media): ` +
      `drive letters belong to one Windows sign-in, and Vibe runs as ${account}. The folder picker lists mapped drives ` +
      'with their network paths.';
  }
  return '';
}
