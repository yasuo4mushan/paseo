/**
 * use-dictation（t32）：把 dictation-store 接进 React 与连接层。
 *
 * 职责（store 保持平台无关，接线都在这里，同 sessionStore.fetcher 先例）：
 * - 安装 transport 工厂（connectionManager 当前连接）与录音源工厂
 *   （wx.getRecorderManager 封装）；两者都是幂等 install，页面重复挂载安全。
 * - connectionManager.onDictationEvent → store.handleEvent；
 *   onDisconnect → store.abort（录音中断线立即收口）。
 * - 权限态同步：页面显示时查 scope.record 拒绝态（授权弹窗只在录音时弹）。
 *
 * 返回 store 快照（useState+useEffect 订阅，平台纪律不用 useSyncExternalStore）
 * 与手势/设置入口；final 文本插入由页面 bindInsertText 绑定。
 */

import { useEffect, useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { connectionManager } from "@/connection/connection-manager";
import { dictationStore, type DictationSnapshot } from "@/stores/dictation-store";
import { createRecorderAudioSource } from "@/utils/recorder-source";

let installed = false;

/** 平台接线只做一次（多页面挂载安全；本版本只有对话页用）。 */
function ensureInstalled(): void {
  if (installed) return;
  installed = true;
  dictationStore.installTransport(() => connectionManager.getConnection());
  dictationStore.installAudioSource(createRecorderAudioSource);
}

export function useDictation(): DictationSnapshot {
  ensureInstalled();
  const [snapshot, setSnapshot] = useState<DictationSnapshot>(() => dictationStore.getSnapshot());

  useEffect(() => {
    const unsubscribeStore = dictationStore.subscribe(() =>
      setSnapshot(dictationStore.getSnapshot()),
    );
    const unsubscribeEvents = connectionManager.onDictationEvent((event) =>
      dictationStore.handleEvent(event),
    );
    const unsubscribeDisconnect = connectionManager.onDisconnect(() => {
      // 录音中断线：立即中断会话（cancel 静默失败无妨），错误提示由断线横幅承接。
      dictationStore.abort("设备连接已断开");
    });
    return () => {
      unsubscribeStore();
      unsubscribeEvents();
      unsubscribeDisconnect();
    };
  }, []);

  // 权限拒绝态刷新（用户从设置页回来 / 首次进入）；授权弹窗在录音时才触发。
  useDidShow(() => {
    void Taro.getSetting()
      .then((res) => {
        // Taro 类型把 authSetting 标成嵌套 scope 对象，实际键是 "scope.record"
        const authSetting = res.authSetting as unknown as Record<string, boolean> | undefined;
        dictationStore.setPermissionDenied(authSetting?.["scope.record"] === false);
      })
      .catch(() => {});
  });

  return snapshot;
}

/** 麦克风权限被拒时的引导：打开小程序设置页开 scope.record。 */
export function openRecordPermissionSettings(): void {
  void Taro.showModal({
    title: "需要麦克风权限",
    content: "语音输入需要使用麦克风。请在设置中开启「麦克风」权限。",
    confirmText: "去设置",
    cancelText: "取消",
  }).then((res) => {
    if (res.confirm) {
      Taro.openSetting({}).catch(() => {});
    }
  });
}
