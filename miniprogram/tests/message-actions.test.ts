/**
 * t25 时间线消息操作状态机测试：
 *  - 操作单可用项（用户/assistant/其他条目差异；编辑入口随 rewind 能力变标签）
 *  - 编辑模式裁决（rewind / draft 降级 / 不可编辑）
 *  - 复制/引用文本构造（markdown 原文、摘要截断）
 *  - rewind RPC 容错解析 + 快照 capabilities 解析
 * DaemonConnection 层的 rewind 请求/响应编排在 daemon-connection.test.ts。
 */

import { describe, expect, it } from "vitest";
import {
  actionForTapIndex,
  copyTextFor,
  editHintFor,
  editModeFor,
  messageActionsFor,
  quoteTextFor,
} from "../src/utils/message-actions";
import { parseAgentRewindResponse, parseAgentSnapshot } from "../src/connection/protocol-types";
import type { AgentTimelineItem } from "../src/connection/protocol-types";

const userMessage = (
  overrides: Partial<Extract<AgentTimelineItem, { type: "user_message" }>> = {},
): AgentTimelineItem => ({
  type: "user_message",
  text: "帮我看看这个报错",
  ...overrides,
});

const assistantMessage: AgentTimelineItem = {
  type: "assistant_message",
  text: "# 标题\n\n正文 `code` 与 [链接](https://example.com)",
};

describe("messageActionsFor：操作单可用项", () => {
  it("用户消息：复制 + 编辑重发 + 引用复制", () => {
    const items = messageActionsFor({
      item: userMessage({ messageId: "m1" }),
      canRewind: true,
    });
    expect(items.map((i) => i.key)).toEqual(["copy", "edit", "quote"]);
    expect(items[1].label).toBe("编辑重发");
  });

  it("不支持回退的用户消息：编辑入口保留但标签注明作新消息", () => {
    const items = messageActionsFor({ item: userMessage(), canRewind: false });
    expect(items.map((i) => i.key)).toEqual(["copy", "edit", "quote"]);
    expect(items[1].label).toBe("编辑（作新消息）");
  });

  it("assistant 消息：复制 + 引用，无编辑项", () => {
    const items = messageActionsFor({ item: assistantMessage, canRewind: true });
    expect(items.map((i) => i.key)).toEqual(["copy", "quote"]);
  });

  it("其他条目类型（工具/todo/错误）无操作层", () => {
    for (const item of [
      { type: "tool_call", tool: "read", status: "completed" },
      { type: "todo", items: [] },
      { type: "error", message: "x" },
      { type: "reasoning", text: "思考中" },
    ] as AgentTimelineItem[]) {
      expect(messageActionsFor({ item, canRewind: true })).toEqual([]);
    }
  });
});

describe("editModeFor：编辑模式裁决", () => {
  it("daemon messageId + provider 支持回退 → rewind", () => {
    expect(editModeFor({ item: userMessage({ messageId: "m1" }), canRewind: true })).toBe("rewind");
  });

  it("无 messageId（乐观本地条目）→ draft 降级，即使 provider 支持回退", () => {
    expect(
      editModeFor({ item: userMessage({ clientMessageId: "local-1" }), canRewind: true }),
    ).toBe("draft");
  });

  it("provider 不支持回退 → draft（有 messageId 也不走 rewind）", () => {
    expect(editModeFor({ item: userMessage({ messageId: "m1" }), canRewind: false })).toBe("draft");
  });

  it("assistant / 其他条目不可编辑", () => {
    expect(editModeFor({ item: assistantMessage, canRewind: true })).toBeNull();
    expect(editModeFor({ item: { type: "todo", items: [] }, canRewind: true })).toBeNull();
  });

  it("两种模式的提示语义不同（撤回 vs 新消息）", () => {
    expect(editHintFor("rewind")).toContain("撤回");
    expect(editHintFor("draft")).toContain("新消息");
  });
});

describe("copyTextFor / quoteTextFor：复制文本构造", () => {
  it("assistant markdown 消息复制原始 markdown（非渲染文本）", () => {
    expect(copyTextFor(assistantMessage)).toBe(
      "# 标题\n\n正文 `code` 与 [链接](https://example.com)",
    );
  });

  it("用户消息复制原文", () => {
    expect(copyTextFor(userMessage({ text: "原文" }))).toBe("原文");
  });

  it("无操作层的条目返回 null", () => {
    expect(copyTextFor({ type: "reasoning", text: "思考" })).toBeNull();
    expect(copyTextFor({ type: "error", message: "e" })).toBeNull();
  });

  it("引用文本：标题 + 引用前缀摘要", () => {
    expect(quoteTextFor("hello 会话", "第一行\n第二行")).toBe("hello 会话\n\n> 第一行\n> 第二行");
  });

  it("超长消息截断到上限并加省略号；多行逐行加引用前缀", () => {
    const long = Array.from({ length: 40 }, (_, i) => `line-${i}`).join("\n");
    const quoted = quoteTextFor("t", long, 40);
    expect(quoted.startsWith("t\n\n> ")).toBe(true);
    expect(quoted.endsWith("…")).toBe(true);
    expect(quoted.length).toBeLessThan(long.length + 20);
  });

  it("无标题时回落通用标题", () => {
    expect(quoteTextFor(null, "内容")).toBe("会话消息\n\n> 内容");
    expect(quoteTextFor("  ", "内容")).toBe("会话消息\n\n> 内容");
  });
});

describe("actionForTapIndex：操作单点选映射", () => {
  const items = messageActionsFor({ item: userMessage({ messageId: "m" }), canRewind: true });

  it("tapIndex 映射回动作项", () => {
    expect(actionForTapIndex(items, 0)?.key).toBe("copy");
    expect(actionForTapIndex(items, 1)?.key).toBe("edit");
    expect(actionForTapIndex(items, 2)?.key).toBe("quote");
  });

  it("越界（面板并发变动）返回 null 由调用方静默", () => {
    expect(actionForTapIndex(items, 99)).toBeNull();
    expect(actionForTapIndex([], 0)).toBeNull();
  });
});

describe("rewind 协议容错解析", () => {
  it("agent.rewind.response payload：ok / error 两态", () => {
    expect(
      parseAgentRewindResponse({ requestId: "r1", agentId: "a1", ok: true, error: null }),
    ).toEqual({ agentId: "a1", ok: true, error: null });
    expect(
      parseAgentRewindResponse({
        requestId: "r1",
        agentId: "a1",
        ok: false,
        error: "Cannot rewind before the provider acknowledges the submitted prompt",
      }),
    ).toEqual({
      agentId: "a1",
      ok: false,
      error: "Cannot rewind before the provider acknowledges the submitted prompt",
    });
  });

  it("坏 payload（缺 agentId / 非对象）返回 null", () => {
    expect(parseAgentRewindResponse({ requestId: "r1", ok: true })).toBeNull();
    expect(parseAgentRewindResponse(null)).toBeNull();
    expect(parseAgentRewindResponse("x")).toBeNull();
  });

  it("快照解析带 capabilities.rewind 开关", () => {
    const snapshot = parseAgentSnapshot({
      id: "a1",
      provider: "claude",
      status: "idle",
      cwd: "/tmp",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
      capabilities: {
        supportsStreaming: true,
        supportsRewindConversation: true,
        supportsRewindFiles: false,
      },
    });
    expect(snapshot?.capabilities?.supportsRewindConversation).toBe(true);
    expect(snapshot?.capabilities?.supportsRewindFiles).toBe(false);
  });

  it("旧 daemon 快照无 capabilities 字段：解析成功且 capabilities 为 undefined", () => {
    const snapshot = parseAgentSnapshot({
      id: "a1",
      provider: "codex",
      status: "idle",
      cwd: "/tmp",
      createdAt: "2026-10-01T00:00:00Z",
      updatedAt: "2026-10-01T00:00:00Z",
    });
    expect(snapshot).not.toBeNull();
    expect(snapshot?.capabilities).toBeUndefined();
  });
});
