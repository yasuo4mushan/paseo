import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import { getAgentProviderDefinition } from "@getpaseo/protocol/provider-manifest";

/**
 * t29 onboarding agent checklist view-model.
 *
 * Turns provider snapshot entries into the onboarding checklist rows: the five
 * domestic providers first (zcode / kimi / codebuddy / qoder / qwen-code),
 * then claude / codex / copilot / opencode. Status tones follow the task
 * contract: ready = green, errored (in practice: CLI present but not logged
 * in) = yellow with the login command, unavailable = gray with the install
 * command, loading = spinner.
 *
 * Commands are the providers' own official ones; provider names and commands
 * stay untranslated per the i18n scope rules.
 */
export type ProviderChecklistState = "ready" | "needs-login" | "not-installed" | "checking";

export interface ProviderChecklistRow {
  provider: string;
  /** Display label: snapshot label first, static manifest label as fallback. */
  label: string;
  state: ProviderChecklistState;
  /** Terminal command shown for the `needs-login` state. */
  loginCommand: string | null;
  /** npm command shown for the `not-installed` state. */
  installCommand: string | null;
  /** True for the five pinned domestic providers. */
  domestic: boolean;
}

export interface OnboardingProviderDefinition {
  provider: string;
  loginCommand: string | null;
  installCommand: string | null;
}

/**
 * Checklist order: five domestic providers pinned first, then the
 * international four. zcode is the Z.ai desktop app — it has no CLI install
 * or login command; the row renders its own ready hint instead.
 */
export const ONBOARDING_PROVIDERS: readonly OnboardingProviderDefinition[] = [
  { provider: "zcode", loginCommand: null, installCommand: null },
  {
    provider: "kimi",
    loginCommand: "kimi login",
    installCommand: "npm i -g @moonshot-ai/kimi-code",
  },
  {
    provider: "codebuddy-code",
    loginCommand: "codebuddy",
    installCommand: "npm i -g @tencent-ai/codebuddy-code",
  },
  { provider: "qoder", loginCommand: "qoder login", installCommand: "npm i -g @qoder-ai/qodercli" },
  {
    provider: "qwen-code",
    loginCommand: "qwen",
    installCommand: "npm i -g @qwen-code/qwen-code",
  },
  {
    provider: "claude",
    loginCommand: "claude",
    installCommand: "npm i -g @anthropic-ai/claude-code",
  },
  { provider: "codex", loginCommand: "codex login", installCommand: "npm i -g @openai/codex" },
  { provider: "copilot", loginCommand: "copilot", installCommand: "npm i -g @github/copilot" },
  {
    provider: "opencode",
    loginCommand: "opencode auth login",
    installCommand: "npm i -g opencode-ai",
  },
] as const;

const DOMESTIC_PROVIDERS = new Set(["zcode", "kimi", "codebuddy-code", "qoder", "qwen-code"]);

export function isDomesticOnboardingProvider(provider: string): boolean {
  return DOMESTIC_PROVIDERS.has(provider);
}

export function onboardingProviderLabel(
  provider: string,
  entries: readonly ProviderSnapshotEntry[] | undefined,
): string {
  const fromSnapshot = entries?.find((entry) => entry.provider === provider)?.label;
  if (fromSnapshot && fromSnapshot.trim().length > 0) return fromSnapshot;
  return getAgentProviderDefinition(provider)?.label ?? provider;
}

function entryState(
  entry: ProviderSnapshotEntry | undefined,
  loaded: boolean,
): ProviderChecklistState {
  if (!loaded) return "checking";
  if (!entry) return "not-installed";
  switch (entry.status) {
    case "ready":
      return "ready";
    case "loading":
      return "checking";
    case "error":
      // The binary ran but failed — for these CLIs that is almost always
      // "not logged in", so the checklist pairs it with the login command.
      return "needs-login";
    case "unavailable":
    default:
      return "not-installed";
  }
}

/**
 * Builds the checklist rows. `entries` is the raw provider snapshot; rows keep
 * the ONBOARDING_PROVIDERS order regardless of snapshot ordering.
 */
export function buildProviderChecklistRows(
  entries: readonly ProviderSnapshotEntry[] | undefined,
): ProviderChecklistRow[] {
  const loaded = Array.isArray(entries);
  const byProvider = new Map((entries ?? []).map((entry) => [entry.provider, entry]));
  return ONBOARDING_PROVIDERS.map((definition) => ({
    provider: definition.provider,
    label: onboardingProviderLabel(definition.provider, entries),
    state: entryState(byProvider.get(definition.provider), loaded),
    loginCommand: definition.loginCommand,
    installCommand: definition.installCommand,
    domestic: isDomesticOnboardingProvider(definition.provider),
  }));
}

/** Tone for the status dot, matching the app's status colors. */
export function checklistStateTone(state: ProviderChecklistState): "success" | "warning" | "muted" {
  switch (state) {
    case "ready":
      return "success";
    case "needs-login":
      return "warning";
    default:
      return "muted";
  }
}

/** i18n key under `hubOnboarding.providers.states` for a checklist state. */
export function checklistStateLabelKey(state: ProviderChecklistState): string {
  switch (state) {
    case "ready":
      return "ready";
    case "needs-login":
      return "needsLogin";
    case "not-installed":
      return "notInstalled";
    case "checking":
      return "checking";
  }
}
