/**
 * 互通测试：小程序 vendor 的 E2EE 客户端信道 vs 官方 @aaswitch/relay 实现。
 *
 * 场景 1（最重要）：vendor createClientChannel（小程序侧） ↔ 官方
 *   createDaemonChannel（daemon 侧）在内存管道上完成 e2ee_hello/e2ee_ready
 *   握手并互发消息 —— 证明握手协议、密钥派生、加解密与官方字节级兼容。
 * 场景 2：官方 createClientChannel ↔ 官方 createDaemonChannel 作为对照组，
 *   排除测试装置本身的问题。
 */
import { describe, expect, it } from "vitest";
import { createClientChannel } from "../src/connection/encrypted-channel";
import { installSystemRandomSource } from "../src/connection/random-source";
import {
  loadOfficialRelay,
  type OfficialChannel,
  type OfficialTransport,
} from "./helpers/official-relay";

installSystemRandomSource();

const official = loadOfficialRelay();

/** it.skipIf(official === null) 只是跳过；类型层面用守卫收窄。 */
function requireOfficial() {
  if (!official) throw new Error("official @aaswitch/relay not found");
  return official;
}

/** 双向内存管道：a.send → b.onmessage；b.send → a.onmessage。 */
function createPipe(): { a: OfficialTransport; b: OfficialTransport } {
  const a: OfficialTransport = {
    send: () => {},
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  const b: OfficialTransport = {
    send: () => {},
    close: () => {},
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  a.send = (data) => {
    queueMicrotask(() => b.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }));
  };
  b.send = (data) => {
    queueMicrotask(() => a.onmessage?.({ data, isBinary: data instanceof ArrayBuffer }));
  };
  return { a, b };
}

function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitFor timeout"));
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });
}

async function pumpUntil(predicate: () => boolean): Promise<void> {
  await waitFor(predicate);
  // 让 queueMicrotask 队列排空
  await new Promise((resolve) => setTimeout(resolve, 30));
}

describe("E2EE 互通（vendor 客户端信道 ↔ 官方 daemon 信道）", () => {
  it.skipIf(official === null)("握手 + 双向加解密消息", async () => {
    const official = requireOfficial();
    const { a, b } = createPipe();

    const daemonKeyPair = official.generateKeyPair();
    const daemonPublicB64 = official.exportPublicKey(daemonKeyPair.publicKey);

    const daemonReceived: Array<string | ArrayBuffer> = [];
    const clientReceived: Array<string | ArrayBuffer> = [];

    // 注意：daemon 侧 promise 要等 e2ee_hello 才 resolve，客户端信道要并发建立
    // （先 await daemon 侧会死锁——真实 socket 上两侧本来并发）。
    const daemonReady = official.createDaemonChannel(b, daemonKeyPair, {
      onopen: () => {},
      onmessage: (data) => daemonReceived.push(data),
      onclose: () => {},
      onerror: (err) => {
        throw err;
      },
    });

    const mpClient = await createClientChannel(a, daemonPublicB64, {
      onopen: () => {},
      onmessage: (data) => clientReceived.push(data),
      onclose: () => {},
      onerror: () => {},
    });

    const officialDaemon: OfficialChannel = await daemonReady;

    await pumpUntil(() => mpClient.isOpen() && officialDaemon.isOpen());
    expect(mpClient.isOpen()).toBe(true);
    expect(officialDaemon.isOpen()).toBe(true);

    // 小程序 -> daemon（中文 JSON 消息，模拟 daemon 协议帧）
    const outbound = JSON.stringify({
      type: "session",
      message: { type: "send_agent_message_request", requestId: "r1", text: "你好 daemon" },
    });
    mpClient.send(outbound);
    await pumpUntil(() => daemonReceived.length > 0);
    expect(daemonReceived[0]).toBe(outbound);

    // daemon -> 小程序
    const inbound = JSON.stringify({
      type: "session",
      message: {
        type: "agent_stream",
        payload: { agentId: "a1", event: { type: "turn_started", provider: "claude" } },
      },
    });
    await officialDaemon.send(inbound);
    await pumpUntil(() => clientReceived.length > 0);
    expect(clientReceived[0]).toBe(inbound);

    // 多帧往返保持顺序与完整性
    mpClient.send("second");
    mpClient.send("third");
    await officialDaemon.send("fourth");
    await pumpUntil(() => daemonReceived.length >= 3 && clientReceived.length >= 2);
    expect(daemonReceived[1]).toBe("second");
    expect(daemonReceived[2]).toBe("third");
    expect(clientReceived[1]).toBe("fourth");

    mpClient.close();
  });

  it.skipIf(official === null)("官方 client ↔ 官方 daemon（对照组，验证测试装置）", async () => {
    const official = requireOfficial();
    const { a, b } = createPipe();
    const daemonKeyPair = official.generateKeyPair();
    const daemonPublicB64 = official.exportPublicKey(daemonKeyPair.publicKey);

    const daemonReceived: Array<string | ArrayBuffer> = [];
    const clientReceived: Array<string | ArrayBuffer> = [];

    const daemonReady = official.createDaemonChannel(b, daemonKeyPair, {
      onmessage: (data) => daemonReceived.push(data),
      onclose: () => {},
      onerror: () => {},
    });
    const client = await official.createClientChannel(a, daemonPublicB64, {
      onmessage: (data) => clientReceived.push(data),
      onclose: () => {},
      onerror: () => {},
    });
    const daemon = await daemonReady;

    await pumpUntil(() => client.isOpen() && daemon.isOpen());
    client.send("ping");
    await pumpUntil(() => daemonReceived.length > 0);
    await daemon.send("pong");
    await pumpUntil(() => clientReceived.length > 0);
    expect(daemonReceived[0]).toBe("ping");
    expect(clientReceived[0]).toBe("pong");
    client.close();
  });

  it.skipIf(official === null)(
    "低位点公钥被拒绝（与官方 deriveSharedKey 的 all-zero 防御一致）",
    async () => {
      // 全零公钥使 X25519 共享密钥全零：vendor 与官方实现都在派生阶段同步拒绝
      const official = requireOfficial();
      const lowOrderPublicB64 = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
      const { a, b } = createPipe();
      await expect(createClientChannel(a, lowOrderPublicB64, {})).rejects.toThrow(
        /Invalid peer public key/,
      );
      // 官方实现同样拒绝
      await expect(official.createClientChannel(b, lowOrderPublicB64, {})).rejects.toThrow();
    },
  );
});
