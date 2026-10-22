/**
 * Test harness: builds a real hub server on an ephemeral port with a temp
 * store directory. Tests hit it over real HTTP (fetch), no mocks.
 */

import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { HubConfig } from "../../src/config.js";
import { setLogLevel } from "../../src/log.js";
import { RateLimiter } from "../../src/rate-limit.js";
import { createHubServer } from "../../src/server.js";
import { HubStore } from "../../src/store.js";

setLogLevel("error"); // keep test output clean

export interface Envelope<T = unknown> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

export interface TestHub {
  url: string;
  store: HubStore;
  dbPath: string;
  close(): Promise<void>;
}

export interface HubOptions extends Partial<HubConfig> {
  /** Credentialed-endpoint rate limit max (default: effectively unlimited). */
  limitMax?: number;
  limitWindowMs?: number;
}

export async function startHub(options: HubOptions = {}): Promise<TestHub> {
  const { limitMax = 100_000, limitWindowMs = 60_000, ...configOverrides } = options;
  const dir = mkdtempSync(path.join(tmpdir(), "aaswitch-hub-test-"));
  const config: HubConfig = {
    host: "127.0.0.1",
    port: 0,
    dbPath: path.join(dir, "hub.json"),
    tokenSecret: randomBytes(32),
    tokenTtlMs: 30 * 24 * 60 * 60 * 1000,
    onlineTtlMs: 60_000,
    trustProxy: false,
    ...configOverrides,
  };
  const store = new HubStore(config.dbPath);
  const server = createHubServer({
    store,
    config,
    limiter: new RateLimiter(limitMax, limitWindowMs),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("server has no address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    store,
    dbPath: config.dbPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

export async function call(
  url: string,
  method: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; headers: Headers; json: Envelope }> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${url}/api/${method}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body ?? {}),
  });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Envelope };
}

/** A structurally valid offer; override fields to build invalid variants. */
export function validOffer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    serverId: "srv_test123",
    daemonPublicKeyB64: randomBytes(32).toString("base64"),
    endpoint: "relay.example.com:443",
    useTls: true,
    ...overrides,
  };
}

export async function registerAndLogin(url: string, username = "alice"): Promise<string> {
  await call(url, "auth.register", { username, password: "password123" });
  const res = await call(url, "auth.login", { username, password: "password123" });
  if (!res.json.data || typeof res.json.data !== "object" || !("token" in res.json.data)) {
    throw new Error(`registerAndLogin failed: ${JSON.stringify(res.json)}`);
  }
  return (res.json.data as { token: string }).token;
}
