/**
 * Builds the "personal provider repository" snapshot Paseo hands to a
 * ZCode app-server via ZCODE_PERSONAL_PROVIDER_CONFIG_FILE.
 *
 * ZCode 3.12+ app-servers resolve models from a provider-repository pair
 * (ZCODE_BUILTIN_PROVIDER_CONFIG_FILE + ZCODE_PERSONAL_PROVIDER_CONFIG_FILE)
 * instead of the legacy CLI settings file. Without them, a standalone
 * app-server sees an empty model registry ("Provider Registry 中不存在 Model")
 * even when the desktop app has providers configured, because the default
 * personal repository (~/.zcode/v2/provider_config.json) only carries rules the
 * desktop UI materialized there.
 *
 * Paseo therefore reads — never writes — ZCode's own config files
 * (~/.zcode/v2/config.json, authoritative, plus ~/.zcode/cli/config.json),
 * converts the enabled API-key providers into repository rules, and writes an
 * atomic, process-scoped snapshot under the OS temp dir. The bundled builtin
 * catalog of the desktop app is passed through untouched.
 *
 * Same conversion as the MIT-licensed community bridge
 * (ZhouXiaolin/zcode-provider, syncModernProviderRepository), verified against
 * ZCode 0.16.9 / Desktop 3.14.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ZCODE_V2_CONFIG_PATH = path.join(os.homedir(), ".zcode", "v2", "config.json");
export const ZCODE_CLI_SETTINGS_PATH = path.join(os.homedir(), ".zcode", "cli", "config.json");

/** Candidate locations for the desktop app's bundled builtin provider catalog. */
export const ZCODE_BUILTIN_PROVIDER_CANDIDATES = [
  // ZCode 3.12+ desktop layout.
  "/Applications/ZCode.app/Contents/Resources/config/provider/zcode-builtin.json",
  // ZCode 0.16.x desktop layout.
  "/Applications/ZCode.app/Contents/Resources/glm/provider/zcode-builtin.json",
];

export interface ZcodeProviderRepository {
  /** Absolute path of the written snapshot (personal repository). */
  personalFilePath: string;
  /** Absolute path of the bundled builtin catalog, when found. */
  builtinFilePath: string;
  /** The default `providerId/modelId` selection discovered from ZCode config. */
  defaultModelRef: { providerId: string; modelId: string } | null;
}

interface SettingsProviderModel {
  reasoning?: { variants?: string[]; defaultVariant?: string };
  limit?: { context?: number; output?: number };
}

interface SettingsProvider {
  name?: string;
  kind?: string;
  enabled?: boolean;
  options?: {
    apiKey?: string;
    apiKeyRequired?: boolean;
    baseURL?: string;
    headers?: Record<string, string>;
  };
  headers?: Record<string, string>;
  models?: Record<string, SettingsProviderModel>;
}

interface SettingsConfig {
  model?: { main?: string } | string | undefined;
  provider?: Record<string, SettingsProvider>;
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed != null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** `builtin:<id>` becomes `zcode-provider:<id>` in modern repositories. */
export function modernZcodeProviderId(providerId: string): string {
  return providerId.startsWith("builtin:")
    ? `zcode-provider:${providerId.slice("builtin:".length)}`
    : providerId;
}

function parseModelRef(ref: unknown): { providerId: string; modelId: string } | null {
  if (typeof ref !== "string") return null;
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) return null;
  return { providerId: ref.slice(0, separator), modelId: ref.slice(separator + 1) };
}

function settingsConfigOf(raw: Record<string, unknown> | null): SettingsConfig {
  return (raw as SettingsConfig | null) ?? {};
}

function modelMainOf(model: SettingsConfig["model"]): string | undefined {
  if (model == null) return undefined;
  return typeof model === "string" ? model : model.main;
}

function apiTypeOfKind(kind: string | undefined): string {
  switch (kind) {
    case "anthropic":
      return "anthropic-messages";
    case "openai":
      return "openai-responses";
    default:
      return "openai-chat-completions";
  }
}

function fileExists(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

export function findZcodeBuiltinProviderFile(): string | null {
  return ZCODE_BUILTIN_PROVIDER_CANDIDATES.find(fileExists) ?? null;
}

function writeJsonAtomic(filePath: string, value: unknown): void {
  const temp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(temp, filePath);
}

interface ConvertedZcodeProviders {
  providerRules: Array<Record<string, unknown>>;
  providerModelRules: Array<Record<string, unknown>>;
  fallbackModelRef: { providerId: string; modelId: string } | null;
}

/** Converts ZCode settings-format providers into repository rules. */
function convertZcodeSettingsProviders(
  providers: Map<string, SettingsProvider>,
): ConvertedZcodeProviders {
  const providerRules: Array<Record<string, unknown>> = [];
  const providerModelRules: Array<Record<string, unknown>> = [];
  let fallbackModelRef: { providerId: string; modelId: string } | null = null;
  for (const [sourceProviderId, provider] of providers) {
    const rule = convertZcodeSettingsProvider(sourceProviderId, provider);
    if (!rule) continue;
    providerRules.push(rule.providerRule);
    providerModelRules.push(...rule.modelRules);
    fallbackModelRef ??= { providerId: rule.providerId, modelId: rule.modelIds[0] };
  }
  return { providerRules, providerModelRules, fallbackModelRef };
}

function convertZcodeSettingsProvider(
  sourceProviderId: string,
  provider: SettingsProvider | undefined,
): {
  providerId: string;
  modelIds: string[];
  providerRule: Record<string, unknown>;
  modelRules: Array<Record<string, unknown>>;
} | null {
  if (!provider || provider.enabled === false) return null;
  const apiKey = provider.options?.apiKey?.trim();
  if (!apiKey || provider.options?.apiKeyRequired === false) return null;
  const modelIds = Object.keys(provider.models ?? {});
  if (modelIds.length === 0) return null;

  const providerId = modernZcodeProviderId(sourceProviderId);
  const headers = { ...provider.headers, ...provider.options?.headers };
  const providerRule: Record<string, unknown> = {
    providerId,
    ...(provider.name ? { providerName: provider.name } : {}),
    config: {
      group: "standard-personal",
      access: { type: "api-key", apiKey },
      api: {
        type: apiTypeOfKind(provider.kind),
        ...(provider.options?.baseURL ? { baseUrl: provider.options.baseURL } : {}),
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      },
      personalModelIds: modelIds,
      modelOrder: modelIds,
    },
  };

  const modelRules: Array<Record<string, unknown>> = [];
  for (const [modelId, model] of Object.entries(provider.models ?? {})) {
    if (model?.limit?.context) {
      modelRules.push({
        modelId,
        config: { properties: { contextWindow: model.limit.context } },
        providerId,
      });
    }
  }
  return { providerId, modelIds, providerRule, modelRules };
}

/**
 * Builds the provider repository snapshot. Returns null when no builtin
 * catalog is installed (legacy app-servers that read the CLI settings file
 * directly must not receive the env pair) or when nothing could be read.
 */
export function buildZcodeProviderRepository(): ZcodeProviderRepository | null {
  const builtinFilePath = findZcodeBuiltinProviderFile();
  if (!builtinFilePath) {
    return null;
  }

  // ~/.zcode/v2/config.json (desktop UI) is authoritative; the CLI settings
  // file can carry additional providers for CLI-only configurations.
  const v2 = settingsConfigOf(readJson(ZCODE_V2_CONFIG_PATH));
  const cli = settingsConfigOf(readJson(ZCODE_CLI_SETTINGS_PATH));
  const mergedProviders = new Map<string, SettingsProvider>();
  for (const [providerId, provider] of Object.entries(cli.provider ?? {})) {
    mergedProviders.set(providerId, provider);
  }
  for (const [providerId, provider] of Object.entries(v2.provider ?? {})) {
    mergedProviders.set(providerId, provider);
  }

  const converted = convertZcodeSettingsProviders(mergedProviders);
  const configuredRef =
    parseModelRef(modelMainOf(v2.model)) ?? parseModelRef(modelMainOf(cli.model));
  const defaultModelRef = configuredRef
    ? {
        providerId: modernZcodeProviderId(configuredRef.providerId),
        modelId: configuredRef.modelId,
      }
    : converted.fallbackModelRef;

  const personalFilePath = path.join(
    os.tmpdir(),
    `paseo-zcode-provider-config-${process.pid}.json`,
  );
  try {
    writeJsonAtomic(personalFilePath, {
      schemaVersion: 1,
      config: {
        providerConfigRules: { providerRules: converted.providerRules },
        modelConfigRules: {
          providerModelRules: converted.providerModelRules,
          manualProviderModelRules: [],
        },
        ...(defaultModelRef ? { defaultModelSelection: defaultModelRef } : {}),
      },
    });
  } catch {
    return null;
  }

  return { personalFilePath, builtinFilePath, defaultModelRef };
}

/**
 * Environment overlay that points a ZCode app-server at the Paseo-built
 * provider repository pair. Returns an empty overlay for legacy installs
 * (no bundled builtin catalog found) so their settings-file mode is preserved.
 * Keys the user set explicitly (provider env config) are left untouched.
 */
export function zcodeServerEnvironmentOverlay(
  repository: ZcodeProviderRepository | null,
  explicitEnv?: Record<string, string>,
): Record<string, string> {
  if (!repository) return {};
  const overlay: Record<string, string> = {
    ZCODE_BUILTIN_PROVIDER_CONFIG_FILE: repository.builtinFilePath,
    ZCODE_PERSONAL_PROVIDER_CONFIG_FILE: repository.personalFilePath,
  };
  for (const key of Object.keys(overlay)) {
    if (explicitEnv && typeof explicitEnv[key] === "string" && explicitEnv[key]) {
      delete overlay[key];
    }
  }
  return overlay;
}
