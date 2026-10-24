/**
 * 集成测试（t32）：流式听写全链路 —— 与 app 同一份 miniprogram connection 代码，
 * 直连隔离 daemon（默认 ws://127.0.0.1:6787/ws，PASEO_HOME=/tmp/t32b-home），
 * 把真实英文语音 PCM（16k/16bit/mono）分片推上去，断言收到 partial/final 事件
 * 且 final 文本非空。证明协议形状、base64 分片、seq 计数、事件路由全链路正确。
 *
 * 环境自备（daemon 不在则整文件 skip，与 integration-daemon.test.ts 同约定）：
 *   - 隔离 daemon（develop-xdb 构建，模型 parakeet 英文 STT 已就位）：
 *       PASEO_HOME=/tmp/t32b-home PASEO_LISTEN=127.0.0.1:6787 \
 *         node packages/server/dist/scripts/supervisor-entrypoint.js
 *   - STT 模型（daemon 首启后台下载，或手动 curl 解压到
 *     /tmp/t32b-home/models/local-speech/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8）
 *   - 语音 fixture（macOS 本地生成）：
 *       say -v Samantha "hello, please create a new branch and check out the changes" \
 *         -o /tmp/t32b-dictation.aiff
 *       afconvert -f WAVE -d LEI16@16000 -c 1 \
 *         /tmp/t32b-dictation.aiff /tmp/t32b-dictation.wav
 *   - 运行：PASEO_MP_TEST_DAEMON_URL=ws://127.0.0.1:6787/ws \
 *       npx vitest run tests/integration-dictation.test.ts
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { DaemonConnection } from "../src/connection/daemon-connection";
import {
  DICTATION_AUDIO_FORMAT,
  type DictationStreamEvent,
} from "../src/connection/protocol-types";
import { installSystemRandomSource } from "../src/connection/random-source";
import { arrayBufferToBase64 } from "../src/connection/nacl-box";
import { createNodeSocket } from "./helpers/node-socket";

installSystemRandomSource();

const DAEMON_URL = process.env.PASEO_MP_TEST_DAEMON_URL ?? "ws://127.0.0.1:6787/ws";
const WAV_PATH = process.env.PASEO_MP_TEST_DICTATION_WAV ?? "/tmp/t32b-dictation.wav";
/** 44 = 标准 RIFF/PCM wav 头（afconvert 产物，取前 44 字节后即裸 PCM）。 */
const WAV_HEADER_BYTES = 44;

function isDaemonReachable(url: URL, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: url.hostname, port: Number(url.port), timeout: timeoutMs });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.on("connect", () => done(true));
    socket.on("timeout", () => done(false));
    socket.on("error", () => done(false));
  });
}

/** wav → 16k/16bit/mono PCM 帧（~400ms/帧，对齐小程序 frameSize 13KB 的节奏）。 */
function pcmChunksFromWav(): Uint8Array[] {
  const wav = readFileSync(WAV_PATH);
  if (wav.subarray(0, 4).toString("latin1") !== "RIFF") throw new Error("fixture 不是 wav");
  const pcm = wav.subarray(WAV_HEADER_BYTES);
  const frameBytes = 32000 * 0.4; // 12800 字节/帧
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < pcm.length; offset += frameBytes) {
    chunks.push(pcm.subarray(offset, Math.min(offset + frameBytes, pcm.length)));
  }
  return chunks;
}

const reachable = await isDaemonReachable(new URL(DAEMON_URL));
const fixtureReady = existsSync(WAV_PATH);

describe.skipIf(!reachable || !fixtureReady)("集成：流式听写全链路（隔离 daemon）", () => {
  it("start → 分片推流 → partial 至少一条 → final 文本非空", async () => {
    const events: DictationStreamEvent[] = [];
    const conn = new DaemonConnection(
      () => createNodeSocket(DAEMON_URL),
      { clientId: "mp-t32-dictation", clientType: "mobile" },
      { onDictationEvent: (event) => events.push(event) },
    );
    const info = await conn.connect();
    expect(info.serverId).toMatch(/^srv_/);

    const dictationId = `dic-it-${Date.now().toString(36)}`;
    const chunks = pcmChunksFromWav();
    expect(chunks.length).toBeGreaterThan(4);

    // start：等启动 ack（首次使用 daemon 会加载 STT 模型，给足超时）
    await conn.startDictationStream(dictationId, DICTATION_AUDIO_FORMAT, 60_000);

    // 分片推流（seq 从 0 递增；帧间 60ms 模拟真实录音节奏）
    let seq = 0;
    for (const chunk of chunks) {
      conn.sendDictationStreamChunk(
        dictationId,
        seq,
        arrayBufferToBase64(chunk),
        DICTATION_AUDIO_FORMAT,
      );
      seq += 1;
      await new Promise((resolve) => setTimeout(resolve, 60));
    }

    // finish：等 final（离线模型要吃完全部音频再出全文，60s 足够）
    const result = await conn.finishDictationStream(dictationId, seq - 1, 60_000);
    console.log(`[t32 集成] final transcript: ${JSON.stringify(result.text)}`);
    console.log(`[t32 集成] 事件序列: ${events.map((e) => e.kind).join(",") || "(无)"}`);

    expect(typeof result.text).toBe("string");
    expect(result.text.trim().length).toBeGreaterThan(0);
    // 全链路证据：final 事件也走广播路径（daemon-connection 事件路由）
    expect(events.some((e) => e.kind === "final" && e.text === result.text)).toBe(true);

    conn.close();
  }, 180_000);

  it("cancel：未 finish 直接取消不落 final", async () => {
    const events: DictationStreamEvent[] = [];
    const conn = new DaemonConnection(
      () => createNodeSocket(DAEMON_URL),
      { clientId: "mp-t32-dictation-cancel" },
      { onDictationEvent: (event) => events.push(event) },
    );
    await conn.connect();
    const dictationId = `dic-it-cancel-${Date.now().toString(36)}`;
    await conn.startDictationStream(dictationId, DICTATION_AUDIO_FORMAT, 60_000);
    const frame = new Uint8Array(3200); // 100ms 静音帧
    conn.sendDictationStreamChunk(
      dictationId,
      0,
      arrayBufferToBase64(frame),
      DICTATION_AUDIO_FORMAT,
    );
    conn.cancelDictationStream(dictationId);
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(events.some((e) => e.kind === "final")).toBe(false);
    conn.close();
  }, 90_000);
});
