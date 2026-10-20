/**
 * 平台无关的最小 WebSocket 端口接口。
 *
 * 连接层核心（daemon-connection / relay-transport）只依赖这个接口；
 * 平台适配在 wx-socket.ts（微信小程序）与 tests/helpers/node-socket.ts（Node 测试）。
 */

export interface SocketOpenEvent {
  type: "open";
}

export interface SocketCloseEvent {
  type: "close";
  code: number;
  reason: string;
}

export interface SocketErrorEvent {
  type: "error";
  message: string;
}

export interface SocketMessageEvent {
  type: "message";
  /** 文本帧为 string，二进制帧为 ArrayBuffer（MVP 只消费文本 JSON 帧）。 */
  data: string | ArrayBuffer;
}

export type SocketPortEvent =
  | SocketOpenEvent
  | SocketCloseEvent
  | SocketErrorEvent
  | SocketMessageEvent;

export type SocketEventHandler = (event: SocketPortEvent) => void;

export interface SocketPort {
  /** 发送文本帧（daemon 协议全部走 JSON 文本帧）。 */
  send(data: string): void;
  /** 发送二进制帧（仅 E2EE binaryCiphertext 协商后的密文可能用到）。 */
  sendBinary?(data: ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  onEvent(handler: SocketEventHandler): () => void;
}

export type SocketPortFactory = () => SocketPort;

/** 上层（E2EE 解密后）的明文端口：形态与 SocketPort 相同。 */
export type PlaintextPort = SocketPort;
export type PlaintextPortFactory = () => PlaintextPort;
