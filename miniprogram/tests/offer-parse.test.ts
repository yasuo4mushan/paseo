import { describe, expect, it } from "vitest";
import {
  buildRelayClientWebSocketUrl,
  parseConnectionInput,
  parseRelayOffer,
} from "../src/connection/relay-offer";

// 合成的 32 字节 base64 公钥（非真实密钥）：只测解析形状；
// 实际连接用的 URI 通过环境变量传入集成测试（见 integration-relay.test.ts 注释）。
const SAMPLE_KEY_RAW = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";
const SAMPLE_KEY_ENCODED = encodeURIComponent(SAMPLE_KEY_RAW);
const SAMPLE_URI = `relay://relay.example.test:80/srv_example?key=${SAMPLE_KEY_ENCODED}`;

describe("parseRelayOffer", () => {
  it("解析示例 URI 的 serverId/key/endpoint", () => {
    const offer = parseRelayOffer(SAMPLE_URI);
    expect(offer.serverId).toBe("srv_example");
    // %2F -> /、%3D -> =（URLSearchParams 语义）
    expect(offer.daemonPublicKeyB64).toBe(SAMPLE_KEY_RAW);
    expect(offer.endpoint).toBe("relay.example.test:80");
    expect(offer.useTls).toBe(false);
  });

  it("解析 ssl=true 与 password 参数", () => {
    const offer = parseRelayOffer(
      "relay://relay.example:443/srv_abc?key=AAAA&ssl=true&password=hunter2",
    );
    expect(offer.useTls).toBe(true);
    expect(offer.password).toBe("hunter2");
    expect(offer.endpoint).toBe("relay.example:443");
  });

  it("支持 #connect= 包装的 URI（对齐官方 parseRelayConnectionUri）", () => {
    const wrapped = `https://app.example/#connect=${encodeURIComponent(SAMPLE_URI)}`;
    const offer = parseRelayOffer(wrapped);
    expect(offer.serverId).toBe("srv_example");
    expect(offer.endpoint).toBe("relay.example.test:80");
  });

  it("拒绝缺 key / 缺 serverId / 非 relay 协议", () => {
    expect(() => parseRelayOffer("relay://host:80/srv_nokey")).toThrow();
    expect(() => parseRelayOffer("relay://host:80/?key=AAAA")).toThrow();
    expect(() => parseRelayOffer("https://example.com/foo")).toThrow();
    expect(() => parseRelayOffer("")).toThrow();
  });

  it("与 Node URLSearchParams 的解码语义一致（+ 表示空格）", () => {
    const offer = parseRelayOffer("relay://h:1/srv_x?key=a%2Bb%3D%3D");
    expect(offer.daemonPublicKeyB64).toBe("a+b==");
  });
});

describe("buildRelayClientWebSocketUrl", () => {
  it("构造 v2 client 连接 URL，参数与官方 buildRelayWebSocketUrl 一致", () => {
    const offer = parseRelayOffer(SAMPLE_URI);
    const url = buildRelayClientWebSocketUrl({ offer });
    expect(url.startsWith("ws://relay.example.test:80/ws?")).toBe(true);
    const params = new URL(url).searchParams;
    expect(params.get("serverId")).toBe("srv_example");
    expect(params.get("v")).toBe("2");
    expect(params.get("role")).toBe("client");
    // 客户端不提供 connectionId：由 relay 分配（daemon-endpoints.ts 注释约定）
    expect(params.get("connectionId")).toBeNull();
  });

  it("useTls=true 时使用 wss", () => {
    const url = buildRelayClientWebSocketUrl({
      offer: {
        serverId: "srv_1",
        daemonPublicKeyB64: "AAAA",
        endpoint: "r.example:443",
        useTls: true,
      },
    });
    expect(url.startsWith("wss://r.example:443/ws?")).toBe(true);
  });
});

describe("parseConnectionInput", () => {
  it("识别 relay 与直连 ws 输入", () => {
    expect(parseConnectionInput(SAMPLE_URI).kind).toBe("relay");
    const direct = parseConnectionInput("ws://127.0.0.1:6799/ws");
    expect(direct).toEqual({ kind: "direct", url: "ws://127.0.0.1:6799/ws" });
  });

  it("拒绝无法识别的输入", () => {
    expect(() => parseConnectionInput("hello world")).toThrow();
  });
});
