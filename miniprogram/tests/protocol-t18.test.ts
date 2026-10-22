/**
 * t18 新增协议方法测试：定时任务 / attention 推送 / 归档标签 / 会话导入 /
 * 项目注册 / workspace 脚本。复用 t16 的内存 mock socket 套路。
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
  title: "t18",
  provider: "zcode",
  model: null,
  status: "idle",
  cwd: "/tmp/project",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  lastUserMessageAt: null,
  requiresAttention: false,
  labels: { "paseo.parent-agent-id": "agent-0", urgent: "true" },
};

const SCHEDULE = {
  id: "sch-1",
  name: "每日简报",
  prompt: "汇总今日提交",
  cadence: { type: "cron", expression: "0 9 * * *" },
  target: { type: "agent", agentId: "agent-1" },
  status: "active",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  nextRunAt: "2026-10-03T01:00:00Z",
  lastRunAt: null,
  pausedAt: null,
  expiresAt: null,
  maxRuns: null,
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
  const conn = new DaemonConnection(() => pair.clientPort, { clientId: "t18-client" }, events);
  const connectPromise = conn.connect();
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server };
}

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

describe("t18：定时任务 RPC", () => {
  it("schedule/list：请求与响应解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.listSchedules();
    const request = await captureRequest(server, "schedule/list");
    expect(request.type).toBe("schedule/list");
    server.pushSession({
      type: "schedule/list/response",
      payload: { requestId: request.requestId, schedules: [SCHEDULE], error: null },
    });
    const schedules = await promise;
    expect(schedules).toHaveLength(1);
    expect(schedules[0]).toMatchObject({
      id: "sch-1",
      name: "每日简报",
      status: "active",
      cadence: { type: "cron", expression: "0 9 * * *" },
      target: { type: "agent", agentId: "agent-1" },
    });
  });

  it("schedule/create：请求形状（cadence/target/maxRuns/runOnCreate）与解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.createSchedule({
      prompt: "只回复 ok",
      cadence: { type: "cron", expression: "* * * * *" },
      target: { type: "agent", agentId: "agent-1" },
      maxRuns: 1,
      runOnCreate: true,
    });
    const request = await captureRequest(server, "schedule/create");
    expect(request.prompt).toBe("只回复 ok");
    expect(request.cadence).toEqual({ type: "cron", expression: "* * * * *" });
    expect(request.target).toEqual({ type: "agent", agentId: "agent-1" });
    expect(request.maxRuns).toBe(1);
    expect(request.runOnCreate).toBe(true);
    server.pushSession({
      type: "schedule/create/response",
      payload: { requestId: request.requestId, schedule: SCHEDULE, error: null },
    });
    const created = await promise;
    expect(created.id).toBe("sch-1");
  });

  it("schedule/create：错误路径抛出服务端 error", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.createSchedule({
      prompt: "x",
      cadence: { type: "cron", expression: "0 9 * * *" },
      target: { type: "agent", agentId: "agent-1" },
    });
    const request = await captureRequest(server, "schedule/create");
    server.pushSession({
      type: "schedule/create/response",
      payload: { requestId: request.requestId, schedule: null, error: "agent not found" },
    });
    await expect(promise).rejects.toThrow("agent not found");
  });

  it("schedule/pause|run-once|logs|delete：操作族与执行记录解析", async () => {
    const { conn, server } = await connectedHarness();

    const pausePromise = conn.setSchedulePaused("sch-1", true);
    const pauseRequest = await captureRequest(server, "schedule/pause");
    expect(pauseRequest.scheduleId).toBe("sch-1");
    server.pushSession({
      type: "schedule/pause/response",
      payload: {
        requestId: pauseRequest.requestId,
        schedule: { ...SCHEDULE, status: "paused", pausedAt: "2026-10-02T00:00:00Z" },
        error: null,
      },
    });
    const paused = await pausePromise;
    expect(paused.status).toBe("paused");

    const runPromise = conn.runScheduleOnce("sch-1");
    const runRequest = await captureRequest(server, "schedule/run-once");
    server.pushSession({
      type: "schedule/run-once/response",
      payload: {
        requestId: runRequest.requestId,
        schedule: {
          ...SCHEDULE,
          runs: [
            {
              id: "run-1",
              scheduledFor: "2026-10-02T00:00:00Z",
              startedAt: "2026-10-02T00:00:01Z",
              endedAt: "2026-10-02T00:00:10Z",
              status: "succeeded",
              agentId: "agent-1",
              output: "ok",
              error: null,
            },
          ],
        },
        error: null,
      },
    });
    // run-once 返回的 schedule 带 runs（StoredSchedule 形状）
    const run = await runPromise;
    expect(run.id).toBe("sch-1");

    const logsPromise = conn.scheduleLogs("sch-1");
    const logsRequest = await captureRequest(server, "schedule/logs");
    server.pushSession({
      type: "schedule/logs/response",
      payload: {
        requestId: logsRequest.requestId,
        runs: [
          {
            id: "run-1",
            scheduledFor: "2026-10-02T00:00:00Z",
            startedAt: "2026-10-02T00:00:01Z",
            endedAt: "2026-10-02T00:00:10Z",
            status: "failed",
            agentId: "agent-1",
            output: null,
            error: "provider 未配置",
          },
        ],
        error: null,
      },
    });
    const runs = await logsPromise;
    expect(runs[0]).toMatchObject({ id: "run-1", status: "failed", error: "provider 未配置" });

    const deletePromise = conn.deleteSchedule("sch-1");
    const deleteRequest = await captureRequest(server, "schedule/delete");
    server.pushSession({
      type: "schedule/delete/response",
      payload: { requestId: deleteRequest.requestId, scheduleId: "sch-1", error: null },
    });
    await deletePromise;
  });
});

describe("t18：attention 推送与清除", () => {
  it("agent_attention_required 推送 → onAttention 事件（含通知载荷）", async () => {
    const attentionEvents: unknown[] = [];
    const { conn, server } = await connectedHarness({
      onAttention: (push) => attentionEvents.push(push),
    });
    server.pushSession({
      type: "agent_attention_required",
      payload: {
        agentId: "agent-1",
        reason: "finished",
        timestamp: "2026-10-02T00:00:00Z",
        shouldNotify: true,
        notification: {
          title: "Agent 完成",
          body: "t18 已完成",
          data: { serverId: "srv", agentId: "agent-1", reason: "finished" },
        },
      },
    });
    await waitUntil(() => attentionEvents.length > 0);
    expect(attentionEvents[0]).toMatchObject({
      agentId: "agent-1",
      reason: "finished",
      shouldNotify: true,
    });
    conn.close();
  });

  it("clear_agent_attention：请求形状（单 id 收窄为字符串）与响应", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.clearAgentAttention(["agent-1"]);
    const request = await captureRequest(server, "clear_agent_attention");
    expect(request.agentId).toBe("agent-1");
    server.pushSession({
      type: "clear_agent_attention_response",
      payload: { requestId: request.requestId, agentId: "agent-1", agents: [] },
    });
    await promise;
  });
});

describe("t18：归档 / 标签 / 恢复", () => {
  it("fetchAgents includeArchived：请求带 filter + subscribe（agent_update 订阅，id 复用）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchAgents({ includeArchived: true });
    const request = await captureRequest(server, "fetch_agents_request");
    expect(request.filter).toEqual({ includeArchived: true });
    expect(typeof request.subscribe).toBe("object");
    server.pushSession({
      type: "fetch_agents_response",
      payload: {
        requestId: request.requestId,
        subscriptionId: "sub-agents-1",
        entries: [{ agent: AGENT }],
      },
    });
    const agents = await promise;
    expect(agents[0]?.labels).toEqual({ "paseo.parent-agent-id": "agent-0", urgent: "true" });

    // 第二次 fetch 复用订阅 id
    const promise2 = conn.fetchAgents({ includeArchived: true });
    const request2 = await captureRequest(server, "fetch_agents_request");
    expect(request2.subscribe).toEqual({ subscriptionId: "sub-agents-1" });
    server.pushSession({
      type: "fetch_agents_response",
      payload: {
        requestId: request2.requestId,
        subscriptionId: "sub-agents-1",
        entries: [{ agent: AGENT }],
      },
    });
    await promise2;
  });

  it("archive_agent_request → agent_archived 推送（requestId 关联）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.archiveAgent("agent-1");
    const request = await captureRequest(server, "archive_agent_request");
    server.pushSession({
      type: "agent_archived",
      payload: {
        agentId: "agent-1",
        archivedAt: "2026-10-02T00:00:00Z",
        requestId: request.requestId,
      },
    });
    await promise;
  });

  it("update_agent_request（labels 全量）→ update_agent_response", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.updateAgent("agent-1", { labels: { urgent: "true" } });
    const request = await captureRequest(server, "update_agent_request");
    expect(request.labels).toEqual({ urgent: "true" });
    server.pushSession({
      type: "update_agent_response",
      payload: { requestId: request.requestId, agentId: "agent-1", accepted: true, error: null },
    });
    await promise;
  });

  it("refresh_agent_request（恢复归档）→ agent_refreshed status 推送", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.refreshAgent("agent-1");
    const request = await captureRequest(server, "refresh_agent_request");
    server.pushSession({
      type: "status",
      payload: { status: "agent_refreshed", agentId: "agent-1", requestId: request.requestId, timelineSize: 3 },
    });
    await promise;
  });
});

describe("t18：会话导入", () => {
  it("fetch_recent_provider_sessions：cwd/limit 请求与目录解析（含 providerErrors）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchRecentProviderSessions({ cwd: "/tmp/project", limit: 50 });
    const request = await captureRequest(server, "fetch_recent_provider_sessions_request");
    expect(request.cwd).toBe("/tmp/project");
    expect(request.limit).toBe(50);
    server.pushSession({
      type: "fetch_recent_provider_sessions_response",
      payload: {
        requestId: request.requestId,
        entries: [
          {
            providerId: "zcode",
            providerLabel: "ZCode",
            providerHandleId: "sess-abc",
            cwd: "/tmp/project",
            title: "修 bug",
            firstPromptPreview: "帮我修",
            lastPromptPreview: "继续",
            lastActivityAt: "2026-10-02T00:00:00Z",
          },
        ],
        filteredAlreadyImportedCount: 2,
        providerErrors: [{ provider: "kimi", message: "not installed" }],
      },
    });
    const result = await promise;
    expect(result.entries[0]).toMatchObject({
      providerId: "zcode",
      providerHandleId: "sess-abc",
      title: "修 bug",
    });
    expect(result.providerErrors).toEqual([{ provider: "kimi", message: "not installed" }]);
  });

  it("import_agent_request → agent_resumed status 推送（requestId 关联）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.importAgent({
      provider: "zcode",
      providerHandleId: "sess-abc",
      cwd: "/tmp/project",
    });
    const request = await captureRequest(server, "import_agent_request");
    expect(request).toMatchObject({
      provider: "zcode",
      providerHandleId: "sess-abc",
      cwd: "/tmp/project",
    });
    server.pushSession({
      type: "status",
      payload: {
        status: "agent_resumed",
        agentId: AGENT.id,
        requestId: request.requestId,
        timelineSize: 5,
        agent: AGENT,
      },
    });
    const agent = await promise;
    expect(agent.id).toBe("agent-1");
  });
});

describe("t18：项目注册 / GitHub clone", () => {
  it("open_project_request：cwd 与 workspace 解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.openProject("/Users/dev/other");
    const request = await captureRequest(server, "open_project_request");
    expect(request.cwd).toBe("/Users/dev/other");
    server.pushSession({
      type: "open_project_response",
      payload: {
        requestId: request.requestId,
        workspace: {
          id: "ws-2",
          projectId: "proj-2",
          projectDisplayName: "other",
          projectRootPath: "/Users/dev/other",
          workspaceDirectory: "/Users/dev/other",
          name: "main",
          title: null,
          status: "done",
          activityAt: null,
        },
        error: null,
      },
    });
    const workspace = await promise;
    expect(workspace.id).toBe("ws-2");
  });

  it("project.github.clone.request：repo/protocol/target 与 checkoutPath 解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.cloneGithubProject({
      repo: "owner/repo",
      targetDirectory: "/Users/dev/projects",
      cloneProtocol: "https",
    });
    const request = await captureRequest(server, "project.github.clone.request");
    expect(request).toMatchObject({
      repo: "owner/repo",
      targetDirectory: "/Users/dev/projects",
      cloneProtocol: "https",
    });
    server.pushSession({
      type: "project.github.clone.response",
      payload: {
        requestId: request.requestId,
        repo: "owner/repo",
        checkoutPath: "/Users/dev/projects/repo",
        project: null,
        error: null,
      },
    });
    const result = await promise;
    expect(result.checkoutPath).toBe("/Users/dev/projects/repo");
  });
});

describe("t18：workspace 脚本", () => {
  it("workspace.script.list / start：请求与状态解析", async () => {
    const { conn, server } = await connectedHarness();
    const listPromise = conn.listWorkspaceScripts("ws-1");
    const listRequest = await captureRequest(server, "workspace.script.list.request");
    expect(listRequest.workspaceId).toBe("ws-1");
    server.pushSession({
      type: "workspace.script.list.response",
      payload: {
        requestId: listRequest.requestId,
        workspaceId: "ws-1",
        scripts: [
          {
            scriptName: "dev",
            type: "service",
            hostname: "localhost",
            port: 3000,
            lifecycle: "stopped",
            health: null,
          },
        ],
        error: null,
      },
    });
    const scripts = await listPromise;
    expect(scripts[0]).toMatchObject({ scriptName: "dev", lifecycle: "stopped", port: 3000 });

    const startPromise = conn.workspaceScriptAction("start", "ws-1", "dev");
    const startRequest = await captureRequest(server, "workspace.script.start.request");
    expect(startRequest).toMatchObject({ workspaceId: "ws-1", scriptName: "dev" });
    server.pushSession({
      type: "workspace.script.start.response",
      payload: {
        requestId: startRequest.requestId,
        workspaceId: "ws-1",
        scriptName: "dev",
        script: {
          scriptName: "dev",
          type: "service",
          hostname: "localhost",
          port: 3000,
          lifecycle: "running",
          health: "healthy",
          publicProxyUrl: "https://dev-ws-1.example.com",
        },
        error: null,
      },
    });
    const started = await startPromise;
    expect(started).toMatchObject({ scriptName: "dev", lifecycle: "running", health: "healthy" });
  });
});
