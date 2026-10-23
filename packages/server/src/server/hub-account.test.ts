import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createHubAccountManager, type HubAccountManager } from "./hub-account.js";

/**
 * In-memory hub implementing the t12 contract over real HTTP: POST
 * <base>/api/<method>, `{ok:true,data}` / `{ok:false,error:{code,message}}`,
 * bearer auth, idempotent devices.register keyed by account+device name,
 * `devices.heartbeat {deviceId, offer}`.
 */
interface MockHubDevice {
  deviceId: string;
  name: string;
  offer: Record<string, unknown>;
}

interface MockHubState {
  baseUrl: string;
  token: string;
  registerCalls: Array<Record<string, unknown>>;
  heartbeatCalls: Array<Record<string, unknown>>;
  unregisterCalls: Array<Record<string, unknown>>;
  loginCalls: Array<Record<string, unknown>>;
  accountRegisters: number;
  logouts: number;
  devices: Map<string, MockHubDevice>;
  failFirstRegisterOnce: boolean;
  rejectTokens: boolean;
}

type MockHubRouteResult =
  | { data: unknown }
  | { error: { code: string; message: string; status: number } };

/**
 * Pure routing for the mock hub: one branch per `api/<method>` from the t12
 * contract, kept out of the HTTP server callback so each piece stays simple.
 */
/** auth.* routing, split out of routeMockHubRequest to keep complexity low. */
function routeMockHubAuth(
  state: MockHubState,
  method: string,
  payload: Record<string, unknown>,
  isAuthorized: boolean,
): MockHubRouteResult | null {
  if (method === "auth.login") {
    state.loginCalls.push(payload);
    if (payload.phone !== "13800138000" || payload.password !== "secret") {
      return {
        error: { code: "auth.invalid_credentials", message: "bad credentials", status: 400 },
      };
    }
    return {
      data: { token: state.token, account: { id: "acc-1", phone: payload.phone } },
    };
  }
  if (method === "auth.register") {
    state.accountRegisters += 1;
    return { data: { account: { id: "acc-1", phone: payload.phone } } };
  }
  if (method === "auth.password.change") {
    if (state.rejectTokens || !isAuthorized) {
      return { error: { code: "auth.token_invalid", message: "token invalid", status: 401 } };
    }
    if (payload.oldPassword !== undefined && payload.oldPassword !== "secret") {
      return {
        error: { code: "auth.invalid_credentials", message: "old password incorrect", status: 401 },
      };
    }
    return { data: { ok: true } };
  }
  return null;
}

function routeMockHubRequest(
  state: MockHubState,
  method: string,
  payload: Record<string, unknown>,
  isAuthorized: boolean,
): MockHubRouteResult {
  if (["devices.register", "devices.heartbeat", "devices.unregister"].includes(method)) {
    if (state.rejectTokens || !isAuthorized) {
      return { error: { code: "auth.token_invalid", message: "token invalid", status: 401 } };
    }
  }

  const auth = routeMockHubAuth(state, method, payload, isAuthorized);
  if (auth) return auth;

  if (method === "auth.logout") {
    state.logouts += 1;
    return { data: { ok: true } };
  }
  if (method === "devices.register") {
    if (state.failFirstRegisterOnce) {
      state.failFirstRegisterOnce = false;
      return { error: { code: "internal_error", message: "transient failure", status: 500 } };
    }
    state.registerCalls.push(payload);
    const key = `acc-1:${payload.name}`;
    const existing = state.devices.get(key);
    const deviceId = existing?.deviceId ?? `dev-${state.devices.size + 1}`;
    state.devices.set(key, {
      deviceId,
      name: payload.name as string,
      offer: payload.offer as Record<string, unknown>,
    });
    return { data: { deviceId } };
  }
  if (method === "devices.heartbeat") {
    state.heartbeatCalls.push(payload);
    const device = [...state.devices.values()].find((d) => d.deviceId === payload.deviceId);
    if (!device) {
      return { error: { code: "devices.offer_invalid", message: "unknown device", status: 400 } };
    }
    if (payload.offer) {
      device.offer = payload.offer as Record<string, unknown>;
    }
    return { data: { ok: true } };
  }
  if (method === "devices.unregister") {
    state.unregisterCalls.push(payload);
    for (const [key, device] of state.devices) {
      if (device.deviceId === payload.deviceId) state.devices.delete(key);
    }
    return { data: { ok: true } };
  }
  return { error: { code: "not_found", message: method, status: 404 } };
}

async function startMockHub(): Promise<{ state: MockHubState; close: () => Promise<void> }> {
  const state: MockHubState = {
    baseUrl: "",
    token: "tok-1",
    registerCalls: [],
    heartbeatCalls: [],
    unregisterCalls: [],
    loginCalls: [],
    accountRegisters: 0,
    logouts: 0,
    devices: new Map(),
    failFirstRegisterOnce: false,
    rejectTokens: false,
  };

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, "");
      const payload = body ? (JSON.parse(body) as Record<string, unknown>) : {};
      const isAuthorized = req.headers.authorization === `Bearer ${state.token}`;
      const result = routeMockHubRequest(state, method, payload, isAuthorized);
      res.setHeader("Content-Type", "application/json");
      if ("error" in result) {
        res.statusCode = result.error.status;
        res.end(JSON.stringify({ ok: false, error: result.error }));
        return;
      }
      res.end(JSON.stringify({ ok: true, data: result.data }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.baseUrl = `http://127.0.0.1:${port}`;
  return {
    state,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      }),
  };
}

const DAEMON_PUBLIC_KEY_B64 = "6Gj1cQ0T3Fv7YhN2mK8pR5wXeZbAqL4sD9uH7oP6jEw=";

interface ManagerHarness {
  manager: HubAccountManager;
  paseoHome: string;
  relayConfig: {
    enabled: boolean;
    publicEndpoint: string;
    publicUseTls: boolean;
  };
  cleanup: () => Promise<void>;
}

const harnesses: ManagerHarness[] = [];

async function createHarness(
  baseUrl: string,
  options?: { token?: string | null; heartbeatIntervalMs?: number },
): Promise<ManagerHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-hub-account-"));
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const relayConfig = {
    enabled: true,
    publicEndpoint: "relay.example.cn:443",
    publicUseTls: true,
  };
  const manager = createHubAccountManager({
    paseoHome,
    serverId: "srv-1",
    daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
    getRelayConfig: () => relayConfig,
    initial: {
      baseUrl,
      token: options?.token === undefined ? "tok-1" : options.token,
      phone: "13800138000",
      deviceName: "mac-studio",
    },
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 40,
    backoffBaseMs: 10,
  });
  const harness: ManagerHarness = {
    manager,
    paseoHome,
    relayConfig,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
  harnesses.push(harness);
  return harness;
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

function hasOfferEndpoint(endpoint: string): (call: Record<string, unknown>) => boolean {
  return (call) => (call.offer as { endpoint?: string } | undefined)?.endpoint === endpoint;
}

describe("hub account manager", () => {
  afterEach(async () => {
    await Promise.all(
      harnesses.splice(0).map(async (harness) => {
        try {
          await harness.manager.stop();
        } catch {
          // Manager may already be stopped.
        }
        await harness.cleanup();
      }),
    );
  });

  test("registers the device, then heartbeats with the assigned deviceId", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();

      await waitFor("first register", () => hub.state.registerCalls.length >= 1);
      const register = hub.state.registerCalls[0];
      expect(register.name).toBe("mac-studio");
      expect(register.os).toBe(process.platform);
      expect(register.offer).toEqual({
        serverId: "srv-1",
        daemonPublicKeyB64: DAEMON_PUBLIC_KEY_B64,
        endpoint: "relay.example.cn:443",
        useTls: true,
      });

      await waitFor("heartbeats", () => hub.state.heartbeatCalls.length >= 2);
      expect(hub.state.heartbeatCalls[0].deviceId).toBe("dev-1");
      expect(hub.state.heartbeatCalls[0].offer).toEqual(register.offer);

      const status = harness.manager.status();
      expect(status).toMatchObject({
        configured: true,
        loggedIn: true,
        phone: "13800138000",
        deviceName: "mac-studio",
        deviceId: "dev-1",
        registered: true,
        relayEnabled: true,
        lastError: null,
      });

      // The deviceId is persisted for the next daemon start.
      const persisted = JSON.parse(
        await readFile(path.join(harness.paseoHome, "config.json"), "utf8"),
      );
      expect(persisted.hub.deviceId).toBe("dev-1");
    } finally {
      await hub.close();
    }
  });

  test("re-registers in place when the relay endpoint changes", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();
      await waitFor("first register", () => hub.state.registerCalls.length >= 1);

      harness.relayConfig.publicEndpoint = "relay2.example.cn:443";
      harness.relayConfig.publicUseTls = false;

      const hasRelay2Endpoint = hasOfferEndpoint("relay2.example.cn:443");
      await waitFor("re-register with new endpoint", () =>
        hub.state.registerCalls.some(hasRelay2Endpoint),
      );
      // Same account + device name keeps the deviceId stable.
      expect(harness.manager.status().deviceId).toBe("dev-1");
    } finally {
      await hub.close();
    }
  });

  test("unregisters the device on graceful stop", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();
      await waitFor("register", () => hub.state.registerCalls.length >= 1);

      await harness.manager.stop();
      expect(hub.state.unregisterCalls).toEqual([{ deviceId: "dev-1" }]);
      expect(harness.manager.status().registered).toBe(false);
    } finally {
      await hub.close();
    }
  });

  test("an invalid token stops the loop without crashing", async () => {
    const hub = await startMockHub();
    try {
      hub.state.rejectTokens = true;
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();

      await waitFor("token error surfaces", () => harness.manager.status().lastError !== null);
      expect(harness.manager.status().lastError).toContain("auth.token_invalid");
      expect(harness.manager.status().registered).toBe(false);

      const callsAfterError = hub.state.registerCalls.length;
      await new Promise((resolve) => setTimeout(resolve, 120));
      // The loop paused instead of hammering the hub.
      expect(hub.state.registerCalls.length).toBe(callsAfterError);
    } finally {
      await hub.close();
    }
  });

  test("retries registration with backoff after a transient failure", async () => {
    const hub = await startMockHub();
    try {
      hub.state.failFirstRegisterOnce = true;
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();

      await waitFor("retry succeeds", () => hub.state.registerCalls.length >= 1);
      expect(harness.manager.status().registered).toBe(true);
      expect(harness.manager.status().lastError).toBeNull();
    } finally {
      await hub.close();
    }
  });

  test("applyCredentials persists the login, logout invalidates and clears credentials", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl, { token: null });
      await harness.manager.applyCredentials({
        baseUrl: `${hub.state.baseUrl}/api/`,
        token: "tok-1",
        phone: "13800138000",
        deviceName: "mac-studio",
      });
      // The pasted /api/ suffix is normalized away before persisting.
      await waitFor("register after applyCredentials", () => hub.state.registerCalls.length >= 1);

      const afterLogin = JSON.parse(
        await readFile(path.join(harness.paseoHome, "config.json"), "utf8"),
      );
      expect(afterLogin.hub).toMatchObject({
        baseUrl: hub.state.baseUrl,
        token: "tok-1",
        phone: "13800138000",
        deviceName: "mac-studio",
        deviceId: "dev-1",
      });

      await harness.manager.logout();

      expect(hub.state.logouts).toBe(1);
      expect(hub.state.unregisterCalls).toEqual([{ deviceId: "dev-1" }]);

      const persisted = JSON.parse(
        await readFile(path.join(harness.paseoHome, "config.json"), "utf8"),
      );
      expect(persisted.hub.token).toBeUndefined();
      expect(persisted.hub.phone).toBeUndefined();
      expect(persisted.hub.deviceId).toBeUndefined();
      expect(persisted.hub.baseUrl).toBe(hub.state.baseUrl);

      expect(harness.manager.status()).toMatchObject({
        loggedIn: false,
        registered: false,
        phone: null,
      });
    } finally {
      await hub.close();
    }
  });

  test("applyCredentials registers immediately without waiting for a heartbeat", async () => {
    const hub = await startMockHub();
    try {
      // A heartbeat interval longer than the wait timeout proves the register
      // came from the login path (scheduleTick(0)), not the periodic tick.
      const harness = await createHarness(hub.state.baseUrl, {
        token: null,
        heartbeatIntervalMs: 60_000,
      });
      await harness.manager.applyCredentials({
        baseUrl: hub.state.baseUrl,
        token: "tok-1",
        phone: "13800138000",
        deviceName: "mac-studio",
      });
      await waitFor("immediate register", () => hub.state.registerCalls.length >= 1, 2_000);
      expect(hub.state.heartbeatCalls.length).toBe(0);
      expect(harness.manager.status().registered).toBe(true);
    } finally {
      await hub.close();
    }
  });

  test("relay disabled holds registration back until relay is enabled", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl);
      harness.relayConfig.enabled = false;
      harness.manager.start();

      await new Promise((resolve) => setTimeout(resolve, 120));
      expect(hub.state.registerCalls.length).toBe(0);
      expect(harness.manager.status()).toMatchObject({ registered: false, relayEnabled: false });

      harness.relayConfig.enabled = true;
      await waitFor("register after relay enabled", () => hub.state.registerCalls.length >= 1);
      expect(harness.manager.status().registered).toBe(true);
    } finally {
      await hub.close();
    }
  });

  test("changePassword forwards old/new password with the stored token", async () => {
    const hub = await startMockHub();
    try {
      const harness = await createHarness(hub.state.baseUrl);
      harness.manager.start();
      await waitFor("register", () => hub.state.registerCalls.length >= 1);

      await harness.manager.changePassword({
        oldPassword: "secret",
        newPassword: "new-secret-8ch",
      });
      // A wrong old password surfaces the hub error.
      await expect(
        harness.manager.changePassword({ oldPassword: "wrong", newPassword: "x-8chars" }),
      ).rejects.toMatchObject({ code: "auth.invalid_credentials" });
    } finally {
      await hub.close();
    }
  });

  test("unconfigured manager stays idle", async () => {
    const harness = await createHarness("http://127.0.0.1:1", { token: null });
    harness.manager.start();
    const status = harness.manager.status();
    expect(status).toMatchObject({ configured: true, loggedIn: false, registered: false });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(harness.manager.status().registered).toBe(false);
  });
});
