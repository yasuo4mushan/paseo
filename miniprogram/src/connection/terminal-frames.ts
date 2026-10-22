/**
 * 终端流二进制帧编解码（t19）。
 *
 * Vendor 自 packages/protocol/src/binary-frames/terminal.ts：
 * - 帧格式：[opcode][slot(u8)][payload...]，与文件传输帧（0x10+）同连接不同通道。
 * - Output(0x01)：daemon → 客户端的 PTY 输出增量（UTF-8 字节，可含 ANSI 转义）。
 * - Input(0x02)：客户端 → daemon 的按键输入（小程序端经 terminal_input JSON 消息
 *   发送，本 opcode 保留不用——对齐官方客户端走 JSON 路径）。
 * - Resize(0x03)：JSON {rows,cols}（双向；小程序端经 terminal_input resize 发送）。
 * - Snapshot(0x04)：JSON TerminalState（grid/scrollback cells；live 订阅不主动发）。
 * - Restore(0x05)：订阅带回放时 daemon 先发的存量输出（snapshot 渲染成的 ANSI 文本）。
 */

export const TerminalStreamOpcode = {
  Output: 0x01,
  Input: 0x02,
  Resize: 0x03,
  Snapshot: 0x04,
  Restore: 0x05,
} as const;

export type TerminalStreamOpcode = (typeof TerminalStreamOpcode)[keyof typeof TerminalStreamOpcode];

export interface TerminalStreamFrame {
  opcode: TerminalStreamOpcode;
  slot: number;
  payload: Uint8Array;
}

function isTerminalStreamOpcode(value: number): value is TerminalStreamOpcode {
  return (
    value === TerminalStreamOpcode.Output ||
    value === TerminalStreamOpcode.Input ||
    value === TerminalStreamOpcode.Resize ||
    value === TerminalStreamOpcode.Snapshot ||
    value === TerminalStreamOpcode.Restore
  );
}

export function encodeTerminalStreamFrame(input: {
  opcode: TerminalStreamOpcode;
  slot: number;
  payload?: Uint8Array;
}): Uint8Array {
  const payload = input.payload ?? new Uint8Array(0);
  const bytes = new Uint8Array(2 + payload.byteLength);
  bytes[0] = input.opcode;
  bytes[1] = input.slot & 0xff;
  bytes.set(payload, 2);
  return bytes;
}

/** 解码一帧；首字节不是终端 opcode 或长度非法时返回 null。 */
export function decodeTerminalStreamFrame(bytes: Uint8Array): TerminalStreamFrame | null {
  if (bytes.byteLength < 2) return null;
  const opcode = bytes[0];
  if (!isTerminalStreamOpcode(opcode)) return null;
  return {
    opcode,
    slot: bytes[1],
    payload: bytes.subarray(2),
  };
}
