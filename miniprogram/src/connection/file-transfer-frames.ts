/**
 * 文件传输二进制帧编解码。
 *
 * Vendor 自 packages/protocol/src/binary-frames/file-transfer.ts（去 zod，
 * 元数据手工校验）。帧格式（daemon WebSocket 上的二进制帧，与文本 JSON 帧
 * 复用同一条连接；首字节是 opcode）：
 *
 * - FileBegin(0x10): [0x10][reqIdLen][reqId...][u16 metadataLen][metadata JSON]
 * - FileChunk(0x11): [0x11][reqIdLen][reqId...][payload bytes...]
 * - FileEnd(0x12):   [0x12][reqIdLen][reqId...]
 *
 * 语义（对齐官方客户端 daemon-client.ts 与 server file-upload/index.ts）：
 * - 下载：客户端发 file_explorer_request{mode:"file",acceptBinary:true} 后，
 *   daemon 以 Begin/Chunk.../End 流回文件；成功时**不再发 JSON 响应**，
 *   由客户端在 End 帧后自行完成请求（错误时仍回 JSON error）。
 * - 上传：客户端先发 file.upload.request（JSON），再按 Begin/Chunk.../End
 *   发送字节；daemon 在 End 后回 file.upload.response（JSON）。
 * - 终端流帧（opcode < 0x10）不属于文件通道，本模块不处理。
 */

import { decodeUtf8, encodeUtf8 } from "./utf8";

export const FileTransferOpcode = {
  FileBegin: 0x10,
  FileChunk: 0x11,
  FileEnd: 0x12,
} as const;

export type FileTransferOpcode = (typeof FileTransferOpcode)[keyof typeof FileTransferOpcode];

export interface FileBeginMetadata {
  mime: string;
  size: number;
  encoding: "utf-8" | "binary";
  modifiedAt: string;
  revision?: string;
  fileName?: string;
}

export interface FileBegin {
  opcode: typeof FileTransferOpcode.FileBegin;
  requestId: string;
  metadata: FileBeginMetadata;
  payload: Uint8Array;
}

export interface FileChunk {
  opcode: typeof FileTransferOpcode.FileChunk;
  requestId: string;
  payload: Uint8Array;
}

export interface FileEnd {
  opcode: typeof FileTransferOpcode.FileEnd;
  requestId: string;
  payload: Uint8Array;
}

export type FileTransferFrame = FileBegin | FileChunk | FileEnd;

export function encodeFileTransferFrame(
  input:
    | {
        opcode: typeof FileTransferOpcode.FileBegin;
        requestId: string;
        metadata: FileBeginMetadata;
      }
    | {
        opcode: typeof FileTransferOpcode.FileChunk;
        requestId: string;
        payload?: Uint8Array | ArrayBuffer;
      }
    | { opcode: typeof FileTransferOpcode.FileEnd; requestId: string },
): Uint8Array {
  const requestId = encodeRequestId(input.requestId);

  if (input.opcode === FileTransferOpcode.FileBegin) {
    const metadata = encodeUtf8(JSON.stringify(input.metadata));
    if (metadata.byteLength > 0xffff) {
      throw new RangeError("FileBegin metadata is too long");
    }
    const bytes = new Uint8Array(4 + requestId.byteLength + metadata.byteLength);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    bytes[0] = input.opcode;
    bytes[1] = requestId.byteLength;
    bytes.set(requestId, 2);
    view.setUint16(2 + requestId.byteLength, metadata.byteLength);
    bytes.set(metadata, 4 + requestId.byteLength);
    return bytes;
  }

  const payload =
    input.opcode === FileTransferOpcode.FileChunk
      ? (asBytes(input.payload ?? new Uint8Array()) ?? new Uint8Array())
      : new Uint8Array();
  const bytes = new Uint8Array(2 + requestId.byteLength + payload.byteLength);
  bytes[0] = input.opcode;
  bytes[1] = requestId.byteLength;
  bytes.set(requestId, 2);
  bytes.set(payload, 2 + requestId.byteLength);
  return bytes;
}

/** 解码一帧；首字节不是文件 opcode 或格式非法时返回 null。 */
export function decodeFileTransferFrame(bytes: Uint8Array): FileTransferFrame | null {
  if (bytes.byteLength < 2) return null;
  const opcode = bytes[0];
  if (
    opcode !== FileTransferOpcode.FileBegin &&
    opcode !== FileTransferOpcode.FileChunk &&
    opcode !== FileTransferOpcode.FileEnd
  ) {
    return null;
  }
  const requestIdLength = bytes[1];
  if (requestIdLength === 0 || requestIdLength > bytes.byteLength - 2) return null;

  const requestId = decodeUtf8(bytes.subarray(2, 2 + requestIdLength));
  const body = bytes.subarray(2 + requestIdLength);

  if (opcode === FileTransferOpcode.FileBegin) {
    if (body.byteLength < 2) return null;
    const view = new DataView(body.buffer, body.byteOffset, body.byteLength);
    const metadataLength = view.getUint16(0);
    if (metadataLength !== body.byteLength - 2) return null;
    const metadata = parseFileBeginMetadata(decodeUtf8(body.subarray(2)));
    return metadata ? { opcode, requestId, metadata, payload: new Uint8Array() } : null;
  }

  if (opcode === FileTransferOpcode.FileChunk) {
    return { opcode, requestId, payload: body };
  }

  if (body.byteLength !== 0) return null;
  return { opcode, requestId, payload: new Uint8Array() };
}

function parseFileBeginMetadata(raw: string): FileBeginMetadata | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const value = parsed as Record<string, unknown>;
  const mime = typeof value.mime === "string" ? value.mime : null;
  const size =
    typeof value.size === "number" && Number.isInteger(value.size) && value.size >= 0
      ? value.size
      : null;
  const encoding =
    value.encoding === "utf-8" || value.encoding === "binary" ? value.encoding : null;
  const modifiedAt = typeof value.modifiedAt === "string" ? value.modifiedAt : null;
  if (!mime || size === null || !encoding || !modifiedAt) return null;
  return {
    mime,
    size,
    encoding,
    modifiedAt,
    ...(typeof value.revision === "string" ? { revision: value.revision } : {}),
    ...(typeof value.fileName === "string" ? { fileName: value.fileName } : {}),
  };
}

function encodeRequestId(requestId: string): Uint8Array {
  const bytes = encodeUtf8(requestId);
  if (bytes.byteLength === 0) throw new RangeError("File transfer requestId is required");
  if (bytes.byteLength > 0xff) throw new RangeError("File transfer requestId is too long");
  return bytes;
}

function asBytes(data: Uint8Array | ArrayBuffer): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return null;
}
