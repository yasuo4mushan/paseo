import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { QwenACPAgentClient, QWEN_ACP_DEFAULT_COMMAND } from "./qwen-acp-agent.js";

vi.mock("../../../executable-resolution/executable-resolution.js", () => ({
  findExecutable: vi.fn(async (command: string) => `/resolved/bin/${command}`),
  executableExists: vi.fn(async (path: string) => path.startsWith("/resolved/bin/")),
  isCommandAvailable: vi.fn(async (command: string) => !command.startsWith("missing")),
}));

class TestQwenACPAgentClient extends QwenACPAgentClient {
  constructor(runtimeSettings?: ProviderRuntimeSettings) {
    super({ logger: createTestLogger(), runtimeSettings });
  }

  public async launchCommand(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }
}

describe("QwenACPAgentClient", () => {
  test("ships `qwen --acp` as the default launch command", () => {
    expect(QWEN_ACP_DEFAULT_COMMAND).toEqual(["qwen", "--acp"]);
  });

  test("constructs as the built-in qwen-code provider with ACP capabilities", () => {
    const client = new QwenACPAgentClient({ logger: createTestLogger() });

    expect(client.provider).toBe("qwen-code");
    expect(client.capabilities).toMatchObject({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
    });
  });

  test("resolves the default command when no runtime override is set", async () => {
    const client = new TestQwenACPAgentClient();

    await expect(client.launchCommand()).resolves.toEqual({
      command: "qwen",
      args: ["--acp"],
    });
  });

  test("a replace command override swaps the binary while the default ACP args still apply", async () => {
    const client = new TestQwenACPAgentClient({
      command: { mode: "replace", argv: ["/opt/alibaba/qwen", "--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "/opt/alibaba/qwen",
      args: ["--verbose", "--acp"],
    });
  });

  test("an append command override keeps the default binary and appends args", async () => {
    const client = new TestQwenACPAgentClient({
      command: { mode: "append", args: ["--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "qwen",
      args: ["--verbose", "--acp"],
    });
  });

  test("reports a Qwen Code diagnostic with the resolved binary", async () => {
    const client = new TestQwenACPAgentClient();

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Qwen Code");
    expect(diagnostic).toContain("qwen");
  });
});
