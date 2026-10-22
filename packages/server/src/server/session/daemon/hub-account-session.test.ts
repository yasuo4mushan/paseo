import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { createHubAccountManager } from "../../hub-account.js";
import { HubAccountSession } from "./hub-account-session.js";
import type { SessionOutboundMessage } from "../../messages.js";

function startMockHub(): Promise<{
  baseUrl: string;
  logins: Array<Record<string, unknown>>;
  registerCalls: Array<Record<string, unknown>>;
  heartbeatCalls: Array<Record<string, unknown>>;
  accountRegisters: number;
  logouts: number;
  close: () => Promise<void>;
}> {
  const logins: Array<Record<string, unknown>> = [];
  const registerCalls: Array<Record<string, unknown>> = [];
  const heartbeatCalls: Array<Record<string, unknown>> = [];
  let accountRegisters = 0;
  let logouts = 0;
  let deviceCounter = 0;
  const devicesByDeviceId = new Map<string, Record<string, unknown>>();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const method = (req.url ?? "").replace(/^\/api\//, "");
      const payload = body ? JSON.parse(body) : {};
      const send = (data: unknown) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, data }));
      };
      const fail = (code: string, message: string) => {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: false, error: { code, message } }));
      };
      if (method === "auth.login") {
        logins.push(payload);
        if (payload.username !== "alice" || payload.password !== "secret") {
          fail("auth.invalid_credentials", "bad credentials");
          return;
        }
        send({ token: "tok-1", account: { id: "acc-1", username: payload.username } });
        return;
      }
      if (method === "auth.register") {
        accountRegisters += 1;
        if (payload.username === "taken") {
          fail("auth.username_taken", "username taken");
          return;
        }
        send({ account: { id: "acc-1", username: payload.username } });
        return;
      }
      if (method === "auth.logout") {
        logouts += 1;
        send({ ok: true });
        return;
      }
      if (method === "devices.register") {
        registerCalls.push(payload);
        deviceCounter += 1;
        const deviceId = `dev-${deviceCounter}`;
        devicesByDeviceId.set(deviceId, payload);
        send({ deviceId, updated: true });
        return;
      }
      if (method === "devices.heartbeat") {
        heartbeatCalls.push(payload);
        if (!devicesByDeviceId.has(payload.deviceId)) {
          fail("devices.offer_invalid", "unknown device");
          return;
        }
        send({ ok: true });
        return;
      }
      if (method === "devices.unregister") {
        devicesByDeviceId.delete(payload.deviceId);
        send({ ok: true });
        return;
      }
      res.statusCode = 404;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: false, error: { code: "not_found", message: method } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        logins,
        registerCalls,
        heartbeatCalls,
        get accountRegisters() {
          return accountRegisters;
        },
        get logouts() {
          return logouts;
        },
        close: () =>
          new Promise<void>((resolveClose, rejectClose) => {
            server.close((error) => {
              if (error) {
                rejectClose(error);
                return;
              }
              resolveClose();
            });
          }),
      });
    });
  });
}

const roots: string[] = [];
const managers: Array<ReturnType<typeof createHubAccountManager>> = [];

async function stopManager(manager: ReturnType<typeof createHubAccountManager>): Promise<void> {
  await manager.stop().catch(() => undefined);
}

const stubLogger = {
  child: () => stubLogger,
  error: () => undefined,
} as unknown as never;

interface SessionHarness {
  session: HubAccountSession;
  manager: ReturnType<typeof createHubAccountManager>;
  relayConfig: { enabled: boolean; publicEndpoint: string; publicUseTls: boolean };
  emitted: SessionOutboundMessage[];
}

async function createSession(
  baseUrl: string,
  options?: { relayEnabled?: boolean; heartbeatIntervalMs?: number },
): Promise<SessionHarness> {
  const root = await mkdtemp(path.join(os.tmpdir(), "paseo-hub-session-"));
  roots.push(root);
  const paseoHome = path.join(root, ".paseo");
  await mkdir(paseoHome, { recursive: true });
  const relayConfig = {
    enabled: options?.relayEnabled ?? false,
    publicEndpoint: "relay.example.cn:443",
    publicUseTls: true,
  };
  const manager = createHubAccountManager({
    paseoHome,
    serverId: "srv-1",
    daemonPublicKeyB64: "6Gj1cQ0T3Fv7YhN2mK8pR5wXeZbAqL4sD9uH7oP6jEw=",
    getRelayConfig: () => relayConfig,
    initial: { baseUrl, token: null, username: null, deviceName: null },
    heartbeatIntervalMs: options?.heartbeatIntervalMs ?? 20,
    backoffBaseMs: 10,
  });
  managers.push(manager);
  const emitted: SessionOutboundMessage[] = [];
  const session = new HubAccountSession({
    host: { emit: (msg) => emitted.push(msg) },
    hubAccount: manager,
    logger: stubLogger,
  });
  return { session, manager, relayConfig, emitted };
}

async function waitFor(label: string, predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for: ${label}`);
}

describe("HubAccountSession", () => {
  afterEach(async () => {
    await Promise.all(managers.splice(0).map(stopManager));
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  test("reports status for an unconfigured daemon", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({ type: "hub.status.request", requestId: "req-1" });
      const response = emitted.find((msg) => msg.type === "hub.status.response");
      expect(response).toMatchObject({
        type: "hub.status.response",
        payload: { requestId: "req-1", status: { loggedIn: false, registered: false } },
      });
    } finally {
      await hub.close();
    }
  });

  test("login stores credentials and replies with the account", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({
        type: "hub.login.request",
        requestId: "req-2",
        baseUrl: `${hub.baseUrl}/api/`,
        username: "alice",
        password: "secret",
      });
      expect(emitted).toContainEqual({
        type: "hub.login.response",
        payload: { requestId: "req-2", accountId: "acc-1", username: "alice" },
      });
      await session.handleRequest({ type: "hub.status.request", requestId: "req-3" });
      const statusResponse = emitted.findLast((msg) => msg.type === "hub.status.response");
      expect(statusResponse).toMatchObject({
        payload: { requestId: "req-3", status: { loggedIn: true, username: "alice" } },
      });
    } finally {
      await hub.close();
    }
  });

  test("invalid credentials surface the hub error code", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({
        type: "hub.login.request",
        requestId: "req-4",
        baseUrl: hub.baseUrl,
        username: "alice",
        password: "wrong",
      });
      const error = emitted.find((msg) => msg.type === "rpc_error");
      expect(error).toMatchObject({
        type: "rpc_error",
        payload: { requestId: "req-4", code: "auth.invalid_credentials" },
      });
    } finally {
      await hub.close();
    }
  });

  test("register creates the account, logs in, and applies credentials", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({
        type: "hub.register.request",
        requestId: "req-5",
        baseUrl: hub.baseUrl,
        username: "alice",
        password: "secret",
        deviceName: "mac-studio",
      });
      expect(hub.accountRegisters).toBe(1);
      expect(hub.logins).toEqual([{ username: "alice", password: "secret" }]);
      expect(emitted).toContainEqual({
        type: "hub.register.response",
        payload: { requestId: "req-5", accountId: "acc-1", username: "alice" },
      });
    } finally {
      await hub.close();
    }
  });

  test("register with a taken username surfaces auth.username_taken", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({
        type: "hub.register.request",
        requestId: "req-6",
        baseUrl: hub.baseUrl,
        username: "taken",
        password: "secret",
      });
      const error = emitted.find((msg) => msg.type === "rpc_error");
      expect(error).toMatchObject({
        payload: { requestId: "req-6", code: "auth.username_taken" },
      });
    } finally {
      await hub.close();
    }
  });

  test("login without baseUrl uses the daemon's configured hub address", async () => {
    const hub = await startMockHub();
    try {
      const { session, emitted } = await createSession(hub.baseUrl);
      await session.handleRequest({
        type: "hub.login.request",
        requestId: "req-7",
        username: "alice",
        password: "secret",
      });
      expect(emitted).toContainEqual({
        type: "hub.login.response",
        payload: { requestId: "req-7", accountId: "acc-1", username: "alice" },
      });
      // The request hit the mock hub this manager was configured with.
      expect(hub.logins).toEqual([{ username: "alice", password: "secret" }]);
      expect(emitted.find((msg) => msg.type === "rpc_error")).toBeUndefined();
    } finally {
      await hub.close();
    }
  });

  test("login registers the device immediately, before any heartbeat tick", async () => {
    const hub = await startMockHub();
    try {
      // A heartbeat interval longer than the test timeout proves the register
      // call came from the login path, not from the periodic tick.
      const { session, emitted } = await createSession(hub.baseUrl, {
        relayEnabled: true,
        heartbeatIntervalMs: 60_000,
      });
      await session.handleRequest({
        type: "hub.login.request",
        requestId: "req-8",
        username: "alice",
        password: "secret",
      });
      expect(emitted.find((msg) => msg.type === "rpc_error")).toBeUndefined();
      await waitFor("immediate register", () => hub.registerCalls.length >= 1);
      expect(hub.heartbeatCalls.length).toBe(0);
      expect(hub.registerCalls[0].name).toBeTruthy();
      expect(hub.registerCalls[0].offer).toMatchObject({ serverId: "srv-1" });
    } finally {
      await hub.close();
    }
  });
});
