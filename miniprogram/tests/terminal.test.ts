/**
 * t19 终端基础件单测：ANSI 剥离 / 行缓冲状态机 / 流帧编解码。
 */

import { describe, expect, it } from "vitest";
import {
  decodeTerminalStreamFrame,
  encodeTerminalStreamFrame,
  TerminalStreamOpcode,
} from "../src/connection/terminal-frames";
import { stripAnsi, TerminalBuffer } from "../src/utils/terminal-buffer";

describe("stripAnsi", () => {
  it("剥离 SGR 色彩与光标序列", () => {
    expect(stripAnsi("\u001b[31m红\u001b[0m普通")).toBe("红普通");
    expect(stripAnsi("\u001b[2J\u001b[H清屏")).toBe("清屏");
    expect(stripAnsi("\u001b[?25l隐藏光标")).toBe("隐藏光标");
  });

  it("剥离 OSC（含 BEL 结束）", () => {
    expect(stripAnsi("\u001b]0;标题\u0007正文")).toBe("正文");
  });

  it("保留 \r \n \b（由缓冲状态机处理）", () => {
    expect(stripAnsi("a\r\nb\b")).toBe("a\r\nb\b");
  });

  it("丢弃其他控制字符（BEL 等）", () => {
    expect(stripAnsi("a\u0007b")).toBe("ab");
  });
});

describe("TerminalBuffer", () => {
  it("按行累积输出", () => {
    const buffer = new TerminalBuffer();
    buffer.push("第一行\n第二行\n第三行");
    expect(buffer.lines()).toEqual(["第一行", "第二行", "第三行"]);
  });

  it("\\r 覆盖显示最终态（进度条）", () => {
    const buffer = new TerminalBuffer();
    buffer.push("进度 25%\r进度 80%\r进度 100%\n");
    expect(buffer.lines()).toEqual(["进度 100%"]);
  });

  it("\\b 退格删除", () => {
    const buffer = new TerminalBuffer();
    buffer.push("abbc\b\b\n");
    expect(buffer.lines()).toEqual(["ab"]);
  });

  it("tab 展开两空格", () => {
    const buffer = new TerminalBuffer();
    buffer.push("a\tb");
    expect(buffer.lines()).toEqual(["a  b"]);
  });

  it("ANSI 直接进入 push 也被剥离", () => {
    const buffer = new TerminalBuffer();
    buffer.push("\u001b[32mOK\u001b[0m\n");
    expect(buffer.lines()).toEqual(["OK"]);
  });

  it("行数上限（500 行滚动丢弃）", () => {
    const buffer = new TerminalBuffer();
    for (let i = 0; i < 600; i += 1) buffer.push(`line-${i}\n`);
    const lines = buffer.lines();
    expect(lines.length).toBeLessThanOrEqual(500);
    expect(lines[lines.length - 1]).toBe("line-599");
  });

  it("reset 清空", () => {
    const buffer = new TerminalBuffer();
    buffer.push("x\n");
    buffer.reset();
    expect(buffer.hasOutput).toBe(false);
  });
});

describe("terminal-frames 编解码", () => {
  it("Output 帧往返（opcode/slot/payload）", () => {
    const payload = new TextEncoder().encode("hello");
    const frame = encodeTerminalStreamFrame({
      opcode: TerminalStreamOpcode.Output,
      slot: 7,
      payload,
    });
    expect(frame[0]).toBe(0x01);
    expect(frame[1]).toBe(7);
    const decoded = decodeTerminalStreamFrame(frame);
    expect(decoded?.opcode).toBe(TerminalStreamOpcode.Output);
    expect(decoded?.slot).toBe(7);
    expect(new TextDecoder().decode(decoded!.payload)).toBe("hello");
  });

  it("非终端 opcode（文件帧 0x10+）返回 null", () => {
    const bytes = new Uint8Array([0x10, 0x01, 0x61]);
    expect(decodeTerminalStreamFrame(bytes)).toBeNull();
  });

  it("长度不足返回 null", () => {
    expect(decodeTerminalStreamFrame(new Uint8Array([0x01]))).toBeNull();
  });
});
