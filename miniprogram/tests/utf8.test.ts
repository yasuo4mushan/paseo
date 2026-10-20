import { describe, expect, it } from "vitest";
import { decodeUtf8, encodeUtf8 } from "../src/connection/utf8";

const SAMPLES = [
  "hello",
  "中文消息内容",
  "emoji 🚀🧠 与文本",
  "surrogate pair 𐐷 和 𝕏",
  "mixed 中en混合 with\nnewline\tand tab",
  "",
];

describe("utf8（纯 TS 实现与 Web 标准 API 行为一致性）", () => {
  it("encodeUtf8 与 TextEncoder 输出一致", () => {
    for (const sample of SAMPLES) {
      expect(Array.from(encodeUtf8(sample))).toEqual(Array.from(new TextEncoder().encode(sample)));
    }
  });

  it("decodeUtf8 与 TextDecoder 输出一致", () => {
    for (const sample of SAMPLES) {
      const bytes = new TextEncoder().encode(sample);
      expect(decodeUtf8(bytes)).toBe(new TextDecoder().decode(bytes));
    }
  });

  it("roundtrip：encode 后 decode 还原", () => {
    for (const sample of SAMPLES) {
      expect(decodeUtf8(encodeUtf8(sample))).toBe(sample);
    }
  });

  it("fatal 语义：非法字节序列抛错", () => {
    // 0xFF 不是合法 UTF-8 起始字节
    expect(() => decodeUtf8(Uint8Array.from([0x61, 0xff, 0x62]), { fatal: true })).toThrow();
    // 截断的多字节序列
    expect(() => decodeUtf8(Uint8Array.from([0xe4, 0xb8]), { fatal: true })).toThrow();
    // 非法时默认替换为 U+FFFD
    expect(decodeUtf8(Uint8Array.from([0x61, 0xff, 0x62]))).toContain("\uFFFD");
  });

  it("JSON 消息（中文）经编解码无损", () => {
    const message = JSON.stringify({
      type: "session",
      message: { type: "send_agent_message_request", text: "帮我修复登录页的中文文案" },
    });
    expect(decodeUtf8(encodeUtf8(message))).toBe(message);
  });
});
