import { describe, expect, test } from "vitest";
import type { ProviderSnapshotEntry } from "@getpaseo/protocol/agent-types";
import {
  buildProviderChecklistRows,
  checklistStateLabelKey,
  checklistStateTone,
  isDomesticOnboardingProvider,
  ONBOARDING_PROVIDERS,
} from "./provider-checklist";

function entry(
  provider: string,
  status: ProviderSnapshotEntry["status"],
  overrides: Partial<ProviderSnapshotEntry> = {},
): ProviderSnapshotEntry {
  return { provider, status, ...overrides } as ProviderSnapshotEntry;
}

describe("ONBOARDING_PROVIDERS order (t29)", () => {
  test("pins the five domestic providers first", () => {
    expect(ONBOARDING_PROVIDERS.slice(0, 5).map((item) => item.provider)).toEqual([
      "zcode",
      "kimi",
      "codebuddy-code",
      "qoder",
      "qwen-code",
    ]);
    expect(ONBOARDING_PROVIDERS.slice(5).map((item) => item.provider)).toEqual([
      "claude",
      "codex",
      "copilot",
      "opencode",
    ]);
  });

  test("zcode carries no CLI commands; the others carry official ones", () => {
    const byId = new Map(ONBOARDING_PROVIDERS.map((item) => [item.provider, item]));
    expect(byId.get("zcode")).toMatchObject({ loginCommand: null, installCommand: null });
    expect(byId.get("kimi")).toMatchObject({
      loginCommand: "kimi login",
      installCommand: "npm i -g @moonshot-ai/kimi-code",
    });
    expect(byId.get("codebuddy-code")).toMatchObject({
      loginCommand: "codebuddy",
      installCommand: "npm i -g @tencent-ai/codebuddy-code",
    });
    expect(byId.get("qoder")).toMatchObject({
      loginCommand: "qoder login",
      installCommand: "npm i -g @qoder-ai/qodercli",
    });
    expect(byId.get("qwen-code")).toMatchObject({
      loginCommand: "qwen",
      installCommand: "npm i -g @qwen-code/qwen-code",
    });
  });

  test("marks exactly the domestic five", () => {
    expect(isDomesticOnboardingProvider("zcode")).toBe(true);
    expect(isDomesticOnboardingProvider("qwen-code")).toBe(true);
    expect(isDomesticOnboardingProvider("claude")).toBe(false);
  });
});

describe("buildProviderChecklistRows (t29)", () => {
  test("no snapshot yet renders every row as checking", () => {
    const rows = buildProviderChecklistRows(undefined);
    expect(rows).toHaveLength(9);
    for (const row of rows) {
      expect(row.state).toBe("checking");
    }
  });

  test("maps snapshot statuses onto checklist states with the right command", () => {
    const rows = buildProviderChecklistRows([
      entry("kimi", "ready"),
      entry("qoder", "error", { error: "not logged in" }),
      entry("qwen-code", "unavailable"),
      entry("claude", "loading"),
    ]);
    const byId = new Map(rows.map((row) => [row.provider, row]));
    expect(byId.get("kimi")?.state).toBe("ready");
    expect(byId.get("qoder")).toMatchObject({ state: "needs-login" });
    expect(byId.get("qwen-code")).toMatchObject({ state: "not-installed" });
    expect(byId.get("claude")?.state).toBe("checking");

    // The errored (needs-login) row shows the login command, the unavailable
    // row shows the install command, the ready row shows none.
    expect(byId.get("qoder")?.loginCommand).toBe("qoder login");
    expect(byId.get("qwen-code")?.installCommand).toBe("npm i -g @qwen-code/qwen-code");
    expect(byId.get("kimi")?.loginCommand).toBe("kimi login");
  });

  test("a provider missing from the loaded snapshot counts as not installed", () => {
    const rows = buildProviderChecklistRows([entry("kimi", "ready")]);
    const byId = new Map(rows.map((row) => [row.provider, row]));
    expect(byId.get("kimi")?.state).toBe("ready");
    expect(byId.get("opencode")?.state).toBe("not-installed");
  });

  test("keeps the pinned order regardless of snapshot order", () => {
    const rows = buildProviderChecklistRows([
      entry("opencode", "ready"),
      entry("zcode", "ready"),
      entry("kimi", "ready"),
    ]);
    expect(rows.slice(0, 2).map((row) => row.provider)).toEqual(["zcode", "kimi"]);
    expect(rows[rows.length - 1].provider).toBe("opencode");
  });

  test("prefers the snapshot label and falls back to the manifest label", () => {
    const rows = buildProviderChecklistRows([
      entry("kimi", "ready", { label: "Kimi (custom label)" }),
      entry("qoder", "ready"),
    ]);
    const byId = new Map(rows.map((row) => [row.provider, row]));
    expect(byId.get("kimi")?.label).toBe("Kimi (custom label)");
    expect(byId.get("qoder")?.label).toBe("Qoder");
  });
});

describe("checklist status presentation (t29)", () => {
  test("state tones: ready=success, needs-login=warning, rest muted", () => {
    expect(checklistStateTone("ready")).toBe("success");
    expect(checklistStateTone("needs-login")).toBe("warning");
    expect(checklistStateTone("not-installed")).toBe("muted");
    expect(checklistStateTone("checking")).toBe("muted");
  });

  test("every state resolves to a label key", () => {
    expect(checklistStateLabelKey("ready")).toBe("ready");
    expect(checklistStateLabelKey("needs-login")).toBe("needsLogin");
    expect(checklistStateLabelKey("not-installed")).toBe("notInstalled");
    expect(checklistStateLabelKey("checking")).toBe("checking");
  });
});
