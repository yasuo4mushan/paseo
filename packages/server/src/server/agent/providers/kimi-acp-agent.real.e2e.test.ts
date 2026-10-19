import { beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { isCommandAvailable } from "../../../executable-resolution/executable-resolution.js";
import { KIMI_ACP_DEFAULT_COMMAND } from "./kimi-acp-agent.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

describe("Kimi ACP provider (real) handshake", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable(KIMI_ACP_DEFAULT_COMMAND[0]);
  });

  test("the built-in `kimi acp` default command completes the initialize handshake signed in or not", async (context) => {
    if (!canRun) {
      context.skip();
    }
    const cwd = await mkdtemp(join(tmpdir(), "kimi-acp-real-"));
    const child = spawn(KIMI_ACP_DEFAULT_COMMAND[0], KIMI_ACP_DEFAULT_COMMAND.slice(1), {
      cwd,
      stdio: ["pipe", "pipe", "ignore"],
    });
    const connection = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
      }),
      ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)),
    );

    try {
      // Login is not required for the handshake: kimi reports terminal-login
      // auth methods and only needs the account once a session runs a turn.
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      expect(initialized.agentInfo.name).toContain("Kimi");
      expect(typeof initialized.protocolVersion).toBe("number");
      expect(initialized.authMethods.length).toBeGreaterThan(0);
    } finally {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 1000, forceTimeoutMs: 1000 });
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
