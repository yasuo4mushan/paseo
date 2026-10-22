/**
 * t17 文件浏览 / 上传 / 下载状态机单测：DaemonConnection 在内存 socket 上验证
 * - listDirectory 请求形状与响应解析（目录排序）
 * - readFile 二进制帧流（Begin/Chunk/End → FileReadResult；进度回调）
 * - readFile legacy JSON 路径（base64 内容）
 * - readFile 错误路径（JSON error / 帧数不完整 / maxBytes 超限）
 * - uploadFile：JSON 头 + Begin/Chunk/End 帧 + 响应解析
 * - sendAgentMessage 携带 uploaded_file 附件
 */
import { describe, expect, it } from "vitest";
import { DaemonConnection } from "../src/connection/daemon-connection";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "../src/connection/file-transfer-frames";
import { encodeUtf8 } from "../src/connection/utf8";
import { arrayBufferToBase64 } from "../src/connection/nacl-box";
import { createMockSocketPair, type MockDaemonSide } from "./helpers/mock-socket";

const SERVER_INFO_MESSAGE = {
  type: "status",
  payload: { status: "server_info", serverId: "srv_files", version: "0.12.0-test" },
};

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitUntil timeout"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function connectedFilesHarness(): Promise<{
  conn: DaemonConnection;
  server: MockDaemonSide;
}> {
  const pair = createMockSocketPair();
  const conn = new DaemonConnection(() => pair.clientPort, { clientId: "t17-client" });
  const connectPromise = conn.connect();
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server };
}

/** 服务端把目录列表回给指定 requestId。 */
function pushListResponse(server: MockDaemonSide, requestId: string, entries: unknown[]) {
  server.pushSession({
    type: "file_explorer_response",
    payload: {
      cwd: "/ws",
      path: ".",
      mode: "list",
      directory: { path: ".", entries },
      file: null,
      error: null,
      requestId,
    },
  });
}

/** 服务端以二进制帧流回文件（成功路径：无 JSON 响应）。 */
function pushFileFrames(
  server: MockDaemonSide,
  requestId: string,
  content: Uint8Array,
  metadataOverrides: Record<string, unknown> = {},
) {
  server.pushBinary(
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId,
      metadata: {
        mime: "text/plain",
        size: content.byteLength,
        encoding: "utf-8",
        modifiedAt: "2026-10-22T01:00:00Z",
        ...metadataOverrides,
      },
    }),
  );
  for (let offset = 0; offset < content.byteLength; offset += 4) {
    server.pushBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: content.subarray(offset, Math.min(offset + 4, content.byteLength)),
      }),
    );
  }
  server.pushBinary(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
}

describe("t17 files: listDirectory", () => {
  it("发送 file_explorer_request mode:list 并解析排序后的目录", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.listDirectory("/ws", ".");
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const request = server.lastRequest();
    expect(request?.mode).toBe("list");
    expect(request?.cwd).toBe("/ws");
    pushListResponse(server, request!.requestId, [
      {
        name: "zeta.md",
        path: "zeta.md",
        kind: "file",
        size: 10,
        modifiedAt: "2026-01-01T00:00:00Z",
      },
      { name: "src", path: "src", kind: "directory", size: 0, modifiedAt: "2026-01-02T00:00:00Z" },
      {
        name: "Alpha.ts",
        path: "Alpha.ts",
        kind: "file",
        size: 20,
        modifiedAt: "2026-01-03T00:00:00Z",
      },
      {
        name: "readme.md",
        path: "readme.md",
        kind: "file",
        size: 5,
        modifiedAt: "2026-01-04T00:00:00Z",
      },
    ]);
    const entries = await pending;
    expect(entries.map((e) => e.name)).toEqual(["src", "Alpha.ts", "readme.md", "zeta.md"]);
  });

  it("error 响应抛错", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.listDirectory("/ws", "nope");
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const requestId = server.lastRequest()!.requestId;
    server.pushSession({
      type: "file_explorer_response",
      payload: {
        cwd: "/ws",
        path: "nope",
        mode: "list",
        directory: null,
        file: null,
        error: "ENOENT",
        requestId,
      },
    });
    await expect(pending).rejects.toThrow("ENOENT");
  });
});

describe("t17 files: readFile 二进制通道", () => {
  it("Begin/Chunk/End 帧组装为 FileReadResult（含进度）", async () => {
    const { conn, server } = await connectedFilesHarness();
    const progress: Array<[number, number]> = [];
    const pending = conn.readFile({
      cwd: "/ws",
      path: "hello.txt",
      onProgress: (r, t) => progress.push([r, t]),
    });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const request = server.lastRequest();
    expect(request?.mode).toBe("file");
    expect(request?.acceptBinary).toBe(true);
    pushFileFrames(server, request!.requestId, encodeUtf8("hello files"));
    const result = await pending;
    expect(new TextDecoder().decode(result.bytes)).toBe("hello files");
    expect(result.kind).toBe("text");
    expect(result.mime).toBe("text/plain");
    expect(result.size).toBe(11);
    // 进度单调，最终到 size
    expect(progress[progress.length - 1]).toEqual([11, 11]);
  });

  it("图片 mime 判定为 image，encoding binary", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.readFile({ cwd: "/ws", path: "logo.png" });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const requestId = server.lastRequest()!.requestId;
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    pushFileFrames(server, requestId, png, { mime: "image/png", encoding: "binary" });
    const result = await pending;
    expect(result.kind).toBe("image");
    expect(result.bytes.byteLength).toBe(png.byteLength);
  });

  it("legacy JSON 路径：base64 内容解码为字节", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.readFile({ cwd: "/ws", path: "legacy.txt" });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const requestId = server.lastRequest()!.requestId;
    const content = encodeUtf8("legacy path");
    server.pushSession({
      type: "file_explorer_response",
      payload: {
        cwd: "/ws",
        path: "legacy.txt",
        mode: "file",
        directory: null,
        file: {
          path: "legacy.txt",
          kind: "text",
          encoding: "base64",
          content: arrayBufferToBase64(content),
          mimeType: "text/plain",
          size: content.byteLength,
          modifiedAt: "2026-10-22T02:00:00Z",
        },
        error: null,
        requestId,
      },
    });
    const result = await pending;
    expect(new TextDecoder().decode(result.bytes)).toBe("legacy path");
  });

  it("JSON error 响应拒绝（如文件过大）", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.readFile({ cwd: "/ws", path: "big.bin", maxBytes: 1024 });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const request = server.lastRequest();
    expect(request?.maxBytes).toBe(1024);
    server.pushSession({
      type: "file_explorer_response",
      payload: {
        cwd: "/ws",
        path: "big.bin",
        mode: "file",
        directory: null,
        file: null,
        error: "File is too large to display",
        requestId: request!.requestId,
      },
    });
    await expect(pending).rejects.toThrow("File is too large to display");
  });

  it("End 帧字节不齐拒绝（传输不完整）", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.readFile({ cwd: "/ws", path: "partial.txt" });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const requestId = server.lastRequest()!.requestId;
    const requestId2 = server.lastRequest()!.requestId;
    expect(requestId2).toBe(requestId);
    // 声明 10 字节但只发 4 字节
    server.pushBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: "text/plain",
          size: 10,
          encoding: "utf-8",
          modifiedAt: "2026-10-22T00:00:00Z",
        },
      }),
    );
    server.pushBinary(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId,
        payload: encodeUtf8("abcd"),
      }),
    );
    server.pushBinary(encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }));
    await expect(pending).rejects.toThrow("文件传输不完整");
  });

  it("COMPAT(fileReadByteBudget)：老 daemon 无视 maxBytes 推流时，End 转为过大错误", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.readFile({ cwd: "/ws", path: "huge.txt", maxBytes: 8 });
    await waitUntil(() => server.lastRequest()?.type === "file_explorer_request");
    const requestId = server.lastRequest()!.requestId;
    pushFileFrames(server, requestId, encodeUtf8("way more than eight bytes"), {
      size: 26,
    });
    await expect(pending).rejects.toThrow("文件过大");
  });
});

describe("t17 files: uploadFile", () => {
  it("发送 JSON 头 + Begin/Chunk/End 帧，解析响应为 uploaded_file", async () => {
    const { conn, server } = await connectedFilesHarness();
    const bytes = encodeUtf8("PNGDATA".repeat(3)); // 21 字节，chunk 8 → 3 片
    const pending = conn.uploadFile({
      fileName: "pic.png",
      mimeType: "image/png",
      bytes,
      chunkSize: 8,
    });
    await waitUntil(() => server.lastRequest()?.type === "file.upload.request");
    const request = server.lastRequest();
    expect(request?.fileName).toBe("pic.png");
    expect(request?.size).toBe(bytes.byteLength);
    expect(typeof request?.modifiedAt).toBe("string");
    await waitUntil(() => server.sentBinaryFrames.length >= 5);
    // 帧序：Begin, Chunk x3, End
    const frames = server.sentBinaryFrames.map((b) => new Uint8Array(b));
    expect(frames.length).toBe(5);
    expect(frames[0][0]).toBe(FileTransferOpcode.FileBegin);
    expect(frames[1][0]).toBe(FileTransferOpcode.FileChunk);
    expect(frames[2][0]).toBe(FileTransferOpcode.FileChunk);
    expect(frames[3][0]).toBe(FileTransferOpcode.FileChunk);
    expect(frames[4][0]).toBe(FileTransferOpcode.FileEnd);

    server.pushSession({
      type: "file.upload.response",
      payload: {
        requestId: request!.requestId,
        file: {
          type: "uploaded_file",
          id: "upload_123",
          fileName: "pic.png",
          mimeType: "image/png",
          size: bytes.byteLength,
          path: "/home/.paseo/uploads/upload_123/pic.png",
        },
        error: null,
      },
    });
    const uploaded = await pending;
    expect(uploaded.id).toBe("upload_123");
    expect(uploaded.type).toBe("uploaded_file");
    expect(uploaded.path).toContain("uploads");
  });

  it("上传失败（error 响应）抛错", async () => {
    const { conn, server } = await connectedFilesHarness();
    const pending = conn.uploadFile({
      fileName: "bad.txt",
      mimeType: "text/plain",
      bytes: encodeUtf8("xx"),
    });
    await waitUntil(() => server.lastRequest()?.type === "file.upload.request");
    const requestId = server.lastRequest()!.requestId;
    await waitUntil(() => server.sentBinaryFrames.length >= 3);
    server.pushSession({
      type: "file.upload.response",
      payload: { requestId, file: null, error: "Upload size mismatch" },
    });
    await expect(pending).rejects.toThrow("Upload size mismatch");
  });

  it("sendAgentMessage 携带附件与 messageId", async () => {
    const { conn, server } = await connectedFilesHarness();
    const attachment = {
      type: "uploaded_file" as const,
      id: "upload_9",
      fileName: "pic.png",
      mimeType: "image/png",
      size: 3,
      path: "/uploads/upload_9/pic.png",
    };
    const pending = conn.sendAgentMessage("agent-1", "看这张图", {
      messageId: "cmid-1",
      attachments: [attachment],
    });
    await waitUntil(() => server.lastRequest()?.type === "send_agent_message_request");
    const request = server.lastRequest();
    expect(request?.messageId).toBe("cmid-1");
    expect(request?.attachments).toEqual([attachment]);
    server.pushSession({
      type: "send_agent_message_response",
      payload: { requestId: request!.requestId, agentId: "agent-1", accepted: true, error: null },
    });
    const result = await pending;
    expect(result.accepted).toBe(true);
  });
});
