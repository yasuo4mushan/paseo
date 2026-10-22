/**
 * t20 会话抽屉 store 测试：目录增量维护（upsert/remove）、活跃会话持久化与回退
 * （豆包式直达：删除/归档活跃会话后回退最新未归档会话）、断线清空、筛选目录。
 *
 * store 的 agent_update 合并逻辑经 applyAgentUpdate 公开（connection-manager
 * 订阅只是接线），单测直接调用；storage 注入内存实现，不碰 Taro。
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentSnapshot } from "../src/connection/protocol-types";
import { sessionStore } from "../src/stores/session-store";

function snapshot(overrides: Partial<AgentSnapshot> = {}): AgentSnapshot {
  return {
    id: "a1",
    title: null,
    provider: "zcode",
    model: null,
    status: "idle",
    cwd: "/repo",
    createdAt: "",
    updatedAt: "2026-01-02T00:00:00Z",
    lastUserMessageAt: null,
    ...overrides,
  };
}

let memory: string | null = null;
let notified = 0;

beforeEach(() => {
  sessionStore.reset();
  memory = null;
  notified = 0;
  sessionStore.installStorage(
    () => memory,
    (v) => {
      memory = v;
    },
  );
  sessionStore.subscribe(() => {
    notified += 1;
  });
});

afterEach(() => {
  sessionStore.reset();
});

describe("活跃会话", () => {
  it("setActive 持久化且幂等（同值不重复通知）", () => {
    sessionStore.setActive("a9");
    expect(memory).toBe("a9");
    expect(sessionStore.getSnapshot().activeId).toBe("a9");
    const before = notified;
    sessionStore.setActive("a9");
    expect(notified).toBe(before);
  });

  it("清空活跃会话同步清 storage", () => {
    sessionStore.setActive("a9");
    sessionStore.setActive(null);
    expect(memory).toBeNull();
  });
});

describe("目录增量维护", () => {
  it("upsert 合并去重（同 id 替换不重复）", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a1", title: "t1" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a2" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a1", title: "t2" }) });
    const agents = sessionStore.getSnapshot().agents;
    expect(agents.map((a) => a.id).sort()).toEqual(["a1", "a2"]);
    expect(agents.find((a) => a.id === "a1")?.title).toBe("t2");
  });

  it("remove 活跃会话 → 回退最新未归档会话并持久化", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "old", updatedAt: "2026-01-01T00:00:00Z" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "new", updatedAt: "2026-01-03T00:00:00Z" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "archived", archivedAt: "2026-01-02T00:00:00Z", updatedAt: "2026-01-04T00:00:00Z" }) });
    sessionStore.setActive("new");
    expect(memory).toBe("new");

    sessionStore.applyAgentUpdate({ kind: "remove", agentId: "new" });
    // 回退到剩余未归档会话里 updatedAt 最新的 old（archived 不参与）
    expect(sessionStore.getSnapshot().activeId).toBe("old");
    expect(memory).toBe("old");
  });

  it("remove 非活跃会话不影响活跃 id", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a1" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a2" }) });
    sessionStore.setActive("a1");
    sessionStore.applyAgentUpdate({ kind: "remove", agentId: "a2" });
    expect(sessionStore.getSnapshot().activeId).toBe("a1");
    expect(sessionStore.getSnapshot().agents.map((a) => a.id)).toEqual(["a1"]);
  });

  it("remove 全部会话后活跃回 null（空态 → 快捷输入框）", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "solo" }) });
    sessionStore.setActive("solo");
    sessionStore.applyAgentUpdate({ kind: "remove", agentId: "solo" });
    expect(sessionStore.getSnapshot().activeId).toBeNull();
    expect(memory).toBeNull();
  });
});

describe("activeAgent / directory", () => {
  it("activeAgent 只认目录内未归档会话", () => {
    sessionStore.setActive("missing");
    expect(sessionStore.activeAgent()).toBeNull();
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "live" }) });
    sessionStore.setActive("live");
    expect(sessionStore.activeAgent()?.id).toBe("live");
    sessionStore.applyAgentUpdate({
      kind: "upsert",
      agent: snapshot({ id: "live", archivedAt: "2026-01-05T00:00:00Z" }),
    });
    // 归档后 activeAgent 不再返回（refresh 时会做回退；推送路径下由目录筛选拦截）
    expect(sessionStore.activeAgent()).toBeNull();
  });

  it("directory：进行中不含归档；归档筛选取归档；排序运行中优先", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "arch", archivedAt: "2026-01-01T00:00:00Z" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "idle1" }) });
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "run1", status: "running" }) });
    expect(sessionStore.directory("active").map((a) => a.id)).toEqual(["run1", "idle1"]);
    expect(sessionStore.directory("archived").map((a) => a.id)).toEqual(["arch"]);
  });
});

describe("refresh（fetcher 注入）", () => {
  it("恢复持久化活跃会话；失效时回退最新未归档会话", async () => {
    memory = "stale";
    const agents = [
      snapshot({ id: "live", updatedAt: "2026-01-05T00:00:00Z" }),
      snapshot({ id: "stale", archivedAt: "2026-01-01T00:00:00Z" }),
    ];
    await sessionStore.refresh(async () => agents);
    expect(sessionStore.getSnapshot().activeId).toBe("live"); // stale 已归档 → 回退
    expect(memory).toBe("live");
    expect(sessionStore.getSnapshot().error).toBe("");
  });

  it("无未归档会话时空态（activeId null）；fetch 失败记录错误", async () => {
    await sessionStore.refresh(async () => [
      snapshot({ id: "arch", archivedAt: "2026-01-01T00:00:00Z" }),
    ]);
    expect(sessionStore.getSnapshot().activeId).toBeNull();
    await sessionStore.refresh(async () => {
      throw new Error("boom");
    });
    expect(sessionStore.getSnapshot().error).toBe("boom");
  });

  it("在途 refresh 被 reset 作废（世代守卫）", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pending = sessionStore.refresh(async () => {
      await gate;
      return [snapshot({ id: "late" })];
    });
    sessionStore.reset();
    release();
    await pending;
    expect(sessionStore.getSnapshot().agents).toEqual([]);
  });
});

describe("reset", () => {
  it("清空目录与活跃会话（断线时由 connection-manager teardown 调用）", () => {
    sessionStore.applyAgentUpdate({ kind: "upsert", agent: snapshot({ id: "a1" }) });
    sessionStore.setActive("a1");
    sessionStore.reset();
    expect(sessionStore.getSnapshot()).toEqual({ agents: [], activeId: null, error: "" });
    expect(notified).toBeGreaterThan(0);
  });
});
