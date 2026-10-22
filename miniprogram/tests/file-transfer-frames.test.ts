/**
 * t17 文件传输二进制帧编解码单测（vendor 自官方 file-transfer.test.ts 的关键路径）。
 */
import { describe, expect, it } from "vitest";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileBeginMetadata,
} from "../src/connection/file-transfer-frames";
import { decodeUtf8, encodeUtf8 } from "../src/connection/utf8";

const METADATA: FileBeginMetadata = {
  mime: "text/plain",
  size: 5,
  encoding: "utf-8",
  modifiedAt: "2026-10-22T00:00:00Z",
};

describe("file-transfer frames", () => {
  it("FileBegin 编解码往返", () => {
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "req-1",
      metadata: { ...METADATA, revision: "r1", fileName: "a.txt" },
    });
    expect(encoded[0]).toBe(FileTransferOpcode.FileBegin);
    const decoded = decodeFileTransferFrame(encoded);
    expect(decoded).not.toBeNull();
    expect(decoded?.opcode).toBe(FileTransferOpcode.FileBegin);
    if (decoded?.opcode !== FileTransferOpcode.FileBegin) return;
    expect(decoded.requestId).toBe("req-1");
    expect(decoded.metadata).toEqual({ ...METADATA, revision: "r1", fileName: "a.txt" });
    expect(decoded.payload.byteLength).toBe(0);
  });

  it("FileChunk 编解码往返（含中文与二进制字节）", () => {
    const payload = encodeUtf8("你好，paseo");
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileChunk,
      requestId: "req-中文-id",
      payload,
    });
    const decoded = decodeFileTransferFrame(encoded);
    if (decoded?.opcode !== FileTransferOpcode.FileChunk) throw new Error("不是 FileChunk");
    expect(decoded.requestId).toBe("req-中文-id");
    expect(decodeUtf8(decoded.payload)).toBe("你好，paseo");
  });

  it("FileEnd 编解码（无 body）", () => {
    const encoded = encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileEnd,
      requestId: "req-1",
    });
    expect(encoded.byteLength).toBe(2 + "req-1".length);
    const decoded = decodeFileTransferFrame(encoded);
    expect(decoded?.opcode).toBe(FileTransferOpcode.FileEnd);
    expect(decoded?.requestId).toBe("req-1");
  });

  it("非法帧返回 null：太短 / 错误 opcode / requestId 越界 / 元数据长度不符 / 坏 JSON", () => {
    expect(decodeFileTransferFrame(new Uint8Array(0))).toBeNull();
    expect(decodeFileTransferFrame(new Uint8Array([0x10]))).toBeNull();
    // 终端流 opcode 不属于文件通道
    expect(decodeFileTransferFrame(new Uint8Array([0x01, 0x01, 0x61]))).toBeNull();
    // requestIdLength 越界
    expect(decodeFileTransferFrame(new Uint8Array([0x12, 0x09, 0x61]))).toBeNull();
    // FileEnd 带多余字节
    expect(decodeFileTransferFrame(new Uint8Array([0x12, 0x01, 0x61, 0x00]))).toBeNull();
    // FileBegin 元数据长度字段与实际不符
    expect(
      decodeFileTransferFrame(new Uint8Array([0x10, 0x01, 0x61, 0x00, 0x05, 0x31, 0x32])),
    ).toBeNull();
    // FileBegin 元数据 JSON 非法
    const badJson = encodeUtf8("{nope");
    const bad = new Uint8Array(4 + 1 + badJson.byteLength);
    bad[0] = 0x10;
    bad[1] = 1;
    bad[2] = 0x61;
    new DataView(bad.buffer).setUint16(3, badJson.byteLength);
    bad.set(badJson, 5);
    expect(decodeFileTransferFrame(bad)).toBeNull();
  });

  it("元数据缺字段（mime/size/encoding/modifiedAt）返回 null", () => {
    for (const drop of ["mime", "size", "encoding", "modifiedAt"] as const) {
      const metadata = { ...METADATA } as Record<string, unknown>;
      delete metadata[drop];
      const json = encodeUtf8(JSON.stringify(metadata));
      const frame = new Uint8Array(4 + 5 + json.byteLength);
      frame[0] = 0x10;
      frame[1] = 5;
      frame.set(encodeUtf8("req-1"), 2);
      new DataView(frame.buffer).setUint16(7, json.byteLength);
      frame.set(json, 9);
      expect(decodeFileTransferFrame(frame)).toBeNull();
    }
  });

  it("空 requestId / 超长 metadata 抛错", () => {
    expect(() =>
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "" }),
    ).toThrow();
    expect(() =>
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "r",
        metadata: { ...METADATA, mime: "x".repeat(70_000) },
      }),
    ).toThrow();
  });
});
