/**
 * Environment-driven configuration.
 *
 * - HUB_HOST            listen host          (default 0.0.0.0)
 * - HUB_PORT            listen port          (default 6780)
 * - HUB_DB_PATH         JSON store path      (default ./data/hub.json)
 * - HUB_TOKEN_SECRET    HMAC key for session token hashes; when unset a
 *                       random secret is generated once and persisted next to
 *                       the store at `<HUB_DB_PATH>.secret` (mode 0600)
 * - HUB_TOKEN_TTL_DAYS  session lifetime     (default 30)
 * - HUB_ONLINE_TTL_MS   device online window (default 60000)
 * - HUB_TRUST_PROXY     trust X-Forwarded-For from one reverse-proxy layer
 *                       (default false; enable behind nginx)
 * - HUB_LOG_LEVEL       debug|info|warn|error (default info)
 */

import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface HubConfig {
  host: string;
  port: number;
  dbPath: string;
  tokenSecret: Buffer;
  tokenTtlMs: number;
  onlineTtlMs: number;
  trustProxy: boolean;
}

function intEnv(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`${key} must be an integer >= ${min}, got: ${raw}`);
  }
  return value;
}

function boolEnv(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

/** Load the HMAC secret from env, or load/create the 0600 sidecar file. */
function loadTokenSecret(env: NodeJS.ProcessEnv, dbPath: string): Buffer {
  const fromEnv = env.HUB_TOKEN_SECRET;
  if (fromEnv !== undefined && fromEnv !== "") {
    return Buffer.from(fromEnv, "utf8");
  }
  const secretPath = `${dbPath}.secret`;
  try {
    const existing = fs.readFileSync(secretPath, "utf8").trim();
    if (existing.length >= 32) return Buffer.from(existing, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const generated = randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(secretPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(secretPath, generated, { encoding: "utf8", mode: 0o600 });
  return Buffer.from(generated, "utf8");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const dbPath = path.resolve(
    env.HUB_DB_PATH && env.HUB_DB_PATH !== "" ? env.HUB_DB_PATH : "./data/hub.json",
  );
  return {
    host: env.HUB_HOST && env.HUB_HOST !== "" ? env.HUB_HOST : "0.0.0.0",
    port: intEnv(env, "HUB_PORT", 6780, 1),
    dbPath,
    tokenSecret: loadTokenSecret(env, dbPath),
    tokenTtlMs: intEnv(env, "HUB_TOKEN_TTL_DAYS", 30, 1) * 24 * 60 * 60 * 1000,
    onlineTtlMs: intEnv(env, "HUB_ONLINE_TTL_MS", 60_000, 1000),
    trustProxy: boolEnv(env, "HUB_TRUST_PROXY", false),
  };
}
