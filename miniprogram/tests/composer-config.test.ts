/**
 * t20 composer 四选择器状态机测试：
 * 草稿转移（换 provider 清下游/换模型清 thinking）、目录种子、会话态 pill 视图
 * （provider 锁定/thinking 随模型/effective 优先）、会话态选择 → set_* 动作判定、
 * 草稿 → create config 装配。
 */

import { describe, expect, it } from "vitest";
import type { AgentSnapshot, ProviderModelDefinition } from "../src/connection/protocol-types";
import {
  applyDraftSelection,
  draftPillViews,
  draftToCreateConfig,
  seedDraft,
  sessionPillViews,
  sessionSelectionAction,
  thinkingOptionsFor,
  type ComposerCatalog,
} from "../src/utils/composer-config";

function model(overrides: Partial<ProviderModelDefinition> = {}): ProviderModelDefinition {
  return { id: "m1", label: "模型一", ...overrides };
}

const CATALOG: ComposerCatalog = {
  providers: [
    { provider: "zcode", available: true },
    { provider: "kimi", available: true },
    { provider: "codex", available: false, error: "未登录" },
  ],
  models: [
    model({ id: "glm-5", label: "GLM-5", isDefault: true, thinkingOptions: [
      { id: "high", label: "高", isDefault: false },
      { id: "low", label: "低", isDefault: true },
    ], defaultThinkingOptionId: "high" }),
    model({ id: "glm-5-air", label: "GLM-5-Air" }),
  ],
  modes: [
    { id: "default", label: "默认审批" },
    { id: "bypass", label: "跳过审批" },
  ],
};

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a1",
    title: null,
    provider: "zcode",
    model: "glm-5",
    status: "idle",
    cwd: "/repo",
    createdAt: "",
    updatedAt: "",
    lastUserMessageAt: null,
    ...overrides,
  };
}

describe("thinkingOptionsFor", () => {
  it("取所选模型的 thinkingOptions；无模型/无档位 → 空", () => {
    expect(thinkingOptionsFor(CATALOG.models, "glm-5")).toHaveLength(2);
    expect(thinkingOptionsFor(CATALOG.models, "glm-5-air")).toEqual([]);
    expect(thinkingOptionsFor(CATALOG.models, "")).toEqual([]);
  });
});

describe("applyDraftSelection", () => {
  const draft = { provider: "zcode", modelId: "glm-5", thinkingOptionId: "low", modeId: "default" };

  it("换 provider 清空模型/thinking/模式", () => {
    const next = applyDraftSelection(draft, "provider", "kimi", CATALOG);
    expect(next).toEqual({ provider: "kimi", modelId: "", thinkingOptionId: "", modeId: "" });
  });

  it("换模型清 thinking（档位随模型变化）", () => {
    const next = applyDraftSelection(draft, "model", "glm-5-air", CATALOG);
    expect(next.modelId).toBe("glm-5-air");
    expect(next.thinkingOptionId).toBe("");
    expect(next.modeId).toBe("default"); // 模式不受影响
  });

  it("重复选择同值是幂等的", () => {
    expect(applyDraftSelection(draft, "mode", "default", CATALOG)).toEqual(draft);
  });
});

describe("seedDraft", () => {
  it("默认取第一个可用 provider + 默认模型 + 默认档位 + 首个模式", () => {
    const seeded = seedDraft(CATALOG);
    expect(seeded.provider).toBe("zcode");
    expect(seeded.modelId).toBe("glm-5");
    expect(seeded.thinkingOptionId).toBe("high"); // defaultThinkingOptionId 优先
    expect(seeded.modeId).toBe("default");
  });

  it("跳过不可用 provider；偏好 provider 存在时优先", () => {
    expect(seedDraft(CATALOG, "kimi").provider).toBe("kimi");
    expect(seedDraft(CATALOG, "codex").provider).toBe("zcode");
  });
});

describe("draftPillViews", () => {
  it("无 thinking 档位的模型隐藏 thinking pill", () => {
    const draft = seedDraft(CATALOG);
    const views = draftPillViews(draft, CATALOG);
    expect(views.map((v) => v.key)).toEqual(["provider", "model", "thinking", "mode"]);
    const noThinking = applyDraftSelection(draft, "model", "glm-5-air", CATALOG);
    const hidden = draftPillViews(noThinking, CATALOG).filter((v) => !v.hidden);
    expect(hidden.map((v) => v.key)).toEqual(["provider", "model", "mode"]);
  });
});

describe("sessionPillViews", () => {
  it("provider 锁定；thinking 取 effective 优先；mode 目录用快照 availableModes", () => {
    const snap = snapshot({
      thinkingOptionId: "low",
      effectiveThinkingOptionId: "high",
      currentModeId: "bypass",
      availableModes: [{ id: "bypass", label: "跳过审批" }],
    });
    const views = sessionPillViews(snap, CATALOG);
    const byKey = Object.fromEntries(views.map((v) => [v.key, v]));
    expect(byKey.provider.locked).toBe(true);
    expect(byKey.thinking.selectedId).toBe("high");
    expect(byKey.mode.options).toEqual([{ id: "bypass", label: "跳过审批", description: undefined }]);
  });
});

describe("sessionSelectionAction", () => {
  const snap = snapshot({ currentModeId: "default", thinkingOptionId: "high", model: "glm-5" });

  it("provider 不可改（协议无 per-agent provider 切换）", () => {
    expect(sessionSelectionAction(snap, CATALOG, "provider", "kimi")).toBeNull();
  });

  it("mode/model/thinking 同值选择返回 null；变更产出对应动作", () => {
    expect(sessionSelectionAction(snap, CATALOG, "mode", "default")).toBeNull();
    expect(sessionSelectionAction(snap, CATALOG, "mode", "bypass")).toEqual({
      kind: "mode",
      modeId: "bypass",
    });
    expect(sessionSelectionAction(snap, CATALOG, "model", "glm-5-air")).toEqual({
      kind: "model",
      modelId: "glm-5-air",
    });
    expect(sessionSelectionAction(snap, CATALOG, "thinking", "low")).toEqual({
      kind: "thinking",
      thinkingOptionId: "low",
    });
  });

  it("空值 = 清除自定义（model/thinking 传 null 语义）", () => {
    expect(sessionSelectionAction(snap, CATALOG, "model", "")).toEqual({
      kind: "model",
      modelId: null,
    });
  });
});

describe("draftToCreateConfig", () => {
  it("空值省略（协议字段 optional，省略 = provider 默认）", () => {
    const bare = draftToCreateConfig(
      { provider: "zcode", modelId: "", thinkingOptionId: "", modeId: "" },
      "/repo",
      "ws1",
    );
    expect(bare).toEqual({ provider: "zcode", cwd: "/repo", workspaceId: "ws1" });

    const full = draftToCreateConfig(
      { provider: "zcode", modelId: "glm-5", thinkingOptionId: "high", modeId: "bypass" },
      "/repo",
    );
    expect(full).toEqual({
      provider: "zcode",
      cwd: "/repo",
      model: "glm-5",
      thinkingOptionId: "high",
      modeId: "bypass",
    });
  });
});
