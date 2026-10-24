/**
 * 集成测试：直连本机真实 daemon（ws://127.0.0.1:6799，develop-xdb 构建，无密码）。
 *
 * 验证：hello 握手 + server_info、fetch_agents、fetch_agent_timeline、
 * agent.timeline.set_subscription ack。断言消息形状（协议字段与
 * packages/protocol/src/messages.ts 对齐）。
 *
 * 不会向真实 agent 发送消息（避免消耗配额）；发送路径由单元测试覆盖。
 * daemon 不在线时整文件 skip。
 */
import { describe, expect, it } from "vitest";
import net from "node:net";
import { DaemonConnection } from "../src/connection/daemon-connection";
import { installSystemRandomSource } from "../src/connection/random-source";
import { createNodeSocket } from "./helpers/node-socket";

installSystemRandomSource();

const DAEMON_URL = process.env.PASEO_MP_TEST_DAEMON_URL ?? "ws://127.0.0.1:6799/ws";

function isDaemonReachable(url: URL, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port), timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

const daemonUrl = new URL(DAEMON_URL);
const reachable = await isDaemonReachable(daemonUrl);

describe.skipIf(!reachable)("集成：直连真实 daemon", () => {
  it("hello 握手 → server_info", async () => {
    const conn = new DaemonConnection(() => createNodeSocket(DAEMON_URL), {
      clientId: "mp-integration-direct",
      clientType: "mobile",
    });
    const info = await conn.connect();
    expect(info.serverId).toMatch(/^srv_/);
    expect(typeof info.version).toBe("string");
    expect(conn.getState()).toBe("connected");
    conn.close();
  });

  it("fetch_agents → 至少能拿到列表（可能为空）", async () => {
    const conn = new DaemonConnection(() => createNodeSocket(DAEMON_URL), {
      clientId: "mp-integration-direct",
    });
    await conn.connect();
    const agents = await conn.fetchAgents();
    expect(Array.isArray(agents)).toBe(true);
    for (const agent of agents) {
      expect(agent.id).toBeTruthy();
      expect(agent.provider).toBeTruthy();
      expect(["initializing", "idle", "running", "error", "closed"]).toContain(agent.status);
    }
    conn.close();
  });

  it("时间线 tail + 流订阅 ack（有 agent 时）", async () => {
    const conn = new DaemonConnection(() => createNodeSocket(DAEMON_URL), {
      clientId: "mp-integration-direct",
    });
    await conn.connect();
    const agents = await conn.fetchAgents();
    const first = agents[0];
    if (!first) {
      conn.close();
      return;
    }

    const timeline = await conn.fetchAgentTimeline(first.id, 20);
    expect(Array.isArray(timeline)).toBe(true);
    for (const entry of timeline) {
      expect(typeof entry.seqStart).toBe("number");
      expect(entry.timestamp).toBeTruthy();
    }

    const { subscriptionId } = await conn.subscribeAgentTimelines([first.id]);
    expect(typeof subscriptionId).toBe("string");
    expect(subscriptionId!.length).toBeGreaterThan(0);
    conn.close();
  });

  // t31-d：provider 目录回归——codex 在真实 daemon 上有模型目录与 thinking 档位，
  // 且解析器不把 error 静默折叠成空列表（「模型/thinking 为空」缺陷的线上路径）。
  it("listProviderModels：codex 目录非空且含 thinking 档位", { timeout: 90_000 }, async () => {
    const conn = new DaemonConnection(() => createNodeSocket(DAEMON_URL), {
      clientId: "mp-integration-direct",
    });
    await conn.connect();
    const providers = await conn.listAvailableProviders();
    const codex = providers.find((p) => p.provider === "codex");
    if (!codex?.available) {
      // 本机 daemon 未装 codex 时不做断言（目录探测本身仍应不抛错）
      const result = await conn.listProviderModels("codex");
      expect(result.error).toBeTruthy();
      conn.close();
      return;
    }
    const result = await conn.listProviderModels("codex");
    expect(result.error).toBeNull();
    expect(result.models.length).toBeGreaterThan(0);
    const withThinking = result.models.find((m) => (m.thinkingOptions ?? []).length > 0);
    expect(withThinking).toBeTruthy();
    conn.close();
  });
});
