import type { Logger } from "pino";

import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import { ACPAgentClient, DEFAULT_ACP_CAPABILITIES } from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
} from "./diagnostic-utils.js";

/**
 * Default launch command for the built-in qwen-code provider
 * (`qwen --acp`, stdio ndJsonStream).
 */
export const QWEN_ACP_DEFAULT_COMMAND = ["qwen", "--acp"] as [string, ...string[]];

interface QwenACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

/**
 * Built-in Qwen Code CLI (Alibaba) ACP client. Launches `qwen --acp` by
 * default; `agents.providers.qwen-code.command`/`env` config overrides flow in
 * through runtimeSettings like other built-in providers. Modes, models, and
 * auth state are discovered over ACP at runtime, so no static catalog or model
 * resolver is wired here.
 */
export class QwenACPAgentClient extends ACPAgentClient {
  constructor(options: QwenACPAgentClientOptions) {
    super({
      provider: "qwen-code",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: QWEN_ACP_DEFAULT_COMMAND,
      capabilities: DEFAULT_ACP_CAPABILITIES,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: QWEN_ACP_DEFAULT_COMMAND[0],
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("Qwen Code", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            // The npm package @qwen-code/qwen-code installs a single `qwen`
            // binary, so only that name is worth mentioning in hints.
            knownBinaryNames: ["qwen"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Qwen Code", error),
      };
    }
  }
}
