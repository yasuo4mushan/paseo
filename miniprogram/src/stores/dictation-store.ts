/**
 * 听写会话 store（t32）：豆包式按住说话的完整状态机，非 React、平台无关。
 *
 * 状态流：idle → recording（按下，浮层 + 实时 partial）→ finishing（松手，等
 * daemon final）→ idle（final 文本经 bindInsertText 回调插入 composer 草稿）。
 * recording 中上滑超阈值进入取消态（slideUp），松手不落字（cancel RPC）。
 *
 * 帧管线：begin() 先起录音器（豆包式零延迟起振），WS 侧 dictation_stream_start
 * 的 ack 未到前帧进缓冲，ack 后按 seq 顺序补发再直发；松手先停录音器，onStop
 * 后发 finish(finalSeq=seq-1) 等 final。
 *
 * 依赖注入（平台纪律，同 permissionStore.bindSender 先例）：
 * - installTransport：hook 注入 () => connectionManager.getConnection()；
 *   DaemonConnection 结构化满足 DictationTransport，无适配层。
 * - installAudioSource：hook 注入 recorder-source 工厂（内部用 wx.getRecorderManager）。
 * 事件入口 handleEvent：hook 把 connectionManager.onDictationEvent 接进来。
 *
 * 自动化验收（devtools 模拟器无声卡）：begin({noAudio:true}) 跳过录音器与
 * WS 控制流，仅驱动 UI 状态机；debugInjectPartial/debugInjectFinal 注入
 * partial/final（经 app.ts __automation 桥到达，无 UI 暴露面）。
 */

import { arrayBufferToBase64 } from "@/connection/nacl-box";
import { DICTATION_AUDIO_FORMAT, type DictationStreamEvent } from "@/connection/protocol-types";

export type DictationPhase = "idle" | "recording" | "finishing";

export interface DictationSnapshot {
  phase: DictationPhase;
  /** 中间识别文本（partial 增量替换；空串时 UI 显示「正在聆听…」）。 */
  partialText: string;
  /** 手指上滑超阈值：松手=取消（红色态）。 */
  slideUp: boolean;
  /** 异常中断/未识别提示（页面 toast 后调 dismissError）。 */
  error: string | null;
  /** scope.record 被拒：麦克风按钮置灰。 */
  permissionDenied: boolean;
}

/** WS 侧听写传输（DaemonConnection 结构化实现）。 */
export interface DictationTransport {
  startDictationStream(dictationId: string, format: string): Promise<void>;
  sendDictationStreamChunk(dictationId: string, seq: number, audio: string, format: string): void;
  finishDictationStream(dictationId: string, finalSeq: number): Promise<{ text: string }>;
  cancelDictationStream(dictationId: string): void;
}

export interface DictationAudioSource {
  start(): void;
  stop(): void;
}

export interface DictationAudioHandlers {
  onFrame(buffer: ArrayBuffer): void;
  /** 录音器停止（用户 stop 或 60s duration 上限自动停）。 */
  onStop(): void;
  onError(message: string): void;
}

export type DictationAudioSourceFactory = (
  handlers: DictationAudioHandlers,
) => DictationAudioSource;

/** 60s 自动收尾（对齐 app 端 dictation 时长上限；录音器 duration 同值兜底）。 */
const MAX_DURATION_MS = 60_000;
/** stop() 后等 onStop 的兜底（部分机型 stop 不回 onStop，超时按已停处理）。 */
const RECORDER_STOP_TIMEOUT_MS = 3_000;

function createDictationId(): string {
  return `dic-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

class DictationStore {
  private snapshot: DictationSnapshot = {
    phase: "idle",
    partialText: "",
    slideUp: false,
    error: null,
    permissionDenied: false,
  };
  private listeners = new Set<() => void>();
  private insertText: ((text: string) => void) | null = null;
  private transportFactory: (() => DictationTransport | null) | null = null;
  private audioSourceFactory: DictationAudioSourceFactory | null = null;

  private audio: DictationAudioSource | null = null;
  private dictationId: string | null = null;
  private seq = 0;
  private startAcked = false;
  private startAttempted = false;
  /** start RPC（catch 吞错转 abort；finish 前等它落定，避免 daemon 收到未知流的 finish）。 */
  private startPromise: Promise<void> | null = null;
  private pendingFrames: ArrayBuffer[] = [];
  private maxTimer: ReturnType<typeof setTimeout> | null = null;
  private stopTimer: ReturnType<typeof setTimeout> | null = null;
  /** 自动化：无真实录音器（跳过 WS 控制流，只驱动 UI 状态机）。 */
  private noAudio = false;
  /** 自动化注入的 final 文本（release 时短路真实 finish RPC）。 */
  private finishOverride: string | null = null;

  // ---- 安装/订阅（hook 与页面侧接口） ----

  installTransport(factory: () => DictationTransport | null): void {
    this.transportFactory = factory;
  }

  installAudioSource(factory: DictationAudioSourceFactory): void {
    this.audioSourceFactory = factory;
  }

  /** 页面绑定 final 文本落点（追加到 composer 草稿）；返回解绑函数。 */
  bindInsertText(callback: (text: string) => void): () => void {
    this.insertText = callback;
    return () => {
      if (this.insertText === callback) this.insertText = null;
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): DictationSnapshot {
    return this.snapshot;
  }

  get active(): boolean {
    return this.snapshot.phase !== "idle";
  }

  private set(patch: Partial<DictationSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  setPermissionDenied(denied: boolean): void {
    if (this.snapshot.permissionDenied !== denied) this.set({ permissionDenied: denied });
  }

  dismissError(): void {
    if (this.snapshot.error !== null) this.set({ error: null });
  }

  // ---- 手势驱动（页面 touch 事件翻译进来） ----

  /**
   * 按下麦克风。返回 false = 前置条件不满足（未连接/无传输工厂），错误经
   * snapshot.error 提示。noAudio 仅供自动化注入（见文件头注释）。
   */
  begin(options?: { noAudio?: boolean }): boolean {
    if (this.snapshot.phase !== "idle") return true;
    this.noAudio = options?.noAudio === true;
    if (!this.noAudio) {
      const transport = this.transportFactory?.() ?? null;
      if (!transport) {
        this.set({ error: "连接设备后可使用语音输入" });
        return false;
      }
      if (!this.audioSourceFactory) {
        this.set({ error: "语音输入未就绪" });
        return false;
      }
    }
    this.dictationId = createDictationId();
    this.seq = 0;
    this.startAcked = false;
    this.startAttempted = false;
    this.startPromise = null;
    this.pendingFrames = [];
    this.finishOverride = null;
    this.set({ phase: "recording", partialText: "", slideUp: false, error: null });

    if (this.noAudio) {
      // 自动化路径：不起录音器、不发 WS；partial/final 由注入驱动。
      // 60s 自动收尾也不装——devtools 模拟器渲染慢时单步就可能超过 60s，
      // 定时收尾会把状态机打回 idle 导致后续断言失真（真实路径的 60s 收尾
      // 由单元测试覆盖）。
      return true;
    }

    const transport = this.transportFactory?.();
    const id = this.dictationId;
    if (!transport || !id) {
      this.abort("语音输入未就绪");
      return false;
    }
    this.startAttempted = true;
    this.audio =
      this.audioSourceFactory?.({
        onFrame: (buffer) => this.handleFrame(buffer),
        onStop: () => this.handleRecorderStopped(),
        onError: (message) => this.handleRecorderError(message),
      }) ?? null;
    this.audio?.start();
    // start 与录音并行；ack 前帧入缓冲，ack 后补发（见 handleFrame）。
    // catch 吞错（统一转 abort），保证 startPromise 永不 reject。
    this.startPromise = transport
      .startDictationStream(id, DICTATION_AUDIO_FORMAT)
      .then(() => {
        if (this.dictationId !== id || this.snapshot.phase === "idle") return;
        this.startAcked = true;
        this.flushPendingFrames();
      })
      .catch((err) => {
        if (this.dictationId !== id || this.snapshot.phase === "idle") return;
        this.abort(`听写启动失败：${errorMessage(err)}`);
      });
    this.maxTimer = setTimeout(() => this.release(), MAX_DURATION_MS);
    return true;
  }

  /** 手指上滑位移（px，向上为负）；超阈值进入/退出取消态。 */
  setSlideUp(active: boolean): void {
    if (this.snapshot.phase !== "recording") return;
    if (this.snapshot.slideUp !== active) this.set({ slideUp: active });
  }

  /** 松手：取消态不落字（cancel）；正常态收尾等 final（finishing）。 */
  release(): void {
    if (this.snapshot.phase === "idle") return;
    if (this.snapshot.phase === "recording" && this.snapshot.slideUp) {
      this.cancel();
      return;
    }
    if (this.snapshot.phase !== "recording") return; // finishing 中重复松手忽略
    this.clearTimers();
    this.set({ phase: "finishing" });
    if (this.noAudio) {
      const text = this.finishOverride ?? "";
      this.complete(text);
      return;
    }
    // 停录音器；onStop（或超时兜底）后发 finish。
    this.audio?.stop();
    this.stopTimer = setTimeout(() => this.handleRecorderStopped(), RECORDER_STOP_TIMEOUT_MS);
  }

  /** 上滑取消：不落字，daemon 弃流。 */
  cancel(): void {
    if (this.snapshot.phase === "idle") return;
    this.clearTimers();
    const { id, startAttempted } = this.captureStream();
    this.teardownRecording();
    this.sendCancel(id, startAttempted);
    this.set({ phase: "idle", partialText: "", slideUp: false });
  }

  /** 异常中断（断线/error 推送/录音器错误）：全量复位 + 错误提示。 */
  abort(reason: string): void {
    if (this.snapshot.phase === "idle") return;
    this.clearTimers();
    const { id, startAttempted } = this.captureStream();
    this.teardownRecording();
    this.sendCancel(id, startAttempted);
    this.set({ phase: "idle", partialText: "", slideUp: false, error: reason });
  }

  /** 收尾/中断路径共用：取流标识（teardown 会清字段，先拷贝）。 */
  private captureStream(): { id: string | null; startAttempted: boolean } {
    return { id: this.dictationId, startAttempted: this.startAttempted };
  }

  private sendCancel(id: string | null, startAttempted: boolean): void {
    if (!id || !startAttempted) return;
    try {
      this.transportFactory?.()?.cancelDictationStream(id);
    } catch {
      // cancel 失败静默：daemon 侧流最终会因超时自清理
    }
  }

  // ---- 事件入口（hook 接线：connectionManager.onDictationEvent） ----

  handleEvent(event: DictationStreamEvent): void {
    if (!this.dictationId || event.dictationId !== this.dictationId) return;
    if (event.kind === "partial") {
      if (this.snapshot.phase !== "idle") this.set({ partialText: event.text });
      return;
    }
    if (event.kind === "error") {
      // finish 等待中的错误走 abort（错误文案带 missing 模型提示由 daemon 给出）。
      this.abort(event.error);
    }
    // ack / finish_accepted / final 由 DaemonConnection 等待者消费（final 在
    // finishDictationStream Promise 里返回），这里无需处理。
  }

  // ---- 内部：帧管线与收尾 ----

  private handleFrame(buffer: ArrayBuffer): void {
    if (this.snapshot.phase === "idle" || !this.dictationId) return;
    if (!this.startAcked) {
      this.pendingFrames.push(buffer);
      return;
    }
    this.sendChunk(buffer);
  }

  private sendChunk(buffer: ArrayBuffer): void {
    const transport = this.transportFactory?.();
    if (!transport || !this.dictationId) return;
    try {
      transport.sendDictationStreamChunk(
        this.dictationId,
        this.seq,
        arrayBufferToBase64(buffer),
        DICTATION_AUDIO_FORMAT,
      );
      this.seq += 1;
    } catch {
      // 单帧发送失败丢弃（socket 缓冲满等瞬时问题），不中断会话
    }
  }

  private flushPendingFrames(): void {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    for (const frame of frames) {
      if (this.snapshot.phase === "idle") return;
      this.sendChunk(frame);
    }
  }

  private handleRecorderStopped(): void {
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
    if (this.snapshot.phase === "idle") return;
    if (this.snapshot.phase === "recording") {
      // 录音器 60s duration 自动停：按正常松手收尾。
      this.clearTimers();
      this.set({ phase: "finishing" });
    }
    // start ack 未落定（立刻松手的竞态）：先等它（缓冲帧补发完后 finalSeq 才
    // 正确）；start 失败路径已被 abort（phase 回 idle），proceed 会空转。
    if (this.startAttempted && !this.startAcked && this.startPromise) {
      void this.startPromise.then(() => this.finishAfterStop());
      return;
    }
    this.finishAfterStop();
  }

  private finishAfterStop(): void {
    if (this.snapshot.phase === "idle") return;
    const id = this.dictationId;
    const finalSeq = this.seq - 1;
    if (!id || finalSeq < 0) {
      // 一帧都没发出去（立刻松手/未授权）：不发 finish（finalSeq 非负约束），空收尾。
      this.complete("");
      return;
    }
    const transport = this.transportFactory?.();
    if (!transport) {
      this.abort("连接已断开");
      return;
    }
    transport
      .finishDictationStream(id, finalSeq)
      .then((result) => this.complete(result.text))
      .catch((err) => this.abort(`识别失败：${errorMessage(err)}`));
  }

  private handleRecorderError(message: string): void {
    if (/auth|deny|denied|permission/i.test(message)) {
      this.set({ permissionDenied: true });
      this.abort("麦克风权限被拒绝");
      return;
    }
    this.abort(`录音失败：${message}`);
  }

  /** 收尾落袋：非空文本插入 composer；空文本给出「未识别到内容」提示。 */
  private complete(text: string): void {
    this.teardownRecording();
    const trimmed = text.trim();
    if (trimmed) {
      this.insertText?.(trimmed);
      this.set({ phase: "idle", partialText: "", slideUp: false });
    } else {
      this.set({ phase: "idle", partialText: "", slideUp: false, error: "未识别到内容" });
    }
  }

  private teardownRecording(): void {
    if (this.audio) {
      try {
        this.audio.stop();
      } catch {
        // 已停/未起的 stop 抛错忽略
      }
      this.audio = null;
    }
    this.dictationId = null;
    this.seq = 0;
    this.startAcked = false;
    this.startAttempted = false;
    this.startPromise = null;
    this.pendingFrames = [];
    this.finishOverride = null;
    this.noAudio = false;
  }

  private clearTimers(): void {
    if (this.maxTimer) {
      clearTimeout(this.maxTimer);
      this.maxTimer = null;
    }
    if (this.stopTimer) {
      clearTimeout(this.stopTimer);
      this.stopTimer = null;
    }
  }

  // ---- 自动化注入（仅经 app.ts __automation 桥调用；无生产调用方） ----

  debugInjectPartial(text: string): void {
    if (this.snapshot.phase === "recording") this.set({ partialText: text });
  }

  debugInjectFinal(text: string): void {
    this.finishOverride = text;
    if (this.noAudio && this.snapshot.phase === "finishing") this.complete(text);
  }
}

export const dictationStore = new DictationStore();
