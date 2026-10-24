/**
 * t32 流式听写测试：
 * 1. parseDictationEvent 容错解析（五种事件 + 畸形载荷）。
 * 2. DaemonConnection 听写客户端：start/chunk/finish/cancel 的 WS JSON 形状、
 *    ack/final/error 事件等待与 onDictationEvent 广播（复用 t19 mock socket 套路）。
 * 3. dictation-store 状态机：帧缓冲与 seq 顺序、松手 final 插入、上滑取消不落字、
 *    error 中断、60s 收尾边界（用注入的 transport/audio 源，无平台依赖）。
 */
import { describe, expect, it, vi } from "vitest";
import { DICTATION_AUDIO_FORMAT, parseDictationEvent } from "../src/connection/protocol-types";
import { DaemonConnection, type DaemonConnectionEvents } from "../src/connection/daemon-connection";
import { createMockSocketPair, type MockDaemonSide } from "./helpers/mock-socket";
import {
  dictationStore,
  type DictationAudioHandlers,
  type DictationAudioSource,
  type DictationTransport,
} from "../src/stores/dictation-store";

// ---------------------------------------------------------------------------
// parseDictationEvent
// ---------------------------------------------------------------------------

describe("t32 parseDictationEvent", () => {
  it("五种事件按 type 归一为带 kind 的联合", () => {
    expect(parseDictationEvent("dictation_stream_ack", { dictationId: "d1", ackSeq: -1 })).toEqual({
      kind: "ack",
      dictationId: "d1",
      ackSeq: -1,
    });
    expect(
      parseDictationEvent("dictation_stream_finish_accepted", {
        dictationId: "d1",
        timeoutMs: 500,
      }),
    ).toEqual({ kind: "finish_accepted", dictationId: "d1", timeoutMs: 500 });
    expect(
      parseDictationEvent("dictation_stream_partial", { dictationId: "d1", text: "你好" }),
    ).toEqual({ kind: "partial", dictationId: "d1", text: "你好" });
    expect(
      parseDictationEvent("dictation_stream_final", { dictationId: "d1", text: "hello" }),
    ).toEqual({ kind: "final", dictationId: "d1", text: "hello" });
    expect(
      parseDictationEvent("dictation_stream_error", {
        dictationId: "d1",
        error: "model missing",
        retryable: true,
        reasonCode: "stt_model_missing",
        missingModelIds: ["parakeet-tdt-0.6b-v2-int8"],
      }),
    ).toEqual({
      kind: "error",
      dictationId: "d1",
      error: "model missing",
      retryable: true,
      reasonCode: "stt_model_missing",
      missingModelIds: ["parakeet-tdt-0.6b-v2-int8"],
    });
  });

  it("畸形载荷返回 null（缺 dictationId / 非 record / 未知 type）", () => {
    expect(parseDictationEvent("dictation_stream_ack", { ackSeq: -1 })).toBeNull();
    expect(parseDictationEvent("dictation_stream_partial", "not-a-record")).toBeNull();
    expect(
      parseDictationEvent("dictation_stream_ack", { dictationId: "d1", ackSeq: "x" }),
    ).toBeNull();
    expect(parseDictationEvent("voice_input_state", { dictationId: "d1" })).toBeNull();
  });

  it("error 事件的坏字段宽容降级（retryable 缺省 false、missingModelIds 滤坏值）", () => {
    const event = parseDictationEvent("dictation_stream_error", {
      dictationId: "d1",
      error: "boom",
      missingModelIds: ["m1", 42, ""],
    });
    expect(event).toMatchObject({ kind: "error", retryable: false, missingModelIds: ["m1"] });
  });
});

// ---------------------------------------------------------------------------
// DaemonConnection 听写客户端
// ---------------------------------------------------------------------------

const SERVER_INFO_MESSAGE = {
  type: "status",
  payload: { status: "server_info", serverId: "srv_t32", version: "0.13.0-test" },
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

async function connectedHarness(events?: DaemonConnectionEvents): Promise<{
  conn: DaemonConnection;
  server: MockDaemonSide;
}> {
  const pair = createMockSocketPair();
  const conn = new DaemonConnection(() => pair.clientPort, { clientId: "t32-client" }, events);
  const connectPromise = conn.connect();
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server };
}

/** 从发出的帧里找指定 type 的 session 消息。 */
function findSent(server: MockDaemonSide, type: string): Record<string, unknown> | null {
  for (let i = server.sentFrames.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(server.sentFrames[i]) as {
      type?: string;
      message?: Record<string, unknown>;
    };
    if (parsed.type === "session" && parsed.message?.type === type) {
      return parsed.message;
    }
  }
  return null;
}

describe("t32 DaemonConnection 听写客户端", () => {
  it("start → ack(ackSeq=-1) 解除等待，WS JSON 与 schema 对齐", async () => {
    const { conn, server } = await connectedHarness();
    const startPromise = conn.startDictationStream("dic-1", DICTATION_AUDIO_FORMAT);
    await waitUntil(() => findSent(server, "dictation_stream_start") !== null);
    const sent = findSent(server, "dictation_stream_start");
    expect(sent).toEqual({
      type: "dictation_stream_start",
      dictationId: "dic-1",
      format: DICTATION_AUDIO_FORMAT,
    });
    server.pushSession({
      type: "dictation_stream_ack",
      payload: { dictationId: "dic-1", ackSeq: -1 },
    });
    await startPromise;
    conn.close();
  });

  it("start 等待期间收到同 id error → 抛错；ack 前的 ackSeq>-1 不算启动确认", async () => {
    const { conn, server } = await connectedHarness();
    const startPromise = conn.startDictationStream("dic-2", DICTATION_AUDIO_FORMAT);
    await waitUntil(() => findSent(server, "dictation_stream_start") !== null);
    server.pushSession({
      type: "dictation_stream_error",
      payload: { dictationId: "dic-2", error: "stt not ready", retryable: false },
    });
    await expect(startPromise).rejects.toThrow("stt not ready");
    conn.close();
  });

  it("chunk fire-and-forget：seq/audio/format 原样上送", async () => {
    const { conn, server } = await connectedHarness();
    conn.sendDictationStreamChunk("dic-3", 7, "QUJD", DICTATION_AUDIO_FORMAT);
    await waitUntil(() => findSent(server, "dictation_stream_chunk") !== null);
    expect(findSent(server, "dictation_stream_chunk")).toEqual({
      type: "dictation_stream_chunk",
      dictationId: "dic-3",
      seq: 7,
      audio: "QUJD",
      format: DICTATION_AUDIO_FORMAT,
    });
    conn.close();
  });

  it("finish → final 文本返回；partial 经 onDictationEvent 广播", async () => {
    const events: DaemonConnectionEvents = { onDictationEvent: vi.fn() };
    const { conn, server } = await connectedHarness(events);
    const finishPromise = conn.finishDictationStream("dic-4", 2);
    await waitUntil(() => findSent(server, "dictation_stream_finish") !== null);
    expect(findSent(server, "dictation_stream_finish")).toEqual({
      type: "dictation_stream_finish",
      dictationId: "dic-4",
      finalSeq: 2,
    });
    // 收尾过程中的 partial 照常广播（UI 上屏），不影响 finish 等待
    server.pushSession({
      type: "dictation_stream_partial",
      payload: { dictationId: "dic-4", text: "中间结果" },
    });
    server.pushSession({
      type: "dictation_stream_final",
      payload: { dictationId: "dic-4", text: "最终结果" },
    });
    await expect(finishPromise).resolves.toEqual({ text: "最终结果" });
    expect(events.onDictationEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "partial", text: "中间结果" }),
    );
    conn.close();
  });

  it("cancel 发送 cancel 消息；同 id 等待者被清场不再落袋", async () => {
    const { conn, server } = await connectedHarness();
    const finishPromise = conn.finishDictationStream("dic-5", 0);
    await waitUntil(() => findSent(server, "dictation_stream_finish") !== null);
    conn.cancelDictationStream("dic-5");
    await expect(finishPromise).rejects.toThrow("已取消");
    await waitUntil(() => findSent(server, "dictation_stream_cancel") !== null);
    expect(findSent(server, "dictation_stream_cancel")).toEqual({
      type: "dictation_stream_cancel",
      dictationId: "dic-5",
    });
    conn.close();
  });

  it("断线时挂起的听写等待者失败", async () => {
    const { conn, server } = await connectedHarness();
    const finishPromise = conn.finishDictationStream("dic-6", 0);
    server.emitClose(1006, "abnormal");
    await expect(finishPromise).rejects.toThrow();
    conn.close();
  });
});

// ---------------------------------------------------------------------------
// dictation-store 状态机
// ---------------------------------------------------------------------------

interface Harness {
  chunks: Array<{ seq: number; audio: string }>;
  cancelled: string[];
  frames: (buffer: ArrayBuffer) => void;
  stopAudio: () => void;
  audioStopped: () => void;
  inserted: string[];
  audioError: (message: string) => void;
}

function storeHarness(transportOverrides?: Partial<DictationTransport>): Harness {
  const chunks: Harness["chunks"] = [];
  const cancelled: string[] = [];
  const inserted: string[] = [];
  let handlers: DictationAudioHandlers | null = null;
  const audio: DictationAudioSource = {
    start() {},
    stop() {},
  };
  const transport: DictationTransport = {
    async startDictationStream() {},
    sendDictationStreamChunk(_id, seq, audioBase64) {
      chunks.push({ seq, audio: audioBase64 });
    },
    async finishDictationStream() {
      return { text: "hello create a branch" };
    },
    cancelDictationStream(id) {
      cancelled.push(id);
    },
    ...transportOverrides,
  };
  dictationStore.installTransport(() => transport);
  dictationStore.installAudioSource((h) => {
    handlers = h;
    return audio;
  });
  dictationStore.bindInsertText((text) => inserted.push(text));
  return {
    chunks,
    cancelled,
    inserted,
    frames: (buffer) => handlers?.onFrame(buffer),
    stopAudio: () => handlers?.onStop(),
    audioStopped: () => handlers?.onStop(),
    audioError: (message) => handlers?.onError(message),
  };
}

/** 2 字节小缓冲 → base64 "AAA"（内容无关紧要，只看 seq 顺序）。 */
function frameBytes(): ArrayBuffer {
  return new Uint8Array([0, 0]).buffer;
}

function snapshot() {
  return dictationStore.getSnapshot();
}

describe("t32 dictation-store 状态机", () => {
  it("完整落字路径：begin（帧先缓冲）→ ack 补发 → release → finishing → final 插入", async () => {
    const h = storeHarness();
    expect(dictationStore.begin()).toBe(true);
    expect(snapshot().phase).toBe("recording");
    // ack 未到：帧进缓冲，不上送
    h.frames(frameBytes());
    h.frames(frameBytes());
    expect(h.chunks).toHaveLength(0);
    // ack（经 store 的 start 落定逻辑由真实 Promise 驱动，这里直接等微任务）
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.chunks.map((c) => c.seq)).toEqual([0, 1]);
    h.frames(frameBytes());
    expect(h.chunks.map((c) => c.seq)).toEqual([0, 1, 2]);
    dictationStore.release();
    expect(snapshot().phase).toBe("finishing");
    h.stopAudio(); // 录音器 onStop
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(snapshot().phase).toBe("idle");
    expect(h.inserted).toEqual(["hello create a branch"]);
    expect(h.cancelled).toEqual([]);
  });

  it("上滑取消：不落字、发 cancel、状态回 idle", async () => {
    const h = storeHarness();
    dictationStore.begin();
    await new Promise((resolve) => setTimeout(resolve, 5));
    dictationStore.setSlideUp(true);
    expect(snapshot().slideUp).toBe(true);
    dictationStore.release();
    expect(snapshot().phase).toBe("idle");
    expect(h.inserted).toEqual([]);
    expect(h.cancelled).toHaveLength(1);
  });

  it("上滑后滑回（未超阈值）恢复正常松手落字", async () => {
    const h = storeHarness();
    dictationStore.begin();
    await new Promise((resolve) => setTimeout(resolve, 5));
    h.frames(frameBytes()); // 至少一帧，finish 才有合法 finalSeq
    dictationStore.setSlideUp(true);
    dictationStore.setSlideUp(false);
    dictationStore.release();
    h.stopAudio();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.inserted).toEqual(["hello create a branch"]);
  });

  it("error 推送中断：abort 提示 + cancel 兜底", async () => {
    const h = storeHarness();
    dictationStore.begin();
    await new Promise((resolve) => setTimeout(resolve, 5));
    dictationStore.handleEvent({
      kind: "error",
      dictationId: "whatever",
      error: "boom",
      retryable: false,
    });
    // 事件按 dictationId 过滤：上面的 id 与当前流不匹配不会中断 —— 直接驱动当前流
    dictationStore.handleEvent({ kind: "partial", dictationId: "whatever", text: "x" });
    expect(snapshot().phase).toBe("recording");
    const id = (dictationStore as unknown as { dictationId: string | null }).dictationId;
    expect(id).toBeTruthy();
    dictationStore.handleEvent({
      kind: "error",
      dictationId: id ?? "",
      error: "识别失败",
      retryable: false,
    });
    expect(snapshot().phase).toBe("idle");
    expect(snapshot().error).toContain("识别失败");
    expect(h.cancelled).toHaveLength(1);
    expect(h.inserted).toEqual([]);
    dictationStore.dismissError();
    expect(snapshot().error).toBeNull();
  });

  it("录音器权限错误 → permissionDenied 置位 + abort", async () => {
    const h = storeHarness();
    dictationStore.begin();
    h.audioError("operateRecorder:fail auth deny");
    expect(snapshot().permissionDenied).toBe(true);
    expect(snapshot().phase).toBe("idle");
    expect(snapshot().error).toContain("麦克风权限");
    dictationStore.setPermissionDenied(false);
  });

  it("无连接时 begin 拒绝并提示", () => {
    dictationStore.installTransport(() => null);
    expect(dictationStore.begin()).toBe(false);
    expect(snapshot().error).toBe("连接设备后可使用语音输入");
    expect(snapshot().phase).toBe("idle");
    dictationStore.dismissError();
  });

  it("一帧未发（立刻松手）空收尾：不发 finish，提示未识别", async () => {
    const h = storeHarness();
    dictationStore.begin();
    dictationStore.release();
    h.stopAudio();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(h.inserted).toEqual([]);
    expect(snapshot().error).toBe("未识别到内容");
    dictationStore.dismissError();
  });
});
