import { describe, expect, test, vi } from "vitest";

import { createTestLogger } from "../../../test-utils/test-logger.js";
import type { ProviderRuntimeSettings } from "../provider-launch-config.js";
import { CodeBuddyACPAgentClient, CODEBUDDY_ACP_DEFAULT_COMMAND } from "./codebuddy-acp-agent.js";

vi.mock("../../../executable-resolution/executable-resolution.js", () => ({
  findExecutable: vi.fn(async (command: string) => `/resolved/bin/${command}`),
  executableExists: vi.fn(async (path: string) => path.startsWith("/resolved/bin/")),
  isCommandAvailable: vi.fn(async (command: string) => !command.startsWith("missing")),
}));

class TestCodeBuddyACPAgentClient extends CodeBuddyACPAgentClient {
  constructor(runtimeSettings?: ProviderRuntimeSettings) {
    super({ logger: createTestLogger(), runtimeSettings });
  }

  public async launchCommand(): Promise<{ command: string; args: string[] }> {
    return this.resolveLaunchCommand();
  }
}

describe("CodeBuddyACPAgentClient", () => {
  test("ships `codebuddy --acp` as the default launch command", () => {
    expect(CODEBUDDY_ACP_DEFAULT_COMMAND).toEqual(["codebuddy", "--acp"]);
  });

  test("constructs as the built-in codebuddy-code provider with ACP capabilities", () => {
    const client = new CodeBuddyACPAgentClient({ logger: createTestLogger() });

    expect(client.provider).toBe("codebuddy-code");
    expect(client.capabilities).toMatchObject({
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
    });
  });

  test("resolves the default command when no runtime override is set", async () => {
    const client = new TestCodeBuddyACPAgentClient();

    await expect(client.launchCommand()).resolves.toEqual({
      command: "codebuddy",
      args: ["--acp"],
    });
  });

  test("a replace command override swaps the binary while the default ACP args still apply", async () => {
    const client = new TestCodeBuddyACPAgentClient({
      command: { mode: "replace", argv: ["/opt/tencent/codebuddy", "--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "/opt/tencent/codebuddy",
      args: ["--verbose", "--acp"],
    });
  });

  test("an append command override keeps the default binary and appends args", async () => {
    const client = new TestCodeBuddyACPAgentClient({
      command: { mode: "append", args: ["--verbose"] },
    });

    await expect(client.launchCommand()).resolves.toEqual({
      command: "codebuddy",
      args: ["--verbose", "--acp"],
    });
  });

  test("reports a CodeBuddy diagnostic with the resolved binary", async () => {
    const client = new TestCodeBuddyACPAgentClient();

    const { diagnostic } = await client.getDiagnostic();

    expect(diagnostic).toContain("CodeBuddy");
    expect(diagnostic).toContain("codebuddy");
  });
});
