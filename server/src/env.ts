/**
 * Environment variable names. The product was renamed MediaMax -> Kinora -> Vibe; the variable names did not change
 * with the move to Vibe (compatibility). Every setting can be given as `KINORA_<NAME>` or as its original
 * `MEDIAMAX_<NAME>` (docs list the KINORA_ names). When both are set the
 * new name wins. The rest of the server reads the MEDIAMAX_ names, so this module copies each KINORA_ variable over
 * its MEDIAMAX_ twin before anything else looks at the environment (config.ts imports it first).
 */
export const ENV_PREFIX = 'KINORA_';
export const LEGACY_ENV_PREFIX = 'MEDIAMAX_';

export function applyEnvAliases(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const [k, v] of Object.entries(env)) {
    if (k.startsWith(ENV_PREFIX) && k.length > ENV_PREFIX.length && v !== undefined) env[LEGACY_ENV_PREFIX + k.slice(ENV_PREFIX.length)] = v;
  }
  return env;
}

/** Read setting `name` (without prefix): KINORA_<name>, else MEDIAMAX_<name>. */
export function envVar(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[ENV_PREFIX + name] ?? env[LEGACY_ENV_PREFIX + name];
}

applyEnvAliases();
