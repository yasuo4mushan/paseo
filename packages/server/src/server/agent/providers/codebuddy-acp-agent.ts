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
 * Default launch command for the built-in codebuddy-code provider
 * (`codebuddy --acp`, stdio ndJsonStream).
 */
export const CODEBUDDY_ACP_DEFAULT_COMMAND = ["codebuddy", "--acp"] as [string, ...string[]];

interface CodeBuddyACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

/**
 * Built-in CodeBuddy Code (Tencent) ACP client. Launches `codebuddy --acp` by
 * default; `agents.providers["codebuddy-code"].command`/`env` config overrides
 * flow in through runtimeSettings like other built-in providers. Modes, models,
 * and auth state are discovered over ACP at runtime, so no static catalog or
 * model resolver is wired here.
 */
export class CodeBuddyACPAgentClient extends ACPAgentClient {
  constructor(options: CodeBuddyACPAgentClientOptions) {
    super({
      provider: "codebuddy-code",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: CODEBUDDY_ACP_DEFAULT_COMMAND,
      capabilities: DEFAULT_ACP_CAPABILITIES,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: CODEBUDDY_ACP_DEFAULT_COMMAND[0],
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("CodeBuddy", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["codebuddy"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("CodeBuddy", error),
      };
    }
  }
}
