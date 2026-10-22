/**
 * t18 纯函数/纯 store 测试：cron 校验与 cadence 文案、agent 目录筛选与标签、
 * attention store 状态机、theme store 三档解析。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  CADENCE_PRESETS,
  cadenceLabel,
  promptPreview,
  scheduleStatusText,
  validateCronExpression,
} from "../src/utils/schedule";
import {
  displayLabels,
  filterAgents,
  setDisplayLabels,
  sortAgents,
} from "../src/utils/agent-directory";
import type { AgentSnapshot } from "../src/connection/protocol-types";
import { attentionStore } from "../src/stores/attention-store";
import {
  normalizeThemePreference,
  resolveTheme,
  themePageClass,
  themeStore,
  THEME_CHROME,
} from "../src/stores/theme-store";

// ---------------------------------------------------------------------------
// schedule utils
// ---------------------------------------------------------------------------

describe("validateCronExpression（vendor 自 protocol cron-expression）", () => {
  it.each([
    "* * * * *",
    "0 * * * *",
    "0 9 * * *",
    "0 9 * * 1-5",
    "*/5 * * * *",
    "0 0-23/2 * * *",
    "30 9 1 * *",
    "0 9 * 3 1",
  ])("合法：%s", (expression) => {
    expect(validateCronExpression(expression)).toBeNull();
  });

  it.each([
    ["* * * *", "5 字段"],
    ["* * * * * *", "5 字段"],
    ["60 * * * *", "分钟"],
    ["* 24 * * *", "小时"],
    ["* * 0 * *", "日"],
    ["* * 32 * *", "日"],
    ["* * * 13 *", "月"],
    ["* * * * 7", "星期"],
    ["a * * * *", "非法字符"],
    ["*/0 * * * *", "步长"],
    ["1-0 * * * *", "范围"],
  ])("非法：%s → %s", (expression, fragment) => {
    const error = validateCronExpression(expression as string);
    expect(error).not.toBeNull();
    expect(error).toContain(fragment as string);
  });
});

describe("cadenceLabel", () => {
  it("cron 预设命中中文名", () => {
    expect(cadenceLabel({ type: "cron", expression: "0 9 * * 1-5" })).toBe("工作日 9:00");
    expect(cadenceLabel({ type: "cron", expression: "* * * * *" })).toBe("每分钟");
  });

  it("自定义 cron 显示表达式", () => {
    expect(cadenceLabel({ type: "cron", expression: "17 3 * * *" })).toBe("cron 17 3 * * *");
  });

  it("every 间隔分钟/小时", () => {
    expect(cadenceLabel({ type: "every", everyMs: 60_000 })).toBe("每分钟");
    expect(cadenceLabel({ type: "every", everyMs: 5 * 60_000 })).toBe("每 5 分钟");
    expect(cadenceLabel({ type: "every", everyMs: 2 * 3_600_000 })).toBe("每 2 小时");
  });

  it("预设覆盖常用档位且表达式 5 字段", () => {
    for (const preset of CADENCE_PRESETS) {
      expect(validateCronExpression(preset.expression)).toBeNull();
    }
  });
});

describe("scheduleStatusText / promptPreview", () => {
  it("状态文案", () => {
    expect(scheduleStatusText("active")).toBe("运行中");
    expect(scheduleStatusText("paused")).toBe("已暂停");
    expect(scheduleStatusText("completed")).toBe("已完成");
  });

  it("prompt 折叠空白并截断", () => {
    expect(promptPreview("a\n\n  b")).toBe("a b");
    const long = "x".repeat(80);
    expect(promptPreview(long, 10)).toBe(`${"x".repeat(10)}…`);
  });
});

// ---------------------------------------------------------------------------
// agent directory
// ---------------------------------------------------------------------------

function agent(overrides: Partial<AgentSnapshot>): AgentSnapshot {
  return {
    id: "a",
    title: "t",
    provider: "zcode",
    model: null,
    status: "idle",
    cwd: "/x",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    lastUserMessageAt: null,
    ...overrides,
  };
}

describe("filterAgents / sortAgents", () => {
  const agents = [
    agent({ id: "running", status: "running" }),
    agent({ id: "attention", status: "idle", requiresAttention: true }),
    agent({ id: "archived", status: "idle", archivedAt: "2026-01-02T00:00:00Z" }),
  ];

  it("active：仅未归档", () => {
    expect(filterAgents(agents, "active").map((a) => a.id)).toEqual(["running", "attention"]);
  });

  it("archived：仅归档", () => {
    expect(filterAgents(agents, "archived").map((a) => a.id)).toEqual(["archived"]);
  });

  it("attention：未归档且 requiresAttention", () => {
    expect(filterAgents(agents, "attention").map((a) => a.id)).toEqual(["attention"]);
  });

  it("all：全部", () => {
    expect(filterAgents(agents, "all")).toHaveLength(3);
  });

  it("sortAgents：attention 优先，归档沉底", () => {
    const sorted = sortAgents(filterAgents(agents, "all"));
    expect(sorted[0].id).toBe("attention");
    expect(sorted[sorted.length - 1].id).toBe("archived");
  });
});

describe("displayLabels / setDisplayLabels", () => {
  it("展示过滤内部 paseo.* 键", () => {
    expect(
      displayLabels({ "paseo.parent-agent-id": "x", urgent: "true", "paseo.open-agent-tab.c1": "true" }),
    ).toEqual(["urgent"]);
  });

  it("写回保留内部键并以 {label: true} 记录展示标签", () => {
    const next = setDisplayLabels(
      { "paseo.parent-agent-id": "x", old: "true" },
      ["urgent", "review"],
    );
    expect(next).toEqual({
      "paseo.parent-agent-id": "x",
      urgent: "true",
      review: "true",
    });
  });

  it("空标签入参被裁剪", () => {
    expect(setDisplayLabels(undefined, ["  ", "ok"])).toEqual({ ok: "true" });
  });
});

// ---------------------------------------------------------------------------
// attention store
// ---------------------------------------------------------------------------

describe("attentionStore", () => {
  beforeEach(() => {
    attentionStore.clearAll();
    attentionStore.bindSideEffects(null);
    attentionStore.setVibrationEnabled(true);
  });

  it("push → 计数与快照；agent_update 同步清除", () => {
    const counts: number[] = [];
    attentionStore.bindSideEffects({ onCountChange: (c) => counts.push(c) });
    attentionStore.handlePush({
      agentId: "a1",
      reason: "finished",
      timestamp: "2026-01-01T00:00:00Z",
      shouldNotify: true,
    });
    attentionStore.handlePush({
      agentId: "a2",
      reason: "permission",
      timestamp: "2026-01-01T00:00:01Z",
      shouldNotify: false,
    });
    expect(attentionStore.getCount()).toBe(2);
    expect(counts).toEqual([1, 2]);

    attentionStore.syncAgentSnapshot({ id: "a1", requiresAttention: false });
    expect(attentionStore.getCount()).toBe(1);
    expect(attentionStore.has("a2")).toBe(true);
  });

  it("shouldNotify 触发 onNotify；振动关闭时透传 shouldNotify=false", () => {
    const notified: Array<{ agentId: string; shouldNotify: boolean }> = [];
    attentionStore.bindSideEffects({
      onNotify: (entry, push) => notified.push({ agentId: entry.agentId, shouldNotify: push.shouldNotify }),
    });
    attentionStore.handlePush({
      agentId: "a1",
      reason: "finished",
      timestamp: "",
      shouldNotify: true,
    });
    expect(notified).toEqual([{ agentId: "a1", shouldNotify: true }]);

    attentionStore.setVibrationEnabled(false);
    attentionStore.handlePush({
      agentId: "a2",
      reason: "error",
      timestamp: "",
      shouldNotify: true,
    });
    // 振动关闭：仍到达 onNotify（toast/其他宿主行为可继续），但 shouldNotify=false
    expect(notified[1]).toEqual({ agentId: "a2", shouldNotify: false });
  });

  it("同一 agent 反复推送只提示一次，clear 后复位", () => {
    let notifyCount = 0;
    attentionStore.bindSideEffects({ onNotify: () => (notifyCount += 1) });
    const push = {
      agentId: "a1",
      reason: "finished" as const,
      timestamp: "",
      shouldNotify: true,
    };
    attentionStore.handlePush(push);
    attentionStore.handlePush(push);
    expect(notifyCount).toBe(1);
    attentionStore.clear(["a1"]);
    attentionStore.handlePush(push);
    expect(notifyCount).toBe(2);
  });

  it("syncAgentSnapshot：requiresAttention=true 补录红点", () => {
    attentionStore.syncAgentSnapshot({ id: "a1", requiresAttention: true });
    expect(attentionStore.has("a1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// theme store
// ---------------------------------------------------------------------------

describe("theme store 三档", () => {
  it("normalizeThemePreference 容错", () => {
    expect(normalizeThemePreference("dark")).toBe("dark");
    expect(normalizeThemePreference("light")).toBe("light");
    expect(normalizeThemePreference("auto")).toBe("auto");
    expect(normalizeThemePreference("blue")).toBe("auto");
    expect(normalizeThemePreference(null)).toBe("auto");
  });

  it("resolveTheme：auto 跟随系统，显式档位覆盖", () => {
    expect(resolveTheme("auto", "dark")).toBe("dark");
    expect(resolveTheme("auto", "light")).toBe("light");
    expect(resolveTheme("light", "dark")).toBe("light");
    expect(resolveTheme("dark", "light")).toBe("dark");
  });

  it("themePageClass：auto 无 class（媒体查询接管）", () => {
    expect(themePageClass("auto")).toBe("");
    expect(themePageClass("light")).toBe("theme-light");
    expect(themePageClass("dark")).toBe("theme-dark");
  });

  it("install/setPreference：持久化 + chrome 色板下发", () => {
    const saved: string[] = [];
    const chromes: string[] = [];
    themeStore.install(
      {
        get: () => (saved.length > 0 ? (saved[saved.length - 1] as "light" | "dark" | "auto") : null),
        set: (value) => saved.push(value),
      },
      (colors) => chromes.push(colors.navBackgroundColor),
      "light",
    );
    expect(themeStore.getPreference()).toBe("auto");
    expect(themeStore.getResolved()).toBe("light");
    expect(chromes).toEqual([THEME_CHROME.light.navBackgroundColor]);

    themeStore.setPreference("dark");
    expect(saved).toEqual(["dark"]);
    expect(themeStore.getPageClass()).toBe("theme-dark");
    expect(chromes[chromes.length - 1]).toBe(THEME_CHROME.dark.navBackgroundColor);

    // 系统主题变化：显式档位不改变 resolved，但 auto 档会
    themeStore.setSystemTheme("dark");
    expect(themeStore.getResolved()).toBe("dark");
    themeStore.setPreference("light");
    themeStore.setSystemTheme("dark");
    expect(themeStore.getResolved()).toBe("light");

    // 复位，避免影响其他用例
    themeStore.setPreference("auto");
    themeStore.setSystemTheme("light");
  });
});
