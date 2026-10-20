/**
 * Node `ws` 的 SocketPort 适配 —— 仅测试用（不进小程序 bundle，Taro 构建不引用本目录）。
 */
import { WebSocket } from "ws";
import type { SocketPort, SocketEventHandler } from "../../src/connection/websocket-port";

export function createNodeSocket(url: string): SocketPort {
  const ws = new WebSocket(url);
  const handlers = new Set<SocketEventHandler>();

  const emit = (event: Parameters<SocketEventHandler>[0]) => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // ignore
      }
    }
  };

  ws.on("open", () => emit({ type: "open" }));
  ws.on("error", (err: Error) => emit({ type: "error", message: err.message }));
  ws.on("close", (code: number, reason: Buffer) =>
    emit({ type: "close", code, reason: reason?.toString() ?? "" }),
  );
  ws.on("message", (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    if (isBinary) {
      const bytes = Buffer.isBuffer(data) ? data : Buffer.concat(data as Buffer[]);
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      emit({ type: "message", data: copy.buffer });
      return;
    }
    emit({ type: "message", data: Buffer.isBuffer(data) ? data.toString("utf8") : String(data) });
  });

  return {
    send(data) {
      if (ws.readyState !== WebSocket.OPEN) {
        emit({ type: "error", message: `socket not open (readyState=${ws.readyState})` });
        return;
      }
      ws.send(data);
    },
    sendBinary(data) {
      ws.send(data);
    },
    close(code, reason) {
      ws.close(code ?? 1000, reason ?? "");
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
