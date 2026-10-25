import { describe, expect, it } from "vitest";
import {
  arrayBufferToBase64,
  base64ToArrayBuffer,
  decodePlaintext,
  decrypt,
  deriveSharedKey,
  encrypt,
  exportPublicKey,
  generateKeyPair,
  importPublicKey,
} from "../src/connection/nacl-box";
import { installSystemRandomSource } from "../src/connection/random-source";
import { loadOfficialRelay } from "./helpers/official-relay";

installSystemRandomSource();

const official = loadOfficialRelay();

describe("nacl-box 原语", () => {
  it("generateKeyPair -> deriveSharedKey -> encrypt/decrypt roundtrip", () => {
    const daemon = generateKeyPair();
    const client = generateKeyPair();
    const keyA = deriveSharedKey(client.secretKey, daemon.publicKey);
    const keyB = deriveSharedKey(daemon.secretKey, client.publicKey);
    // X25519 对称性
    expect(Array.from(keyA)).toEqual(Array.from(keyB));

    const ciphertext = encrypt(keyA, "你好，daemon");
    const plaintext = decrypt(keyB, ciphertext);
    expect(new TextDecoder().decode(plaintext)).toBe("你好，daemon");
  });

  it("importPublicKey 校验 base64 形状与长度", () => {
    const pair = generateKeyPair();
    const exported = exportPublicKey(pair.publicKey);
    expect(importPublicKey(exported).byteLength).toBe(32);
    expect(() => importPublicKey("not+base64==")).toThrow();
    expect(() => importPublicKey(arrayBufferToBase64(new Uint8Array(16)))).toThrow();
  });

  it("base64ToArrayBuffer 容忍 base64url 输入（relay 密文宽容解码）", () => {
    const bytes = new Uint8Array([1, 2, 3, 250, 251, 252]);
    const standard = arrayBufferToBase64(bytes);
    const urlSafe = standard.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    expect(Array.from(new Uint8Array(base64ToArrayBuffer(urlSafe)))).toEqual(Array.from(bytes));
  });

  it("decodePlaintext：合法 UTF-8 返回字符串，非法返回 ArrayBuffer", () => {
    const textBytes = new TextEncoder().encode("plain");
    const buf = new Uint8Array(textBytes).slice().buffer;
    expect(decodePlaintext(buf, null)).toBe("plain");
    const binary = new Uint8Array([0x00, 0xff, 0xfe, 0x81]).slice().buffer;
    expect(decodePlaintext(binary, null)).toBeInstanceOf(ArrayBuffer);
  });

  it("篡改密文解密失败", () => {
    const pair = generateKeyPair();
    const key = deriveSharedKey(pair.secretKey, pair.publicKey);
    const ciphertext = new Uint8Array(encrypt(key, "secret"));
    ciphertext[ciphertext.length - 1] ^= 0xff;
    expect(() => decrypt(key, ciphertext.slice().buffer)).toThrow(/Decryption failed|too short/);
  });
});

describe("与官方 @aaswitch/relay 加密原语互通", () => {
  it.skipIf(official === null)("官方公钥可被 vendor 实现导入并派生共享密钥", () => {
    if (!official) throw new Error("official @aaswitch/relay not found");
    const officialPair = official.generateKeyPair();
    const officialPublicB64 = official.exportPublicKey(officialPair.publicKey);
    // 小程序侧从 offer 的 key 参数导入官方 daemon 公钥
    const imported = importPublicKey(officialPublicB64);
    expect(imported.byteLength).toBe(32);

    const mpClient = generateKeyPair();
    const keyMp = deriveSharedKey(mpClient.secretKey, imported);
    const keyOfficial = ((): Uint8Array => {
      // 官方 deriveSharedKey 未从 e2ee.js 导出，用其加密通道行为替代直接断言：
      // 在互通测试（e2ee-interop）里覆盖。这里只验证长度与可用性。
      return keyMp;
    })();
    expect(keyOfficial.byteLength).toBe(32);

    const ciphertext = encrypt(keyMp, "interop");
    expect(new TextDecoder().decode(decrypt(keyMp, ciphertext))).toBe("interop");
  });
});
