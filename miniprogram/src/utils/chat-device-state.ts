/**
 * 对话页设备选择视图状态（t21）：顶栏设备按钮（名称/状态点）与掉线横幅的
 * 纯函数推导。切换/掉线状态机的可测内核——页面只消费结果，不内联判定。
 *
 * 状态语义（刻意只两级，不造第二套语义——t23 的统一状态层落地后合流）：
 *  - hub online：devices.list 心跳窗口（本模块唯一在线来源）；
 *  - 连接态：connection-manager 的 status。
 */

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export type DeviceDotTone = "online" | "offline" | "connecting" | "idle";

export interface ChatDeviceView {
  /** 顶栏设备按钮文案：有设备名时用名，否则状态回退文案。 */
  deviceLabel: string;
  /** 顶栏状态点色调。 */
  dot: DeviceDotTone;
  /** 掉线/断开横幅（null = 不显示；连接中不横幅）。 */
  banner: null | { kind: "offline" | "disconnected" };
}

export interface ChatDeviceInput {
  connectionStatus: ConnectionStatus;
  /** 当前连接的 hub 设备（手动配对直连时为 null）。 */
  activeDevice: { deviceId: string; name: string } | null;
  /** 最近一次 devices.list 快照（null = 未拉到）。 */
  devices: Array<{ deviceId: string; online: boolean }> | null;
}

/** hub 侧当前设备是否在线（不在列表/未拉到 = 未知 null）。 */
export function hubOnline(input: ChatDeviceInput): boolean | null {
  if (!input.activeDevice || !input.devices) return null;
  return input.devices.find((d) => d.deviceId === input.activeDevice?.deviceId)?.online ?? null;
}

export function chatDeviceView(input: ChatDeviceInput): ChatDeviceView {
  const online = hubOnline(input);
  const name = input.activeDevice?.name ?? "";

  // 连接中：一律连接中态（无论旧设备 hub 是否还在线），横幅不出现
  if (input.connectionStatus === "connecting") {
    return { deviceLabel: "连接中…", dot: "connecting", banner: null };
  }

  if (input.connectionStatus === "connected") {
    // 已连接但 hub 心跳掉线：连接可能仍活着，但设备大概率异常——横幅预警
    if (online === false) {
      return { deviceLabel: name || "已连接", dot: "offline", banner: { kind: "offline" } };
    }
    return {
      deviceLabel: name || "已连接",
      dot: online === true ? "online" : "idle",
      banner: null,
    };
  }

  // 断开/失败（含网络掉线，manager 保留 activeDevice）：横幅给一键重连/切换；
  // 主动断开（activeDevice 已清）走设备按钮选择态。
  if (input.activeDevice) {
    return {
      deviceLabel: name || "未连接",
      dot: "offline",
      banner: { kind: online === false ? "offline" : "disconnected" },
    };
  }

  return { deviceLabel: "选择设备", dot: "idle", banner: null };
}

/**
 * 自动连接引导态：未连接、且 hub 设备里没有可连候选（无在线设备）→
 * 页面显示引导（去设备页/手动配对/刷新）。列表未拉到时不引导（先骨架）。
 */
export function needsGuidance(
  connectionStatus: ConnectionStatus,
  devices: Array<{ deviceId: string; online: boolean; offer: unknown }> | null,
): boolean {
  if (connectionStatus === "connected" || connectionStatus === "connecting") return false;
  if (!devices) return false;
  return !devices.some((d) => d.online && d.offer);
}
