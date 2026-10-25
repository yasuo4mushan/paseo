// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
// AASWITCH_* environment variables replaced the PASEO_* names during the
// aaswitch rebrand. The legacy names stay readable (and, for variables the
// daemon hands to child processes, keep being written) for one protocol
// compatibility window so existing user shells, service scripts, and hooks
// keep working across an upgrade.

export const AASWITCH_ENV_PREFIX = "AASWITCH_";
export const LEGACY_PASEO_ENV_PREFIX = "PASEO_";

const warnedLegacyKeys = new Set<string>();

function warnLegacyKeyOnce(legacyKey: string, modernKey: string): void {
  if (warnedLegacyKeys.has(legacyKey)) return;
  warnedLegacyKeys.add(legacyKey);
  process.stderr.write(
    `aaswitch: environment variable ${legacyKey} is deprecated; use ${modernKey} instead.\n`,
  );
}

export function legacyPaseoEnvName(modernKey: string): string {
  return modernKey.startsWith(AASWITCH_ENV_PREFIX)
    ? `${LEGACY_PASEO_ENV_PREFIX}${modernKey.slice(AASWITCH_ENV_PREFIX.length)}`
    : modernKey;
}

/**
 * Read one AASWITCH_* setting, falling back to its PASEO_* predecessor when
 * only the legacy name is set. The new name wins when both are present.
 */
export function readEnvSetting(
  env: Readonly<Record<string, string | undefined>>,
  modernKey: string,
): string | undefined {
  const modernValue = env[modernKey];
  if (modernValue !== undefined) return modernValue;
  const legacyKey = legacyPaseoEnvName(modernKey);
  const legacyValue = env[legacyKey];
  if (legacyValue === undefined) return undefined;
  warnLegacyKeyOnce(legacyKey, modernKey);
  return legacyValue;
}

/**
 * In-place variant for process entry points (daemon supervisor, daemon worker,
 * CLI, desktop main): copies every set PASEO_* variable onto its unset
 * AASWITCH_* counterpart so interior code can read only the AASWITCH_* names.
 */
export function applyLegacyPaseoEnvAliases(env: NodeJS.ProcessEnv): void {
  for (const [key, value] of Object.entries(withLegacyPaseoEnvAliases(env))) {
    if (value !== undefined) env[key] = value;
  }
}

/**
 * Copy every set PASEO_* variable onto its unset AASWITCH_* counterpart and
 * return the merged record, leaving the input untouched.
 */
export function withLegacyPaseoEnvAliases<T extends Record<string, string | undefined>>(env: T): T {
  const merged: Record<string, string | undefined> = { ...env };
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_PASEO_ENV_PREFIX) || value === undefined) continue;
    const modernKey = `${AASWITCH_ENV_PREFIX}${key.slice(LEGACY_PASEO_ENV_PREFIX.length)}`;
    if (merged[modernKey] === undefined) {
      merged[modernKey] = value;
      warnLegacyKeyOnce(key, modernKey);
    }
  }
  return merged as T;
}

/**
 * Mirror every AASWITCH_* key of an overlay onto its PASEO_* counterpart.
 * Used where the daemon builds the environment for child processes (agents,
 * hooks, service scripts): the children opt in to the new names while
 * scripts written against the old names keep seeing them.
 */
export function legacyPaseoEnvMirror(
  overlay: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const mirrored: Record<string, string> = {};
  for (const [key, value] of Object.entries(overlay)) {
    if (!key.startsWith(AASWITCH_ENV_PREFIX) || value === undefined) continue;
    mirrored[legacyPaseoEnvName(key)] = value;
  }
  return mirrored;
}
