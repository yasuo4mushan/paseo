/**
 * DaemonConnection 单元测试：内存 socket 上验证 hello 握手、requestId 关联、
 * 流事件分发、错误路径与发送消息请求形状。
 */
import { describe, expect, it } from "vitest";
import { DaemonConnection, type DaemonConnectionEvents } from "../src/connection/daemon-connection";
import { createMockSocketPair, type MockDaemonSide } from "./helpers/mock-socket";

const SERVER_INFO_MESSAGE = {
  type: "status",
  payload: { status: "server_info", serverId: "srv_test", version: "0.12.0-test" },
};

const AGENT = {
  id: "4036a83e-8265-4640-bfc5-82a72490a19c",
  title: "hello",
  provider: "claude",
  model: "sonnet",
  status: "idle",
  cwd: "/tmp/project",
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  lastUserMessageAt: null,
};

interface TestCtx {
  conn: DaemonConnection;
  server: MockDaemonSide;
  states: string[];
}

/** 建立连接并完成握手（hello 已发送、server_info 已回）。 */
async function connectedHarness(
  options?: Partial<ConstructorParameters<typeof DaemonConnection>[1]>,
  events?: DaemonConnectionEvents,
): Promise<TestCtx> {
  const pair = createMockSocketPair();
  const states: string[] = [];
  const conn = new DaemonConnection(
    () => pair.clientPort,
    { clientId: "test-client", ...options },
    { onStateChange: (state) => states.push(state), ...events },
  );
  const connectPromise = conn.connect();
  // 模拟 daemon：socket 立即 open；客户端随后发出 hello
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server, states };
}

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

function lastHelloFrame(server: MockDaemonSide): Record<string, unknown> {
  for (let i = server.sentFrames.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(server.sentFrames[i]) as Record<string, unknown>;
    if (parsed.type === "hello") return parsed;
  }
  throw new Error("no hello frame sent");
}

describe("DaemonConnection", () => {
  it("hello 握手：发送 hello 帧并解析 server_info", async () => {
    const { conn, server } = await connectedHarness();
    const hello = lastHelloFrame(server);
    expect(hello.type).toBe("hello");
    expect(hello.clientType).toBe("mobile");
    expect(hello.protocolVersion).toBe(1);
    expect(hello.clientId).toBe("test-client");
    expect(conn.getState()).toBe("connected");
    expect(conn.getServerInfo()).toMatchObject({ serverId: "srv_test", version: "0.12.0-test" });
  });

  it("hello 携带 password auth 时形状正确", async () => {
    const { server } = await connectedHarness({ password: "secret" });
    const hello = lastHelloFrame(server);
    expect(hello.auth).toEqual({ kind: "password", password: "secret" });
  });

  it("fetchAgents：请求形状正确并解析响应", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchAgents();
    const request = server.lastRequest();
    expect(request?.type).toBe("fetch_agents_request");
    expect(typeof request?.requestId).toBe("string");
    server.pushSession({
      type: "fetch_agents_response",
      payload: {
        requestId: request?.requestId,
        entries: [{ agent: AGENT }],
        pageInfo: { hasMore: false },
      },
    });
    const agents = await promise;
    expect(agents).toHaveLength(1);
    expect(agents[0]).toMatchObject({ id: AGENT.id, status: "idle", title: "hello" });
  });

  it("未知状态/多余字段宽容解析（协议向前兼容）", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchAgents();
    const request = server.lastRequest();
    server.pushSession({
      type: "fetch_agents_response",
      payload: {
        requestId: request?.requestId,
        entries: [{ agent: { ...AGENT, status: "some-new-status", extraField: 1 } }],
      },
    });
    const agents = await promise;
    expect(agents[0]?.status).toBe("initializing");
  });

  it("fetchAgentTimeline：direction=tail 请求与条目解析", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchAgentTimeline(AGENT.id, 20);
    const request = server.lastRequest();
    expect(request?.type).toBe("fetch_agent_timeline_request");
    expect(request?.agentId).toBe(AGENT.id);
    expect(request?.direction).toBe("tail");
    expect(request?.limit).toBe(20);
    server.pushSession({
      type: "fetch_agent_timeline_response",
      payload: {
        requestId: request?.requestId,
        agentId: AGENT.id,
        direction: "tail",
        projection: "projected",
        epoch: "e1",
        reset: false,
        staleCursor: false,
        gap: false,
        window: { minSeq: 0, maxSeq: 10, nextSeq: 11 },
        startCursor: null,
        endCursor: { epoch: "e1", seq: 10 },
        hasOlder: true,
        hasNewer: false,
        entries: [
          {
            provider: "claude",
            item: { type: "user_message", text: "你好" },
            timestamp: "2026-10-20T00:00:00Z",
            seqStart: 9,
            seqEnd: 9,
            sourceSeqRanges: [{ startSeq: 9, endSeq: 9 }],
            collapsed: [],
          },
          {
            provider: "claude",
            item: { type: "tool_call", tool: "Read", status: "completed", error: null },
            timestamp: "2026-10-20T00:00:01Z",
            seqStart: 10,
            seqEnd: 10,
            sourceSeqRanges: [{ startSeq: 10, endSeq: 10 }],
            collapsed: [],
          },
        ],
        error: null,
      },
    });
    const entries = await promise;
    expect(entries).toHaveLength(2);
    expect(entries[0]?.item).toMatchObject({ type: "user_message", text: "你好" });
    expect(entries[1]?.item).toMatchObject({
      type: "tool_call",
      tool: "Read",
      status: "completed",
    });
  });

  it("subscribeAgentTimelines：返回 subscriptionId", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.subscribeAgentTimelines([AGENT.id]);
    const request = server.lastRequest();
    expect(request?.type).toBe("agent.timeline.set_subscription.request");
    expect(request?.agentIds).toEqual([AGENT.id]);
    server.pushSession({
      type: "agent.timeline.set_subscription.response",
      payload: { requestId: request?.requestId, subscriptionId: "sub-1", agentIds: [AGENT.id] },
    });
    await expect(promise).resolves.toEqual({ subscriptionId: "sub-1" });
  });

  it("agent_stream 推送经 onStreamEvent 回调", async () => {
    const seen: Array<{ agentId: string; type: string }> = [];
    const { server } = await connectedHarness(
      { clientId: "c2" },
      {
        onStreamEvent: (payload) =>
          seen.push({ agentId: payload.agentId, type: payload.event.type }),
      },
    );
    server.pushSession({
      type: "agent_stream",
      payload: {
        agentId: AGENT.id,
        event: {
          type: "timeline",
          provider: "claude",
          item: { type: "assistant_message", text: "回复" },
          turnId: "t1",
        },
        timestamp: "2026-10-20T00:00:00Z",
        seq: 42,
      },
    });
    server.pushSession({
      type: "agent_stream",
      payload: {
        agentId: AGENT.id,
        event: { type: "turn_started", provider: "claude" },
        timestamp: "2026-10-20T00:00:01Z",
      },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(seen).toEqual([
      { agentId: AGENT.id, type: "timeline" },
      { agentId: AGENT.id, type: "turn_started" },
    ]);
  });

  it("sendAgentMessage：请求带空 attachments 并解析 accepted", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.sendAgentMessage(AGENT.id, "帮我看看");
    const request = server.lastRequest();
    expect(request?.type).toBe("send_agent_message_request");
    expect(request?.agentId).toBe(AGENT.id);
    expect(request?.text).toBe("帮我看看");
    expect(request?.attachments).toEqual([]);
    server.pushSession({
      type: "send_agent_message_response",
      payload: { requestId: request?.requestId, agentId: AGENT.id, accepted: true, error: null },
    });
    await expect(promise).resolves.toEqual({ accepted: true, error: null });
  });

  it("RPC 超时拒绝（无响应时）", async () => {
    const { conn } = await connectedHarness({ requestTimeoutMs: 60 });
    await expect(conn.fetchAgents()).rejects.toThrow(/RPC 超时/);
  });

  it("连接关闭时挂起请求被拒绝", async () => {
    const { conn, server } = await connectedHarness();
    const promise = conn.fetchAgents();
    server.emitClose(1006, "abnormal");
    await expect(promise).rejects.toThrow(/连接已关闭/);
    expect(conn.getState()).toBe("closed");
  });

  it("未连接时 request 直接拒绝", async () => {
    const pair = createMockSocketPair();
    const conn = new DaemonConnection(() => pair.clientPort, { clientId: "c" });
    await expect(conn.fetchAgents()).rejects.toThrow(/未连接/);
  });

  it("hello 超时：等待 server_info 超时后 connect 失败", async () => {
    const pair = createMockSocketPair();
    const conn = new DaemonConnection(() => pair.clientPort, {
      clientId: "c",
      helloTimeoutMs: 50,
    });
    const promise = conn.connect();
    pair.server.emitOpen();
    await expect(promise).rejects.toThrow(/超时|关闭/);
  });
});
