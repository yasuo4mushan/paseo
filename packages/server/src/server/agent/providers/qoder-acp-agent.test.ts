import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { QoderACPAgentClient, QODER_ACP_DEFAULT_COMMAND } from "./qoder-acp-agent.js";

vi.mock("../../../executable-resolution/executable-resolution.js", () => ({
  findExecutable: vi.fn(async (command: string) => `/resolved/bin/${command}`),
  executableExists: vi.fn(async (path: string) => path.startsWith("/resolved/bin/")),
  isCommandAvailable: vi.fn(async (command: string) => !command.startsWith("missing")),
}));

class TestQoderACPAgentClient extends QoderACPAgentClient {
  constructor(runtimeSettings?: ProviderRuntimeSettings) {
    super({ logger: createTestLogger(), runtimeSettings });
  }

  public async launchCommand(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }
}

describe("QoderACPAgentClient", () => {
  test("ships `qoder --acp` as the default launch command", () => {
    expect(QODER_ACP_DEFAULT_COMMAND).toEqual(["qoder", "--acp"]);
  });

  test("constructs as the built-in qoder provider with ACP capabilities", () => {
    const client = new QoderACPAgentClient({ logger: createTestLogger() });

    expect(client.provider).toBe("qoder");
    expect(client.capabilities).toMatchObject({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
    });
  });

  test("resolves the default command when no runtime override is set", async () => {
    const client = new TestQoderACPAgentClient();

    await expect(client.launchCommand()).resolves.toEqual({
      command: "qoder",
      args: ["--acp"],
    });
  });

  test("a replace command override swaps the binary while the default ACP args still apply", async () => {
    const client = new TestQoderACPAgentClient({
      command: { mode: "replace", argv: ["/opt/alibaba/qoder", "--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "/opt/alibaba/qoder",
      args: ["--verbose", "--acp"],
    });
  });

  test("an append command override keeps the default binary and appends args", async () => {
    const client = new TestQoderACPAgentClient({
      command: { mode: "append", args: ["--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "qoder",
      args: ["--verbose", "--acp"],
    });
  });

  test("reports a Qoder diagnostic with the resolved binary", async () => {
    const client = new TestQoderACPAgentClient();

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("Qoder");
    expect(diagnostic).toContain("qoder");
  });
});
