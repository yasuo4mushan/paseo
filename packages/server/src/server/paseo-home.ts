import { cpSync, existsSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { readEnvSetting } from "./env-compat.js";

export const PASEO_HOME_ENV_KEY = "AASWITCH_HOME";
// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
export const LEGACY_PASEO_HOME_ENV_KEY = "PASEO_HOME";

function expandHomeDir(input: string): string {
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  if (input === "~") {
    return os.homedir();
  }
  return input;
}

export function resolvePaseoHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = readEnvSetting(env, PASEO_HOME_ENV_KEY) ?? "~/.aaswitch";
  const resolved = path.resolve(expandHomeDir(raw));
  return resolved;
}

/**
 * The pre-rebrand home directory a freshly resolved home should be migrated
 * from, or null when the path has no known predecessor. Only the two shipped
 * home paths qualify: the user default (`~/.paseo`) and the dev checkout home
 * (`<root>/.dev/paseo-home`). Arbitrary custom homes are never migrated.
 */
// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
export function legacyPaseoHomeCandidate(home: string): string | null {
  const parent = path.dirname(home);
  const basename = path.basename(home);
  if (parent === os.homedir() && basename === ".aaswitch") {
    return path.join(parent, ".paseo");
  }
  if (basename === "aaswitch-home") {
    return path.join(parent, "paseo-home");
  }
  return null;
}

export type PaseoHomeMigrationResult =
  | { action: "none" }
  | { action: "migrated"; from: string; to: string; copied: boolean }
  | { action: "skipped"; from: string; to: string; reason: "legacy_in_use" };

export interface MigrateLegacyPaseoHomeOptions {
  isLegacyHomeInUse?: (legacyHome: string) => boolean;
  /** Test seam: defaults to fs.renameSync. */
  renameImpl?: (from: string, to: string) => void;
  /** Test seam: defaults to a recursive fs.cpSync. */
  copyImpl?: (from: string, to: string) => void;
}

/**
 * Move a pre-rebrand home directory onto its aaswitch successor. Only runs
 * when the new home does not exist yet (never overwrites) and the legacy home
 * holds no live daemon lock. Prefers an atomic rename; falls back to a
 * recursive copy when the two paths sit on different filesystems, in which
 * case the legacy directory is retained as a backup.
 */
// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
export function migrateLegacyPaseoHome(
  home: string,
  options: MigrateLegacyPaseoHomeOptions = {},
): PaseoHomeMigrationResult {
  const legacyHome = legacyPaseoHomeCandidate(home);
  if (!legacyHome || existsSync(home) || !existsSync(legacyHome)) {
    return { action: "none" };
  }
  if (options.isLegacyHomeInUse?.(legacyHome)) {
    return { action: "skipped", from: legacyHome, to: home, reason: "legacy_in_use" };
  }
  const rename = options.renameImpl ?? ((from: string, to: string) => renameSync(from, to));
  const copy =
    options.copyImpl ??
    ((from: string, to: string) =>
      cpSync(from, to, { recursive: true, errorOnExist: true, force: false }));
  try {
    rename(legacyHome, home);
    return { action: "migrated", from: legacyHome, to: home, copied: false };
  } catch (renameError) {
    if (existsSync(home)) {
      // Lost a race with another process performing the same migration.
      return { action: "migrated", from: legacyHome, to: home, copied: false };
    }
    try {
      copy(legacyHome, home);
    } catch (copyError) {
      if (existsSync(home)) {
        return { action: "migrated", from: legacyHome, to: home, copied: false };
      }
      throw copyError;
    }
    void renameError;
    return { action: "migrated", from: legacyHome, to: home, copied: true };
  }
}
