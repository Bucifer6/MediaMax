import { logger } from './log.js';

const log = logger('config');
const warned = new Set<string>();

/**
 * Program paths (Piper, whisper.cpp, comskip) used to be editable in the web settings. They now come only from the
 * environment, so a saved value is ignored. Say so once per setting, with the variable to use instead.
 */
export function warnIgnoredProgramSetting(setting: string, saved: string | null | undefined, envName: string, defaultName: string) {
  const v = (saved ?? '').trim();
  if (!v || v === defaultName || warned.has(setting)) return;
  warned.add(setting);
  log.warn(`The saved ${setting} "${v}" is no longer used: helper programs are set with the ${envName} environment variable ` +
    `(default: ${defaultName} on the PATH). Set ${envName}=${v} and restart Vibe to keep using it.`);
}

/** Tests only. */
export const _resetProgramSettingWarnings = () => warned.clear();
