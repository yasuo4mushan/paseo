/**
 * 权限弹层状态机测试（t16）：mock 推送驱动 permission-store 的排队/去重/
 * 回应/他端解决/断线清空。
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  permissionStore,
  type PendingPermission,
} from "../src/permission/permission-store";
import type { PermissionRequest } from "../src/connection/protocol-types";

function makeRequest(id: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    id,
    provider: "claude",
    name: "Bash",
    kind: "tool",
    title: undefined,
    description: undefined,
    input: { command: "npm test" },
    actions: [
      { id: "reject", label: "拒绝", behavior: "deny", variant: "danger" },
      { id: "accept", label: "允许", behavior: "allow", variant: "primary" },
    ],
    ...overrides,
  };
}

function snapshot(): PendingPermission[] {
  return permissionStore.getSnapshot();
}

beforeEach(() => {
  permissionStore.clearAll();
  permissionStore.bindSender(null);
});

describe("permissionStore", () => {
  it("推送入队，按 agentId+请求 id 去重", () => {
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.handlePush({ agentId: "a2", request: makeRequest("p1") });
    expect(snapshot()).toHaveLength(2);
    expect(snapshot()[0]).toMatchObject({ agentId: "a1" });
    expect(snapshot()[1]).toMatchObject({ agentId: "a2" });
  });

  it("多条请求排队，弹层按序展示队首", () => {
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p2") });
    expect(snapshot().map((p) => p.request.id)).toEqual(["p1", "p2"]);
  });

  it("respond：未绑定 sender 时失败且队列不变", () => {
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    const ok = permissionStore.respond("a1", "p1", { behavior: "allow" });
    expect(ok).toBe(false);
    expect(snapshot()).toHaveLength(1);
  });

  it("respond：发送成功即出队（fire-and-forget）", () => {
    const sent: unknown[] = [];
    permissionStore.bindSender((agentId, requestId, response) => {
      sent.push({ agentId, requestId, response });
    });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    const ok = permissionStore.respond("a1", "p1", {
      behavior: "deny",
      selectedActionId: "reject",
      message: "Denied by user",
    });
    expect(ok).toBe(true);
    expect(snapshot()).toHaveLength(0);
    expect(sent).toEqual([
      {
        agentId: "a1",
        requestId: "p1",
        response: { behavior: "deny", selectedActionId: "reject", message: "Denied by user" },
      },
    ]);
  });

  it("respond：sender 抛错时保留请求", () => {
    permissionStore.bindSender(() => {
      throw new Error("socket closed");
    });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    const ok = permissionStore.respond("a1", "p1", { behavior: "allow" });
    expect(ok).toBe(false);
    expect(snapshot()).toHaveLength(1);
  });

  it("agent_permission_resolved 推送出队（其他端已回应）", () => {
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p2") });
    permissionStore.handleResolved({ agentId: "a1", requestId: "p1" });
    expect(snapshot().map((p) => p.request.id)).toEqual(["p2"]);
    // 未知 id 的解决推送不产生影响
    permissionStore.handleResolved({ agentId: "a1", requestId: "p404" });
    expect(snapshot()).toHaveLength(1);
  });

  it("clearAll：断线清空残留", () => {
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.clearAll();
    expect(snapshot()).toHaveLength(0);
  });

  it("订阅通知：入队/出队触发监听器", () => {
    let notified = 0;
    const unsubscribe = permissionStore.subscribe(() => {
      notified += 1;
    });
    permissionStore.handlePush({ agentId: "a1", request: makeRequest("p1") });
    permissionStore.clearAll();
    expect(notified).toBe(2);
    unsubscribe();
  });
});
