/**
 * E2EE 加密原语（tweetnacl Box：X25519 密钥交换 + XSalsa20-Poly1305）。
 *
 * Vendor/适配自 packages/relay/src/crypto.ts（@getpaseo/relay），语义保持一致：
 * - generateKeyPair / exportPublicKey / importPublicKey
 * - deriveSharedKey（nacl.scalarMult 做 all-zero 校验后 nacl.box.before）
 * - encrypt/decrypt（bundle 格式 [nonce 24B][ciphertext]）
 * 与官方实现的互通性由 tests/e2ee-interop.test.ts 验证。
 *
 * 差异：TextEncoder/TextDecoder 换成 src/connection/utf8.ts 的纯 TS 实现
 * （小程序环境无这两个全局）；PRNG 由 random-source.ts 显式提供。
 */

import nacl from "tweetnacl";
import { fromByteArray, toByteArray } from "base64-js";
import { decodeUtf8, encodeUtf8 } from "./utf8";

export interface KeyPair {
  publicKey: Uint8Array; // 32 bytes
  secretKey: Uint8Array; // 32 bytes
}

export type SharedKey = Uint8Array; // 32 bytes (box.before)

const NONCE_LENGTH = nacl.box.nonceLength; // 24
const ZERO_X25519_SHARED_RESULT = new Uint8Array(nacl.box.sharedKeyLength);

export function generateKeyPair(): KeyPair {
  const { publicKey, secretKey } = nacl.box.keyPair();
  return { publicKey, secretKey };
}

export function exportPublicKey(publicKey: Uint8Array): string {
  if (!(publicKey instanceof Uint8Array) || publicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return fromByteArray(publicKey);
}

function decodeBase64(base64: string): Uint8Array {
  return toByteArray(base64);
}

function decodePublicKeyBase64(base64: string): Uint8Array {
  if (
    typeof base64 !== "string" ||
    base64.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("Invalid public key encoding");
  }
  const bytes = decodeBase64(base64);
  if (fromByteArray(bytes) !== base64) {
    throw new Error("Invalid public key encoding");
  }
  return bytes;
}

export function importPublicKey(base64: string): Uint8Array {
  const bytes = decodePublicKeyBase64(base64);
  if (bytes.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid public key length (expected ${nacl.box.publicKeyLength})`);
  }
  return bytes;
}

export function deriveSharedKey(ourSecretKey: Uint8Array, peerPublicKey: Uint8Array): SharedKey {
  if (ourSecretKey.byteLength !== nacl.box.secretKeyLength) {
    throw new Error(`Invalid secret key length (expected ${nacl.box.secretKeyLength})`);
  }
  if (peerPublicKey.byteLength !== nacl.box.publicKeyLength) {
    throw new Error(`Invalid peer public key length (expected ${nacl.box.publicKeyLength})`);
  }

  const rawSharedResult = nacl.scalarMult(ourSecretKey, peerPublicKey);
  const isAllZero = nacl.verify(rawSharedResult, ZERO_X25519_SHARED_RESULT);
  rawSharedResult.fill(0);
  if (isAllZero) {
    throw new Error("Invalid peer public key");
  }

  return nacl.box.before(peerPublicKey, ourSecretKey);
}

function toUint8(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return encodeUtf8(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new Uint8Array(bytes.byteLength);
  out.set(bytes);
  return out.buffer;
}

/** 加密并返回 [nonce(24)][ciphertext] 二进制 bundle。 */
export function encrypt(
  sharedKey: SharedKey,
  data: string | ArrayBuffer | Uint8Array,
): ArrayBuffer {
  const nonce = nacl.randomBytes(NONCE_LENGTH);
  const plaintext = toUint8(data);
  const ciphertext = nacl.box.after(plaintext, nonce, sharedKey);
  const out = new Uint8Array(nonce.byteLength + ciphertext.byteLength);
  out.set(nonce, 0);
  out.set(ciphertext, nonce.byteLength);
  return toArrayBuffer(out);
}

export function decrypt(sharedKey: SharedKey, data: ArrayBuffer | Uint8Array): ArrayBuffer {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.byteLength < NONCE_LENGTH) {
    throw new Error("Ciphertext bundle too short");
  }

  const nonce = bytes.slice(0, NONCE_LENGTH);
  const ciphertext = bytes.slice(NONCE_LENGTH);
  const opened = nacl.box.open.after(ciphertext, nonce, sharedKey);
  if (!opened) {
    throw new Error("Decryption failed");
  }

  return toArrayBuffer(opened);
}

/** base64 <-> ArrayBuffer（对齐 packages/relay/src/base64.ts，含 base64url 宽容输入）。 */
export function arrayBufferToBase64(buffer: ArrayBuffer | Uint8Array): string {
  return fromByteArray(buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer));
}

export function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const trimmed = base64.trim();
  const standard = trimmed.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (standard.length % 4)) % 4;
  const bytes = toByteArray(standard + "=".repeat(padLen));
  return toArrayBuffer(bytes);
}

/** 供 EncryptedChannel 解码明文：合法 UTF-8 返回字符串，否则返回 ArrayBuffer。 */
export function decodePlaintext(data: ArrayBuffer, isBinary: boolean | null): string | ArrayBuffer {
  const bytes = new Uint8Array(data);
  if (isBinary === true) return data;
  try {
    return decodeUtf8(bytes, { fatal: true });
  } catch {
    if (isBinary === false) {
      throw new Error("Encrypted payload was not valid UTF-8 text");
    }
    return data;
  }
}
