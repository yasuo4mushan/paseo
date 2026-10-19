import type { Logger } from "pino";

import type { AgentModelDefinition } from "../agent-sdk-types.js";
import {
  checkProviderLaunchAvailable,
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
} from "../provider-launch-config.js";
import {
  ACPAgentClient,
  type ACPCatalogModelResolverContext,
  DEFAULT_ACP_CAPABILITIES,
  deriveSelectorOptions,
  findSelectConfigOption,
} from "./acp-agent.js";
import {
  buildBinaryDiagnosticRows,
  buildCommandResolutionDiagnosticRows,
  formatProviderDiagnostic,
  formatProviderDiagnosticError,
  toDiagnosticErrorMessage,
} from "./diagnostic-utils.js";

/** Default launch command for the built-in kimi provider (`kimi acp`, stdio JSON-RPC). */
export const KIMI_ACP_DEFAULT_COMMAND = ["kimi", "acp"] as [string, ...string[]];

interface KimiACPAgentClientOptions {
  logger: Logger;
  runtimeSettings?: ProviderRuntimeSettings;
}

// Kimi exposes thinking options only for the selected model. Keep its model-switching
// discovery here: other providers can supply a read-only catalog instead.
export async function resolveKimiCatalogModels({
  connection,
  sessionId,
  models,
  configOptions,
  runRequest,
  transformConfigOptions,
  logger,
  provider,
}: ACPCatalogModelResolverContext): Promise<AgentModelDefinition[]> {
  if (models.length <= 1) {
    return models;
  }
  const modelOption = findSelectConfigOption({ configOptions, category: "model" });
  if (!modelOption) {
    return models;
  }

  const resolved: AgentModelDefinition[] = [];
  for (const model of models) {
    try {
      const response = await runRequest(() =>
        connection.setSessionConfigOption({
          sessionId,
          configId: modelOption.id,
          value: model.id,
        }),
      );
      const modelConfigOptions = transformConfigOptions(response.configOptions ?? []);
      const thinkingOptions = deriveSelectorOptions(modelConfigOptions, "thought_level");
      resolved.push({
        ...model,
        thinkingOptions: thinkingOptions.length > 0 ? thinkingOptions : undefined,
        defaultThinkingOptionId:
          thinkingOptions.find((option) => option.isDefault)?.id ?? undefined,
      });
    } catch (error) {
      const errorMessage = toDiagnosticErrorMessage(error);
      if (model.isDefault) {
        logger.warn(
          { modelId: model.id, error: errorMessage },
          `${provider} catalog probe could not refresh thinking options for current model "${model.id}"; keeping session options`,
        );
        resolved.push(model);
        continue;
      }
      logger.warn(
        { modelId: model.id, error: errorMessage },
        `${provider} catalog probe could not resolve thinking options for model "${model.id}"; omitting thinking options`,
      );
      resolved.push({
        ...model,
        thinkingOptions: undefined,
        defaultThinkingOptionId: undefined,
      });
    }
  }
  return resolved;
}

/**
 * Built-in Kimi Code (Moonshot AI) ACP client. Launches `kimi acp` by default;
 * `agents.providers.kimi.command`/`env` config overrides flow in through
 * runtimeSettings like other built-in providers.
 */
export class KimiACPAgentClient extends ACPAgentClient {
  constructor(options: KimiACPAgentClientOptions) {
    super({
      provider: "kimi",
      logger: options.logger,
      runtimeSettings: options.runtimeSettings,
      defaultCommand: KIMI_ACP_DEFAULT_COMMAND,
      capabilities: DEFAULT_ACP_CAPABILITIES,
      // Kimi advertises slash commands with available_commands_update after
      // session/new, so the first listCommands() waits for that batch (kept
      // from the previous generic-ACP integration).
      waitForInitialCommands: true,
      catalogModelResolver: resolveKimiCatalogModels,
    });
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const launch = await resolveProviderLaunch({
        commandConfig: this.runtimeSettings?.command,
        defaultBinary: KIMI_ACP_DEFAULT_COMMAND[0],
      });
      const availability = await checkProviderLaunchAvailable(launch);

      return {
        diagnostic: formatProviderDiagnostic("Kimi", [
          ...(await buildCommandResolutionDiagnosticRows(launch, {
            knownBinaryNames: ["kimi"],
          })),
          ...(await buildBinaryDiagnosticRows(launch, availability)),
        ]),
      };
    } catch (error) {
      return {
        diagnostic: formatProviderDiagnosticError("Kimi", error),
      };
    }
  }
}
