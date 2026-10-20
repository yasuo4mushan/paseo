/**
 * 微信小程序 SocketPort 适配：基于 Taro.connectSocket（wx.connectSocket）。
 *
 * 仅此文件（和 app 入口的随机源安装）依赖 Taro；连接层其余部分平台无关。
 */

import Taro from "@tarojs/taro";
import type { SocketPort, SocketPortEvent, SocketEventHandler } from "./websocket-port";

export function createWxSocket(url: string): SocketPort {
  const handlers = new Set<SocketEventHandler>();

  const emit = (event: SocketPortEvent) => {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // ignore
      }
    }
  };

  // Taro.connectSocket 返回 SocketTask（回调注册在 task 上，避免并发连接数限制的
  // 全局 onSocketMessage 形态）。
  const task = Taro.connectSocket({
    url,
    fail: (error) => {
      emit({ type: "error", message: error?.errMsg ?? "connectSocket failed" });
    },
  });

  const bind = (socketTask: Taro.SocketTask) => {
    socketTask.onOpen(() => emit({ type: "open" }));
    socketTask.onMessage((msg: { data: string | ArrayBuffer }) =>
      emit({ type: "message", data: msg.data }),
    );
    socketTask.onError((error: { errMsg?: string }) =>
      emit({ type: "error", message: error?.errMsg ?? "socket error" }),
    );
    socketTask.onClose((close: { code?: number; reason?: string }) =>
      emit({
        type: "close",
        code: close?.code ?? 0,
        reason: close?.reason ?? "",
      }),
    );
  };

  Promise.resolve(task)
    .then(bind)
    .catch((error: unknown) => {
      emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
    });

  return {
    send(data) {
      void Promise.resolve(task).then((socketTask) => {
        socketTask.send({
          data,
          fail: (error: { errMsg?: string }) =>
            emit({ type: "error", message: error?.errMsg ?? "send failed" }),
        });
      });
    },
    sendBinary(data) {
      void Promise.resolve(task).then((socketTask) => {
        socketTask.send({
          data,
          fail: (error: { errMsg?: string }) =>
            emit({ type: "error", message: error?.errMsg ?? "send failed" }),
        });
      });
    },
    close(code, reason) {
      void Promise.resolve(task).then((socketTask) => {
        try {
          socketTask.close({ code, reason } as Taro.SocketTask.CloseOption);
        } catch {
          // 已关闭时忽略
        }
      });
    },
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
  };
}
