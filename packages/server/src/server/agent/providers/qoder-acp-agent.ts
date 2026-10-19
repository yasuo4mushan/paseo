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
 * Default launch command for the built-in qoder provider
 * (`qoder --acp`, stdio ndJsonStream).
 */
export const QODER_ACP_DEFAULT_COMMAND = ["qoder", "--acp"] as [string, ...string[]];

interface QoderACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

/**
 * Built-in Qoder CLI (Alibaba) ACP client. Launches `qoder --acp` by default;
 * `agents.providers.qoder.command`/`env` config overrides flow in through
 * runtimeSettings like other built-in providers. Modes, models, and auth state
 * are discovered over ACP at runtime, so no static catalog or model resolver is
 * wired here.
 */
export class QoderACPAgentClient extends ACPAgentClient {
  constructor(options: QoderACPAgentClientOptions) {
    super({
      provider: "qoder",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: QODER_ACP_DEFAULT_COMMAND,
      capabilities: DEFAULT_ACP_CAPABILITIES,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: QODER_ACP_DEFAULT_COMMAND[0],
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("Qoder", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            // The npm package @qoder-ai/qodercli installs both `qoder` and the
            // `qodercli` alias, so mention both when resolving hints.
            knownBinaryNames: ["qoder", "qodercli"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Qoder", error),
      };
    }
  }
}
