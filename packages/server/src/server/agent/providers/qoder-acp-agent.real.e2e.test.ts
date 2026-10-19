import { beforeAll, describe, expect, test } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";

import { isCommandAvailable } from "../../../executable-resolution/executable-resolution.js";
import { QODER_ACP_DEFAULT_COMMAND } from "./qoder-acp-agent.js";
import { terminateWithTreeKill } from "../../../utils/tree-kill.js";

describe("Qoder ACP provider (real) handshake", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = await isCommandAvailable(QODER_ACP_DEFAULT_COMMAND[0]);
  });

  test("the built-in `qoder --acp` default command completes the initialize handshake signed in or not", async (context) => {
    if (!canRun) {
      context.skip();
    }
    const cwd = await mkdtemp(join(tmpdir(), "qoder-acp-real-"));
    const child = spawn(QODER_ACP_DEFAULT_COMMAND[0], QODER_ACP_DEFAULT_COMMAND.slice(1), {
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
      // Login is not required for the handshake: qoder reports its
      // qodercli-login auth method and only needs an account once a session
      // runs a turn.
      const initialized = await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      });

      // Unlike codebuddy, qoder reports the optional agentInfo field, so the
      // smoke can pin the identity of the shipped CLI.
      expect(initialized.agentInfo?.name).toBe("qoder-cli");
      expect(initialized.agentInfo?.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(typeof initialized.protocolVersion).toBe("number");
      expect(initialized.agentCapabilities).toBeTruthy();
      expect(initialized.authMethods.some((method) => method.id === "qodercli-login")).toBe(true);
    } finally {
      await terminateWithTreeKill(child, { gracefulTimeoutMs: 1000, forceTimeoutMs: 1000 });
      await rm(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});
