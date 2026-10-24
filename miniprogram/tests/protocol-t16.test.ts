/**
 * t16 新增协议方法测试：工作区/provider 目录/创建/中断/删除/权限推送，
 * 全部走内存 mock socket（复用 daemon-connection.test.ts 的套路）。
 */
import { describe, expect, it } from "vitest";
import { DaemonConnection, type DaemonConnectionEvents } from "../src/connection/daemon-connection";
import { createMockSocketPair, type MockDaemonSide } from "./helpers/mock-socket";

const SERVER_INFO_MESSAGE = {
  type: "status",
  payload: { status: "server_info", serverId: "srv_test", version: "0.12.0-test" },
};

const AGENT = {
  id: "agent-1",
  title: "t16",
  provider: "zcode",
  model: "glm-5",
  status: "idle",
  cwd: "/tmp/project",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  lastUserMessageAt: null,
};

const WORKSPACE_ENTRY = {
  id: "ws-1",
  projectId: "proj-1",
  projectDisplayName: "paseo",
  projectRootPath: "/Users/dev/paseo",
  workspaceDirectory: "/Users/dev/paseo",
  name: "main",
  title: null,
  status: "running",
  activityAt: "2026-10-02T00:00:00Z",
};

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitUntil timeout"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function connectedHarness(events?: DaemonConnectionEvents): Promise<{
  conn: DaemonConnection;
  server: MockDaemonSide;
}> {
  const pair = createMockSocketPair();
  const conn = new DaemonConnection(() => pair.clientPort, { clientId: "t16-client" }, events);
  const connectPromise = conn.connect();
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server };
}

/** 等待客户端发出指定类型的 session 请求并返回之（请求在方法调用时同步发出）。 */
async function captureRequest(
  server: MockDaemonSide,
  type: string,
): Promise<{ type: string; requestId: string } & Record<string, unknown>> {
  await waitUntil(() => server.sentFrames.some((frame) => frame.includes(`"${type}"`)));
  for (let i = server.sentFrames.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(server.sentFrames[i]) as {
      type?: string;
      message?: Record<string, unknown>;
    };
    if (parsed.type === "session" && parsed.message?.type === type) {
      return parsed.message as { type: string; requestId: string } & Record<string, unknown>;
    }
  }
  throw new Error(`request not found: ${type}`);
}

describe("t16 protocol methods", () => {
  it("fetchWorkspaces：请求形状与响应解析（含 emptyProjects）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchWorkspaces();
    const request = await captureRequest(server, "fetch_workspaces_request");
    expect(typeof request.requestId).toBe("string");
    // captureRequest 是事后回看，这里手动回放响应
    server.pushSession({
      type: "fetch_workspaces_response",
      payload: {
        requestId: request.requestId,
        entries: [WORKSPACE_ENTRY],
        emptyProjects: [
          {
            projectId: "proj-2",
            projectDisplayName: "other",
            projectRootPath: "/x",
          },
        ],
        pageInfo: { nextCursor: null, prevCursor: null, hasMore: false },
      },
    });
    const result = await promise;
    expect(result.workspaces).toHaveLength(1);
    expect(result.workspaces[0]).toMatchObject({
      id: "ws-1",
      projectDisplayName: "paseo",
      workspaceDirectory: "/Users/dev/paseo",
      status: "running",
    });
    expect(result.emptyProjects[0]?.projectId).toBe("proj-2");
    expect(result.hasMore).toBe(false);
  });

  it("listAvailableProviders：解析可用目录", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.listAvailableProviders();
    const request = await captureRequest(server, "list_available_providers_request");
    server.pushSession({
      type: "list_available_providers_response",
      payload: {
        requestId: request.requestId,
        providers: [
          { provider: "zcode", available: true },
          { provider: "kimi", available: false, error: "not installed" },
        ],
        fetchedAt: "2026-10-01T00:00:00Z",
      },
    });
    const providers = await promise;
    expect(providers).toEqual([
      { provider: "zcode", available: true, error: null },
      { provider: "kimi", available: false, error: "not installed" },
    ]);
  });

  it("listProviderModels/Modes：请求带 provider 与 cwd，响应解析", async () => {
    const { conn, server } = await connectedHarness();
    const modelsPromise = conn.listProviderModels("zcode", "/tmp/project");
    const modelsRequest = await captureRequest(server, "list_provider_models_request");
    expect(modelsRequest.provider).toBe("zcode");
    expect(modelsRequest.cwd).toBe("/tmp/project");
    server.pushSession({
      type: "list_provider_models_response",
      payload: {
        requestId: modelsRequest.requestId,
        provider: "zcode",
        models: [
          {
            id: "glm-5",
            label: "GLM-5",
            isDefault: true,
            thinkingOptions: [{ id: "high", label: "高" }],
            defaultThinkingOptionId: "high",
          },
          { id: "glm-5-air", label: "GLM-5 Air" },
        ],
        error: null,
        fetchedAt: "2026-10-01T00:00:00Z",
      },
    });
    const result = await modelsPromise;
    // t31-d：返回 {models, error}——模型与 thinking 档位都要能解出
    expect(result.error).toBeNull();
    expect(result.models).toHaveLength(2);
    expect(result.models[0]).toMatchObject({ id: "glm-5", isDefault: true });
    expect(result.models[0]?.thinkingOptions?.map((o) => o.id)).toEqual(["high"]);

    const modesPromise = conn.listProviderModes("zcode");
    const modesRequest = await captureRequest(server, "list_provider_modes_request");
    expect(modesRequest.provider).toBe("zcode");
    expect(modesRequest.cwd).toBeUndefined();
    server.pushSession({
      type: "list_provider_modes_response",
      payload: {
        requestId: modesRequest.requestId,
        provider: "zcode",
        modes: [
          { id: "code", label: "编码" },
          { id: "ask", label: "问答" },
        ],
        fetchedAt: "2026-10-01T00:00:00Z",
      },
    });
    const modes = await modesPromise;
    expect(modes.map((m) => m.id)).toEqual(["code", "ask"]);
  });

  it("listProviderModels：daemon error payload 透出为 error，不再静默空列表（t31-d 根因）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.listProviderModels("kimi", "/tmp/project");
    const request = await captureRequest(server, "list_provider_models_request");
    // daemon 失败形状：{provider, error}——没有 models 字段
    server.pushSession({
      type: "list_provider_models_response",
      payload: {
        requestId: request.requestId,
        provider: "kimi",
        error: "Authentication required",
        fetchedAt: "2026-10-01T00:00:00Z",
      },
    });
    const result = await promise;
    expect(result.models).toEqual([]);
    expect(result.error).toBe("Authentication required");
  });

  it("listProviderModels：rpc_error（如旧 daemon 不识别请求）透出为 error", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.listProviderModels("codex");
    const request = await captureRequest(server, "list_provider_models_request");
    server.pushSession({
      type: "rpc_error",
      payload: {
        requestId: request.requestId,
        requestType: "list_provider_models_request",
        error: "Unknown request, try upgrading the daemon (currently v0.12.0)",
        code: "unknown_schema",
      },
    });
    const result = await promise;
    expect(result.models).toEqual([]);
    expect(result.error).toContain("Unknown request");
  });

  it("createAgent：请求形状正确，agent_created status 推送解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.createAgent({
      provider: "zcode",
      cwd: "/tmp/project",
      model: "glm-5",
      modeId: "code",
      workspaceId: "ws-1",
      initialPrompt: "只回复 ok",
    });
    const request = await captureRequest(server, "create_agent_request");
    expect(request.config).toEqual({
      provider: "zcode",
      cwd: "/tmp/project",
      model: "glm-5",
      modeId: "code",
    });
    expect(request.workspaceId).toBe("ws-1");
    expect(request.initialPrompt).toBe("只回复 ok");
    server.pushSession({
      type: "status",
      payload: {
        status: "agent_created",
        agentId: AGENT.id,
        requestId: request.requestId,
        agent: AGENT,
      },
    });
    const agent = await promise;
    expect(agent).toMatchObject({ id: AGENT.id, provider: "zcode" });
  });

  it("createAgent：agent_create_failed 推送转成异常", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.createAgent({ provider: "zcode", cwd: "/tmp" });
    const request = await captureRequest(server, "create_agent_request");
    server.pushSession({
      type: "status",
      payload: {
        status: "agent_create_failed",
        requestId: request.requestId,
        error: "provider 不可用",
      },
    });
    await expect(promise).rejects.toThrow("provider 不可用");
  });

  it("cancelAgent：请求形状 + error 透传", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.cancelAgent("agent-1");
    const request = await captureRequest(server, "cancel_agent_request");
    expect(request.agentId).toBe("agent-1");
    server.pushSession({
      type: "cancel_agent_response",
      payload: { requestId: request.requestId, agentId: "agent-1", agent: null, error: null },
    });
    await expect(promise).resolves.toBeUndefined();

    const failPromise = conn.cancelAgent("agent-1");
    const failRequest = await captureRequest(server, "cancel_agent_request");
    server.pushSession({
      type: "cancel_agent_response",
      payload: { requestId: failRequest.requestId, agentId: "agent-1", error: "not running" },
    });
    await expect(failPromise).rejects.toThrow("not running");
  });

  it("deleteAgent：agent_deleted 推送完成 pending", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.deleteAgent("agent-1");
    const request = await captureRequest(server, "delete_agent_request");
    expect(request.agentId).toBe("agent-1");
    server.pushSession({
      type: "agent_deleted",
      payload: { agentId: "agent-1", requestId: request.requestId },
    });
    await expect(promise).resolves.toBeUndefined();
  });

  it("权限推送：agent_permission_request 路由到 onPermissionRequest，缺省 actions 补两档", async () => {
    const pushes: unknown[] = [];
    const { server } = await connectedHarness({
      onPermissionRequest: (push) => pushes.push(push),
    });
    server.pushSession({
      type: "agent_permission_request",
      payload: {
        agentId: "agent-1",
        request: {
          id: "perm-1",
          provider: "claude",
          name: "Bash",
          kind: "tool",
          input: { command: "rm -rf /tmp/x" },
        },
      },
    });
    await waitUntil(() => pushes.length === 1);
    const push = pushes[0] as { agentId: string; request: { actions: unknown[] } };
    expect(push.agentId).toBe("agent-1");
    // 协议未带 actions → 客户端补默认 拒绝/允许
    expect(push.request.actions).toHaveLength(2);
  });

  it("respondToPermission：发送 agent_permission_response（requestId=权限id，fire-and-forget）", async () => {
    const { conn, server } = await connectedHarness();
    conn.respondToPermission("agent-1", "perm-1", {
      behavior: "allow",
      selectedActionId: "accept",
    });
    await waitUntil(() =>
      server.sentFrames.some((frame) => frame.includes("agent_permission_response")),
    );
    const frame = server.sentFrames
      .map((f) => JSON.parse(f) as { type?: string; message?: Record<string, unknown> })
      .find((f) => f.type === "session" && f.message?.type === "agent_permission_response");
    expect(frame?.message).toEqual({
      type: "agent_permission_response",
      agentId: "agent-1",
      requestId: "perm-1",
      response: { behavior: "allow", selectedActionId: "accept" },
    });
  });

  it("权限解决推送路由到 onPermissionResolved", async () => {
    const resolved: unknown[] = [];
    const { server } = await connectedHarness({
      onPermissionResolved: (push) => resolved.push(push),
    });
    server.pushSession({
      type: "agent_permission_resolved",
      payload: { agentId: "agent-1", requestId: "perm-1", resolution: { behavior: "allow" } },
    });
    await waitUntil(() => resolved.length === 1);
    expect(resolved[0]).toEqual({ agentId: "agent-1", requestId: "perm-1" });
  });
});
