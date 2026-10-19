/**
 * Real ZCode app-server e2e.
 *
 * The handshake suite (session/create + session/read + session/close) talks to
 * the locally installed `zcode app-server` and consumes no model quota. It is
 * skipped when no ZCode install is discovered.
 *
 * The single-turn suite runs one minimal model turn ("Reply with exactly: ok")
 * and is therefore gated behind ZCODE_E2E_REAL_TURN=1; CI and default test
 * runs never trigger it.
 */
import { describe, expect, it } from "vitest";
import { pino } from "pino";

import { ZcodeAgentClient, ZCODE_MODES, ZCODE_PROVIDER } from "./agent.js";
import { isZcodeLaunchAvailable } from "./discovery.js";
import {
  extractZcodeSessionId,
  ZCODE_RUNTIME_PREFERENCES,
  ZCodeAppServerClient,
} from "./protocol.js";
import { spawnZcodeChild } from "./agent.js";

const logger = pino({ level: "silent" });

async function maybeSpawnRealClient(): Promise<ZCodeAppServerClient | null> {
  const { available, launch } = await isZcodeLaunchAvailable();
  if (!available) return null;
  const child = spawnZcodeChild(launch.command, launch.args, "/tmp");
  return new ZCodeAppServerClient({
    child,
    logger,
    onServerRequest: (request) => {
      if (request.method === "session/requestRuntimePreferences") {
        return ZCODE_RUNTIME_PREFERENCES;
      }
      if (request.method === "interaction/requestPermission") {
        return { decision: "deny", reason: "e2e probe" };
      }
      if (request.method === "interaction/requestOfficialMcpAuthHeaders") {
        return { ok: false, reason: "unavailable" };
      }
      return { cancelled: true };
    },
  });
}

describe("zcode real app-server handshake", () => {
  it.skipIf(process.env.CI !== undefined || process.env.ZCODE_E2E_SKIP === "1")(
    "creates a session, reads the model catalog, and closes it",
    { timeout: 60_000 },
    async () => {
      const client = await maybeSpawnRealClient();
      if (!client) {
        console.warn("zcode not found on this machine; skipping real handshake e2e");
        return;
      }
      try {
        const created = (await client.request(
          "session/create",
          { workspace: { workspacePath: "/tmp", workspaceKey: "/tmp" } },
          30_000,
        )) as Record<string, unknown>;
        const sessionId = extractZcodeSessionId(created);
        expect(sessionId).toMatch(/^sess_/);
        // The create result advertises the protocol identity.
        const protocol = (created.protocol ?? {}) as { name?: string; version?: number };
        expect(protocol.name).toBe("ZCode Protocol");

        const snapshot = (await client.request("session/read", {
          sessionId,
          messageLimit: 1,
        })) as { settings?: { model?: { available?: unknown[] } } };
        const available = snapshot?.settings?.model?.available;
        expect(Array.isArray(available)).toBe(true);
        if (Array.isArray(available) && available.length > 0) {
          console.warn(`zcode catalog e2e discovered ${available.length} models via session/read`);
        }
        await client.request("session/close", { sessionId }).catch(() => undefined);
      } finally {
        await client.dispose();
      }
    },
  );
});

describe.skipIf(process.env.ZCODE_E2E_REAL_TURN !== "1" || process.env.CI !== undefined)(
  "zcode real single turn (gated: ZCODE_E2E_REAL_TURN=1)",
  () => {
    it("runs one minimal prompt end to end", { timeout: 120_000 }, async () => {
      const { available } = await isZcodeLaunchAvailable();
      if (!available) {
        console.warn("zcode not found; skipping gated real turn");
        return;
      }
      const clientAdapter = new ZcodeAgentClient(logger);
      const session = await clientAdapter.createSession({
        provider: ZCODE_PROVIDER,
        cwd: "/tmp",
        modeId: "build",
      });
      try {
        const result = await session.run("Reply with exactly: ok");
        expect(result.finalText.trim().toLowerCase()).toContain("ok");
        expect(result.sessionId).toMatch(/^sess_/);
      } finally {
        await session.close();
      }
    });

    it("discovers the catalog from the real app-server", { timeout: 90_000 }, async () => {
      const { available } = await isZcodeLaunchAvailable();
      if (!available) return;
      const clientAdapter = new ZcodeAgentClient(logger);
      const catalog = await clientAdapter.fetchCatalog({ scope: "global", force: true });
      expect(catalog.modes).toEqual(ZCODE_MODES);
      expect(catalog.models.length).toBeGreaterThan(0);
      for (const model of catalog.models) {
        expect(model.id).toMatch(/^.+\/.+$/);
      }
    });
  },
);
