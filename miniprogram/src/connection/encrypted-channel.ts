/**
 * E2EE 加密信道（客户端一侧）。
 *
 * Vendor/适配自 packages/relay/src/encrypted-channel.ts（@aaswitch/relay）：
 * - createClientChannel：生成临时密钥对 → 发送 {type:"e2ee_hello", key}（带
 *   capabilities.binaryCiphertext）→ 等对端 {type:"e2ee_ready"} → open。
 * - 每 1s 重发 hello 直到 open（覆盖 daemon 数据 socket 晚接入导致的首个
 *   hello 被 relay 缓存的场景）。
 * - open 前的 send 进 pending 队列（上限 200），open 后 flush。
 * - 密文以 base64 文本帧传输（与官方客户端对字符串帧的行为一致）；
 *   binaryCiphertext 协商成功时二进制帧直接走二进制。
 *
 * 差异：仅保留客户端一侧（无 daemonKeyPair/re-hello 逻辑）；TextDecoder
 * 换为 utf8.ts；协议常量与状态机保持一致。互通性由 e2ee-interop.test.ts
 * 对官方 createDaemonChannel/createClientChannel 验证。
 */

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
  type SharedKey,
} from "./nacl-box";
import { decodeUtf8, encodeUtf8 } from "./utf8";

export interface Transport {
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((message: { data: string | ArrayBuffer; isBinary: boolean }) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface EncryptedChannelEvents {
  onopen?: () => void;
  onmessage?: (data: string | ArrayBuffer) => void;
  onclose?: (code: number, reason: string) => void;
  onerror?: (error: Error) => void;
}

interface E2EEHelloMessage {
  type: "e2ee_hello";
  key: string;
  capabilities?: { binaryCiphertext?: boolean };
}

interface E2EEReadyMessage {
  type: "e2ee_ready";
  capabilities?: { binaryCiphertext?: boolean };
}

const HANDSHAKE_RETRY_MS = 1000;
const MAX_PENDING_SENDS = 200;
const ENCRYPTED_PAYLOAD_OVERHEAD_BYTES = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isE2EEHelloMessage(value: unknown): value is E2EEHelloMessage {
  return (
    isRecord(value) &&
    value.type === "e2ee_hello" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0
  );
}

function isE2EEReadyMessage(value: unknown): value is E2EEReadyMessage {
  return isRecord(value) && value.type === "e2ee_ready";
}

function supportsBinaryCiphertext(message: E2EEHelloMessage | E2EEReadyMessage): boolean {
  return message.capabilities?.binaryCiphertext === true;
}

export async function createClientChannel(
  transport: Transport,
  daemonPublicKeyB64: string,
  events: EncryptedChannelEvents = {},
): Promise<ClientEncryptedChannel> {
  const keyPair = generateKeyPair();
  const daemonPublicKey = importPublicKey(daemonPublicKeyB64);
  const sharedKey = deriveSharedKey(keyPair.secretKey, daemonPublicKey);

  const channel = new ClientEncryptedChannel(transport, sharedKey, events);

  const ourPublicKeyB64 = exportPublicKey(keyPair.publicKey);
  const hello: E2EEHelloMessage = {
    type: "e2ee_hello",
    key: ourPublicKeyB64,
    capabilities: { binaryCiphertext: true },
  };
  const helloText = JSON.stringify(hello);

  let retry: ReturnType<typeof setInterval> | null = null;
  const emitSendError = (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    events.onerror?.(err);
  };
  const sendHello = () => {
    try {
      const result = transport.send(helloText);
      if (result) {
        void result.catch(emitSendError);
      }
    } catch (error) {
      emitSendError(error);
    }
  };
  const clearRetry = () => {
    if (retry) {
      clearInterval(retry);
      retry = null;
    }
  };

  channel.onTransitionToOpen(() => clearRetry());
  channel.onClose(() => clearRetry());

  sendHello();
  retry = setInterval(() => {
    if (channel.isOpen()) {
      clearRetry();
      return;
    }
    sendHello();
  }, HANDSHAKE_RETRY_MS);

  return channel;
}

type ChannelState = "handshaking" | "open" | "closed";

export class ClientEncryptedChannel {
  private transport: Transport;
  private sharedKey: SharedKey;
  private state: ChannelState = "handshaking";
  private events: EncryptedChannelEvents;
  private binaryCiphertext = false;
  private pendingSends: Array<string | ArrayBuffer> = [];
  private onOpenCallbacks: Array<() => void> = [];
  private onCloseCallbacks: Array<() => void> = [];

  constructor(transport: Transport, sharedKey: SharedKey, events: EncryptedChannelEvents = {}) {
    this.transport = transport;
    this.sharedKey = sharedKey;
    this.events = events;

    transport.onmessage = (message) => this.handleMessage(message);
    transport.onclose = (code, reason) => {
      this.state = "closed";
      this.events.onclose?.(code, reason);
      for (const cb of this.onCloseCallbacks) cb();
    };
    transport.onerror = (error) => {
      this.events.onerror?.(error);
    };
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  onTransitionToOpen(cb: () => void): void {
    this.onOpenCallbacks.push(cb);
  }

  onClose(cb: () => void): void {
    this.onCloseCallbacks.push(cb);
  }

  private handleMessage(message: { data: string | ArrayBuffer; isBinary: boolean }): void {
    if (this.state === "handshaking") {
      try {
        if (message.isBinary) return;
        const text =
          typeof message.data === "string"
            ? message.data
            : decodeUtf8(new Uint8Array(message.data));
        const parsed: unknown = JSON.parse(text);
        if (isE2EEReadyMessage(parsed)) {
          this.binaryCiphertext = supportsBinaryCiphertext(parsed);
          this.state = "open";
          this.events.onopen?.();
          for (const cb of this.onOpenCallbacks) cb();
          this.flushPendingSends();
        }
      } catch {
        // 非 ready 握手流量，忽略
      }
      return;
    }

    if (this.state !== "open") return;

    try {
      // 宽容处理迟到的握手流量（对端重复 hello / ready），与官方实现一致：
      // 尝试按明文 JSON 解析，命中握手消息则忽略。
      if (!message.isBinary && typeof message.data === "string") {
        try {
          const parsedJson: unknown = JSON.parse(message.data);
          if (isE2EEHelloMessage(parsedJson) || isE2EEReadyMessage(parsedJson)) {
            return;
          }
        } catch {
          // 非合法 JSON → 按密文处理
        }
      }

      // 密文帧：文本为 base64，二进制为原始 bundle
      const ciphertext =
        this.binaryCiphertext && message.isBinary
          ? (message.data as ArrayBuffer)
          : base64ToArrayBuffer(
              typeof message.data === "string"
                ? message.data
                : decodeUtf8(new Uint8Array(message.data)),
            );
      const plaintextBytes = decrypt(this.sharedKey, ciphertext);
      const plaintext = decodePlaintext(plaintextBytes, message.isBinary ? true : null);
      this.events.onmessage?.(plaintext);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.events.onerror?.(err);
      try {
        this.transport.close(1011, err.message);
      } catch {
        // ignore
      }
    }
  }

  send(data: string | ArrayBuffer): void {
    if (this.state === "handshaking") {
      if (this.pendingSends.length >= MAX_PENDING_SENDS) {
        this.pendingSends.shift();
      }
      this.pendingSends.push(data);
      return;
    }

    if (this.state !== "open") {
      throw new Error("Channel not open");
    }

    const ciphertext = encrypt(this.sharedKey, data);
    if (this.binaryCiphertext && data instanceof ArrayBuffer) {
      this.transport.send(ciphertext);
      return;
    }
    this.transport.send(arrayBufferToBase64(ciphertext));
  }

  outboundWireByteLength(data: string | ArrayBuffer): number {
    const plaintextBytes = typeof data === "string" ? encodeUtf8(data).byteLength : data.byteLength;
    const encryptedBytes = plaintextBytes + ENCRYPTED_PAYLOAD_OVERHEAD_BYTES;
    if (this.binaryCiphertext && data instanceof ArrayBuffer) {
      return encryptedBytes;
    }
    return 4 * Math.ceil(encryptedBytes / 3);
  }

  private flushPendingSends(): void {
    if (this.state !== "open") return;
    const pending = this.pendingSends;
    this.pendingSends = [];
    try {
      for (const item of pending) {
        this.send(item);
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.state = "closed";
      this.events.onerror?.(err);
      try {
        this.transport.close(1011, err.message);
      } catch {
        // ignore
      }
    }
  }

  close(code = 1000, reason = "Normal closure"): void {
    if (this.state === "closed") return;
    this.state = "closed";
    this.transport.close(code, reason);
  }
}
