/**
 * 内存 SocketPort 对：daemon-connection 单元测试用（无需网络）。
 */
import type { SocketPort, SocketEventHandler } from "../../src/connection/websocket-port";

export interface MockDaemonSide {
  /** 客户端发出的原始文本帧。 */
  sentFrames: string[];
  /** 解析后的最后一个 session 请求。 */
  lastRequest(): ({ type: string; requestId: string } & Record<string, unknown>) | null;
  /** 以 daemon 身份向客户端推送一条 JSON（外层 WS 信封）。 */
  pushSession(message: unknown): void;
  emitOpen(): void;
  emitClose(code: number, reason: string): void;
}

export function createMockSocketPair(): { clientPort: SocketPort; server: MockDaemonSide } {
  const handlers = new Set<SocketEventHandler>();
  const sentFrames: string[] = [];

  const emit = (event: Parameters<SocketEventHandler>[0]) => {
    for (const handler of handlers) handler(event);
  };

  const clientPort: SocketPort = {
    send(data) {
      sentFrames.push(data);
    },
    sendBinary(data) {
      sentFrames.push(`<binary:${data.byteLength}>`);
    },
    close() {
      emit({ type: "close", code: 1000, reason: "closed" });
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };

  const server: MockDaemonSide = {
    sentFrames,
    lastRequest() {
      for (let i = sentFrames.length - 1; i >= 0; i -= 1) {
        const parsed = JSON.parse(sentFrames[i]) as {
          type?: string;
          message?: Record<string, unknown>;
        };
        if (
          parsed.type === "session" &&
          parsed.message &&
          typeof parsed.message.type === "string"
        ) {
          return parsed.message as { type: string; requestId: string } & Record<string, unknown>;
        }
      }
      return null;
    },
    pushSession(message) {
      emit({ type: "message", data: JSON.stringify({ type: "session", message }) });
    },
    emitOpen() {
      emit({ type: "open" });
    },
    emitClose(code, reason) {
      emit({ type: "close", code, reason });
    },
  };

  return { clientPort, server };
}
