/**
 * 集成测试：经自托管 relay（v2）+ vendor E2EE 信道连接真实 daemon。
 *
 * relay Connection URI 等同密码，不入库。运行前通过环境变量提供：
 *
 *   PASEO_MP_TEST_RELAY_URI='relay://<host>:<port>/<serverId>?key=<urlencoded公钥>' \
 *     npx vitest run tests/integration-relay.test.ts
 *
 * 本地测试用的示例（t10 环境，勿用于生产）：
 *   relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D
 *   （即 PASEO_MP_TEST_RELAY_URI='relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D'）
 *
 * 验证端到端链路：relay v2 client 连接 → E2EE 握手（与官方 daemon 侧兼容）
 * → daemon hello → RPC。未设置环境变量时 skip。
 */
import { describe, expect, it } from "vitest";
import { DaemonConnection } from "../src/connection/daemon-connection";
import { buildRelayClientWebSocketUrl, parseRelayOffer } from "../src/connection/relay-offer";
import { createRelayPlaintextSocket } from "../src/connection/relay-transport";
import { installSystemRandomSource } from "../src/connection/random-source";
import { createNodeSocket } from "./helpers/node-socket";

installSystemRandomSource();

const relayUri = process.env.PASEO_MP_TEST_RELAY_URI?.trim() || "";

describe.skipIf(!relayUri)("集成：relay E2EE 链路连真实 daemon", () => {
  it("E2EE 握手 + hello + fetch_agents", async () => {
    const offer = parseRelayOffer(relayUri);
    const relayWsUrl = buildRelayClientWebSocketUrl({ offer });

    const conn = new DaemonConnection(
      () =>
        createRelayPlaintextSocket({
          connectUnderlying: () => createNodeSocket(relayWsUrl),
          offer,
          handshakeTimeoutMs: 20_000,
        }),
      {
        clientId: "mp-integration-relay",
        clientType: "mobile",
        helloTimeoutMs: 20_000,
      },
    );

    const info = await conn.connect();
    expect(info.serverId).toBe(offer.serverId);
    expect(typeof info.version).toBe("string");

    const agents = await conn.fetchAgents();
    expect(Array.isArray(agents)).toBe(true);

    conn.close();
  }, 45_000);
});
