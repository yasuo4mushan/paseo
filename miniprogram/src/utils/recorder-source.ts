/**
 * 录音音频源（t32）：wx.getRecorderManager 的平台封装，喂给 dictation-store。
 *
 * - PCM 16kHz/16bit/单声道（daemon sherpa STT 输入），frameSize 13KB ≈ 416ms/帧。
 * - RecorderManager 是全局单例，事件只绑一次；同一时刻只有一个会话占用
 *   （dictation-store 保证 phase 互斥）。
 * - recorder duration 60s 与 store 的 MAX_DURATION_MS 同值：到点自动 onStop，
 *   store 把它当正常松手收尾（双保险，谁先到都收敛到同一路径）。
 */

import Taro from "@tarojs/taro";
import type { DictationAudioHandlers, DictationAudioSource } from "@/stores/dictation-store";

interface RecorderFrameEvent {
  frameBuffer: ArrayBuffer;
  isLastFrame?: boolean;
}

interface RecorderErrorEvent {
  errMsg?: string;
}

type Manager = {
  start(options: Record<string, unknown>): void;
  stop(): void;
  onFrameRecorded(callback: (res: RecorderFrameEvent) => void): void;
  onStop(callback: () => void): void;
  onError(callback: (err: RecorderErrorEvent) => void): void;
};

let manager: Manager | null = null;
let activeHandlers: DictationAudioHandlers | null = null;

function ensureManager(): Manager {
  if (manager) return manager;
  const recorder = Taro.getRecorderManager() as unknown as Manager;
  recorder.onFrameRecorded((res) => {
    if (res?.frameBuffer && activeHandlers) activeHandlers.onFrame(res.frameBuffer);
  });
  recorder.onStop(() => {
    activeHandlers?.onStop();
  });
  recorder.onError((err) => {
    activeHandlers?.onError(err?.errMsg ?? "recorder error");
  });
  manager = recorder;
  return recorder;
}

export function createRecorderAudioSource(handlers: DictationAudioHandlers): DictationAudioSource {
  return {
    start() {
      const recorder = ensureManager();
      activeHandlers = handlers;
      recorder.start({
        format: "PCM",
        sampleRate: 16_000,
        numberOfChannels: 1,
        frameSize: 13,
        duration: 60_000,
      });
    },
    stop() {
      // onStop 回调经 manager 单例转发；stop 对未启动的录音器抛错由调用侧吞掉
      manager?.stop();
    },
  };
}
