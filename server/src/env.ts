/**
 * Environment variable names. The product was renamed MediaMax -> Kinora -> Vibe. Every setting can be given as
 * `VIBE_<NAME>` (the documented name), as `KINORA_<NAME>` or as the original `MEDIAMAX_<NAME>`. When more than one is
 * set the newest name wins (VIBE_ over KINORA_ over MEDIAMAX_). The rest of the server reads the MEDIAMAX_ names, so
 * this module copies each newer variable over its MEDIAMAX_ twin before anything else looks at the environment
 * (config.ts imports it first).
 */
export const ENV_PREFIX = 'VIBE_';
/** The original prefix: the name the rest of the server code reads. */
export const LEGACY_ENV_PREFIX = 'MEDIAMAX_';

export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  // Oldest alias first, so the newest name is the one left in MEDIAMAX_<NAME>.
  for (const prefix of ['KINORA_', ENV_PREFIX]) {
    for (const [k, v] of Object.entries(env)) {
      if (k.startsWith(prefix) && k.length > prefix.length && v !== undefined) env[LEGACY_ENV_PREFIX + k.slice(prefix.length)] = v;
    }
  }
  return env;
}

/** Read setting `name` (without prefix): VIBE_<name>, else KINORA_<name>, else MEDIAMAX_<name>. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENV_PREFIX + name] ?? env['KINORA_' + name] ?? env[LEGACY_ENV_PREFIX + name];
}

applyEnvAliases();
