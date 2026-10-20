/**
 * relay 传输层：把"连到 relay 的加密 SocketPort"包装成"E2EE 解密后的明文端口"。
 *
 * 结构对齐 packages/client/src/daemon-client-relay-e2ee-transport.ts 的
 * createEncryptedTransport：底层 socket 收到的每一帧原样转给
 * EncryptedChannel（官方实现 extractRelayMessage 之后透传，relay 不会注入
 * 额外明文协议帧）；E2EE 握手完成后，对上呈现 open/message/close/error。
 */

import { ClientEncryptedChannel, createClientChannel, type Transport } from "./encrypted-channel";
import type { RelayOffer } from "./relay-offer";
import type {
  PlaintextPort,
  SocketPort,
  SocketPortEvent,
  SocketEventHandler,
} from "./websocket-port";

export type RelayTransportState = "connecting" | "open" | "closed";

export interface RelayPlaintextSocket extends PlaintextPort {
  /** 等待 E2EE 握手完成（含底层 socket open）。 */
  ready(): Promise<void>;
  readonly state: RelayTransportState;
}

/**
 * 建立经 relay 的 E2EE 明文端口。
 *
 * @param connectUnderlying 建立底层 SocketPort（连到 buildRelayClientWebSocketUrl 的地址）
 * @param offer 已解析的 relay offer（daemon 公钥用于 E2EE）
 */
export function createRelayPlaintextSocket(args: {
  connectUnderlying: () => SocketPort;
  offer: RelayOffer;
  handshakeTimeoutMs?: number;
}): RelayPlaintextSocket {
  const { connectUnderlying, offer } = args;
  const handshakeTimeoutMs = args.handshakeTimeoutMs ?? 15_000;

  const handlers = new Set<SocketEventHandler>();
  let opened = false;
  let closed = false;
  let closeEmitted = false;
  let channel: ClientEncryptedChannel | null = null;
  let underlying: SocketPort | null = null;

  const emit = (event: SocketPortEvent) => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // handler 异常不阻断分发
      }
    }
  };

  const emitCloseOnce = (code: number, reason: string) => {
    if (closeEmitted) return;
    closeEmitted = true;
    closed = true;
    emit({ type: "close", code, reason });
  };

  let openResolve!: () => void;
  let openReject!: (error: Error) => void;
  const readyPromise = new Promise<void>((resolve, reject) => {
    openResolve = resolve;
    openReject = reject;
  });
  // ready() 的调用方（DaemonConnection）经由事件感知失败；这里吞掉 rejection，
  // 避免无人 await ready() 时产生 unhandled rejection。
  readyPromise.catch(() => {});

  const handshakeTimer = setTimeout(() => {
    if (!opened) {
      const err = new Error("E2EE 握手超时");
      emit({ type: "error", message: err.message });
      try {
        channel?.close(4001, err.message);
        underlying?.close(4001, err.message);
      } catch {
        // ignore
      }
      openReject(err);
      emitCloseOnce(4001, err.message);
    }
  }, handshakeTimeoutMs);

  const finishOpen = () => {
    if (opened || closed) return;
    opened = true;
    clearTimeout(handshakeTimer);
    openResolve();
    emit({ type: "open" });
  };

  underlying = connectUnderlying();

  // 文本帧直传；二进制密文帧（binaryCiphertext 协商成功且明文为二进制时才会
  // 出现，MVP 只发 JSON 字符串）转发到底层的 sendBinary。
  const transport: Transport = {
    send: (data) => {
      if (typeof data === "string") {
        underlying?.send(data);
        return;
      }
      underlying?.sendBinary?.(data);
    },
    close: (code, reason) => underlying?.close(code, reason),
    onmessage: null,
    onclose: null,
    onerror: null,
  };

  let handshakeStarted = false;

  underlying.onEvent((event) => {
    switch (event.type) {
      case "open":
        // E2EE 握手在底层 socket open 后才发起（对齐官方 daemon-client-relay-e2ee-
        // transport.ts 的 base.onOpen(startHandshake) —— hello 在 socket 未打开时
        // 发送会失败）。
        if (!handshakeStarted) {
          handshakeStarted = true;
          void startHandshake();
        }
        break;
      case "message":
        transport.onmessage?.({ data: event.data, isBinary: typeof event.data !== "string" });
        break;
      case "error":
        transport.onerror?.(new Error(event.message));
        if (!opened) {
          clearTimeout(handshakeTimer);
          openReject(new Error(event.message));
        }
        emit({ type: "error", message: event.message });
        emitCloseOnce(1006, event.message);
        break;
      case "close":
        transport.onclose?.(event.code, event.reason);
        if (!opened) {
          clearTimeout(handshakeTimer);
          openReject(new Error(`连接在握手前关闭：${event.code} ${event.reason}`));
        }
        emitCloseOnce(event.code, event.reason);
        break;
    }
  });

  const startHandshake = async () => {
    try {
      channel = await createClientChannel(transport, offer.daemonPublicKeyB64, {
        onopen: finishOpen,
        onmessage: (data) => emit({ type: "message", data }),
        onclose: (code, reason) => {
          if (!opened) {
            clearTimeout(handshakeTimer);
            openReject(new Error(`E2EE 信道关闭：${code} ${reason}`));
          }
          emitCloseOnce(code, reason);
        },
        onerror: (error) => emit({ type: "error", message: error.message }),
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      clearTimeout(handshakeTimer);
      openReject(err);
      emit({ type: "error", message: err.message });
      underlying?.close(4001, "E2EE handshake failed");
      emitCloseOnce(4001, err.message);
    }
  };

  return {
    get state(): RelayTransportState {
      if (closed) return "closed";
      return opened ? "open" : "connecting";
    },
    ready: () => readyPromise,
    send(data: string) {
      if (!channel || !channel.isOpen()) {
        throw new Error("E2EE 信道未就绪");
      }
      channel.send(data);
    },
    close(code, reason) {
      if (channel) {
        channel.close(code, reason);
      } else {
        underlying?.close(code, reason);
      }
      emitCloseOnce(code ?? 1000, reason ?? "Normal closure");
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
