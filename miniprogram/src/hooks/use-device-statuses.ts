/**
 * 设备综合状态 hook（t23）：deviceStatusStore 的页面侧订阅入口。
 *
 * 用法（设备页/设置页/t21 顶栏同源同语义）：
 *
 *   const snapshot = useDeviceStatuses();
 *   snapshot.entries                 // hub 设备列表，每台 status:
 *                                   //   "connected"（绿实心"已连接"；unreported 时"已连接（未上表）"）
 *                                   //   "online"（蓝点"在线"，仅 hub 心跳）
 *                                   //   "offline"（灰点"离线"）
 *   snapshot.active                 // 本地活跃连接摘要（identity/unreported/device），
 *                                   //   无连接为 null——顶栏/设置页设备连接区用
 *   snapshot.error / snapshot.loading / snapshot.authExpired
 *
 * 订阅期间 store 自动 20s 轮询 hub devices.list；页面 onShow / 下拉刷新调
 * deviceStatusStore.refreshNow() 强刷。
 *
 * 平台纪律：不用 useSyncExternalStore（React 18 小程序环境曾出撕裂告警），
 * useState + useEffect 订阅（同 use-theme 模式）。
 */

import { useEffect, useState } from "react";
import { deviceStatusStore, type DeviceStatusSnapshot } from "@/connection/device-status-store";

export function useDeviceStatuses(): DeviceStatusSnapshot {
  const [snapshot, setSnapshot] = useState<DeviceStatusSnapshot>(() =>
    deviceStatusStore.getSnapshot(),
  );
  useEffect(
    () => deviceStatusStore.subscribe(() => setSnapshot(deviceStatusStore.getSnapshot())),
    [],
  );
  return snapshot;
}
