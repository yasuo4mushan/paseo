/**
 * 设备状态统一 store（t23）：修复"设置页显示在线、设备页显示离线"的语义撕裂。
 *
 * 矛盾根因：两处状态数据源不同——设备页的在线/离线来自 hub devices.list
 * （daemon 每 20s 心跳、60s TTL），设置页"设备连接"显示的是小程序本地到
 * daemon 的 WebSocket 连接态（connectionManager）。daemon 未登录 hub 账号
 * （不心跳）时本地可以连上（设置页"在线"）而 hub 无心跳（设备页"离线"）。
 *
 * 本 store 把两个数据源归并为每设备三态（优先级 connected > online > offline）：
 *
 * | 综合态     | 判定                                            | 展示               |
 * | ---------- | ----------------------------------------------- | ------------------ |
 * | connected  | 本地连接活跃且匹配该设备（deviceId 或 serverId） | 绿实心 + 已连接    |
 * | online     | 仅 hub 心跳在线（device.online）                | 蓝点 + 在线        |
 * | offline    | 其余（hub 心跳过期/从未心跳）                   | 灰点 + 离线        |
 *
 * connected 且 hub 侧离线 → unreported（"已连接（未上表）"）：本地连接可用，
 * 但 daemon 未向 hub 上报心跳（未登录账号/心跳过期），该设备不会出现在其他
 * 手机的设备列表里——这正是用户撞上的场景，卡片上给一行说明。
 *
 * 数据源：
 * - hub devices.list：订阅者在场时 20s 轮询；页面 onShow / 下拉调 refreshNow 强刷。
 * - connectionManager：连接建立/断开时经 applyActiveConnection 推入当前连接
 *   标识（只读广播，不改连接逻辑本身）。
 *
 * 平台纪律（同 permission-store）：单例挂 globalThis（entry 与页面公共 chunk
 * 可能各带一份模块拷贝）；不用 useSyncExternalStore（页面侧 useState+useEffect
 * 订阅，见 hooks/use-device-statuses.ts）。轮询/时钟/鉴权经 deps 注入，
 * store 本体保持纯 TS 可单测。
 */

import { hasSession, hub, hubErrorMessage, isAuthExpired } from "@/hub/hub-client";
import type { HubDevice, HubDeviceOffer } from "@/hub/hub-types";

/** 每台设备的综合三态（connected > online > offline）。 */
export type DeviceMergedStatus = "connected" | "online" | "offline";

/** 当前活跃连接的只读标识（connectionManager 推送；仅 connected 态非 null）。 */
export interface ActiveConnectionIdentity {
  /** hub 设备 ID（从设备页连接时存在；手动配对/直连为 null）。 */
  deviceId: string | null;
  /** relay serverId（relay 连接时存在；直连为 null）。用于匹配手动配对的设备。 */
  serverId: string | null;
  /** 展示名（设备名 / relay 端点 / 直连 URL）。 */
  label: string;
}

/** 设备列表条目：hub 原始字段 + 综合三态。 */
export interface DeviceStatusEntry {
  deviceId: string;
  name: string;
  os: string;
  lastSeenAt: string;
  status: DeviceMergedStatus;
  /** hub 侧心跳是否在线（综合态之外保留原始判定，供"未上表"等派生逻辑用）。 */
  hubOnline: boolean;
  /** 本地已连接但 hub 侧离线：daemon 未上报心跳，设备不会出现在其他手机。 */
  unreported: boolean;
  offer: HubDeviceOffer | null;
}

/** 活跃连接摘要（设置页"设备连接"区 / t21 顶栏消费）。 */
export interface ActiveConnectionSummary {
  identity: ActiveConnectionIdentity;
  /** hub 列表中该设备离线或不存在（手动配对了非本账号设备也算未上表）。 */
  unreported: boolean;
  /** hub 列表中的对应设备（不在列表时为 null）。 */
  device: DeviceStatusEntry | null;
}

/** 页面订阅的只读快照（引用稳定：内容不变不重建、不通知）。 */
export interface DeviceStatusSnapshot {
  /** hub 设备列表（保持 hub 返回顺序），每台带综合三态。 */
  entries: DeviceStatusEntry[];
  /** 最近一次 devices.list 失败的用户可读文案（空 = 最近一次成功）。 */
  error: string;
  /** 首次加载未完成（骨架屏）。 */
  loading: boolean;
  /** 会话失效（hub 401/token 过期）——页面据此断开并跳登录。 */
  authExpired: boolean;
  /** 本地活跃连接（无连接时为 null）。 */
  active: ActiveConnectionSummary | null;
}

/**
 * 三态归并（纯函数）：hub 设备列表 × 当前连接标识 → 条目 + 活跃连接摘要。
 *
 * 匹配规则：active.deviceId 精确相等，或 active.serverId 与设备 offer.serverId
 * 相等（手动配对 relay:// 链接到已上表设备时走后者）。
 */
export function mergeDeviceStatuses(
  devices: HubDevice[],
  active: ActiveConnectionIdentity | null,
  /** hub 列表是否已完成首次加载（未加载时活跃连接不判定"未上表"，避免误报）。 */
  loaded: boolean,
): { entries: DeviceStatusEntry[]; active: ActiveConnectionSummary | null } {
  const entries: DeviceStatusEntry[] = devices.map((device) => {
    const matched = matchesActive(device, active);
    const status: DeviceMergedStatus = matched ? "connected" : device.online ? "online" : "offline";
    return {
      deviceId: device.deviceId,
      name: device.name,
      os: device.os,
      lastSeenAt: device.lastSeenAt,
      status,
      hubOnline: device.online,
      unreported: matched && !device.online,
      offer: device.offer,
    };
  });
  const matchedEntry = entries.find((entry) => entry.status === "connected") ?? null;
  const activeSummary: ActiveConnectionSummary | null = active
    ? {
        identity: active,
        // 未上表 = hub 侧离线（matched 但 !hubOnline）或根本不在本账号列表
        unreported: loaded ? !matchedEntry?.hubOnline : false,
        device: matchedEntry,
      }
    : null;
  return { entries, active: activeSummary };
}

function matchesActive(device: HubDevice, active: ActiveConnectionIdentity | null): boolean {
  if (!active) return false;
  if (active.deviceId && device.deviceId === active.deviceId) return true;
  return Boolean(active.serverId && device.offer?.serverId === active.serverId);
}

/** 注入依赖（生产 = hub + setInterval；单测注入 mock 保持 store 纯逻辑）。 */
export interface DeviceStatusDeps {
  fetchDevices: () => Promise<HubDevice[]>;
  isAuthenticated: () => boolean;
  setInterval: (fn: () => void, ms: number) => unknown;
  clearInterval: (timer: unknown) => void;
  /** 轮询间隔（ms）；hub 心跳 20s/TTL 60s，20s 轮询翻转延迟 ≤ 80s。 */
  pollMs: number;
}

type Listener = () => void;

const INITIAL_SNAPSHOT: DeviceStatusSnapshot = {
  entries: [],
  error: "",
  loading: true,
  authExpired: false,
  active: null,
};

export class DeviceStatusStore {
  private devices: HubDevice[] = [];
  private activeIdentity: ActiveConnectionIdentity | null = null;
  private error = "";
  private loading = true;
  private authExpired = false;
  private loaded = false;
  private listeners = new Set<Listener>();
  private timer: unknown = null;
  private inFlight: Promise<void> | null = null;
  private snapshot: DeviceStatusSnapshot = INITIAL_SNAPSHOT;

  constructor(private deps: DeviceStatusDeps) {}

  /** 页面订阅：首个订阅者启动轮询，最后一个退订停止（tab 页共存时保持轮询）。 */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensurePolling();
    // 首次订阅即拉一次（页面未显式 refreshNow 也能尽快出数；并发去重）
    if (!this.loaded) void this.fetchOnce();
    return () => {
      if (this.listeners.delete(listener) && this.listeners.size === 0) {
        this.stopPolling();
      }
    };
  };

  getSnapshot = (): DeviceStatusSnapshot => this.snapshot;

  /** 页面 onShow / 下拉刷新：立即拉一次（并发去重）。 */
  refreshNow(): Promise<void> {
    return this.fetchOnce();
  }

  /**
   * connectionManager 推送当前连接标识（只读广播；null = 未连接）。
   * 首次建立连接时强刷一次 hub 列表，让"未上表"判定立刻有据。
   */
  applyActiveConnection(identity: ActiveConnectionIdentity | null): void {
    if (sameIdentity(identity, this.activeIdentity)) return;
    const wasConnected = this.activeIdentity !== null;
    this.activeIdentity = identity;
    this.rebuild();
    if (identity && !wasConnected) void this.fetchOnce();
  }

  /** 轮询/强刷内部调用；单测直接驱动。 */
  applyHubDevices(devices: HubDevice[]): void {
    this.devices = devices;
    this.error = "";
    this.loading = false;
    this.loaded = true;
    this.authExpired = false;
    this.rebuild();
  }

  /** 单测隔离用：复位全部状态并停轮询。 */
  reset(): void {
    this.stopPolling();
    this.listeners.clear();
    this.devices = [];
    this.activeIdentity = null;
    this.error = "";
    this.loading = true;
    this.authExpired = false;
    this.loaded = false;
    this.inFlight = null;
    this.snapshot = INITIAL_SNAPSHOT;
  }

  private ensurePolling(): void {
    if (this.timer !== null) return;
    this.timer = this.deps.setInterval(() => void this.fetchOnce(), this.deps.pollMs);
  }

  private stopPolling(): void {
    if (this.timer === null) return;
    this.deps.clearInterval(this.timer);
    this.timer = null;
  }

  private fetchOnce(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.deps.isAuthenticated() || this.authExpired) return Promise.resolve();
    const task = (async () => {
      try {
        this.applyHubDevices(await this.deps.fetchDevices());
      } catch (err) {
        if (isAuthExpired(err)) {
          // 会话失效：静默置位（页面跳登录），不弹错误横幅；重新登录后自动恢复
          this.authExpired = true;
          this.loading = false;
          this.rebuild();
        } else {
          this.error = hubErrorMessage(err);
          this.loading = false;
          this.rebuild();
        }
      }
    })().finally(() => {
      this.inFlight = null;
    });
    this.inFlight = task;
    return task;
  }

  /** 内容不变不重建快照、不通知（20s 轮询无变化时页面零重渲染）。 */
  private rebuild(): void {
    const merged = mergeDeviceStatuses(this.devices, this.activeIdentity, this.loaded);
    const next: DeviceStatusSnapshot = {
      entries: merged.entries,
      error: this.error,
      loading: this.loading,
      authExpired: this.authExpired,
      active: merged.active,
    };
    if (snapshotEquals(next, this.snapshot)) return;
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}

function sameIdentity(
  a: ActiveConnectionIdentity | null,
  b: ActiveConnectionIdentity | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.deviceId === b.deviceId && a.serverId === b.serverId && a.label === b.label;
}

function snapshotEquals(a: DeviceStatusSnapshot, b: DeviceStatusSnapshot): boolean {
  if (
    a.error !== b.error ||
    a.loading !== b.loading ||
    a.authExpired !== b.authExpired ||
    a.entries.length !== b.entries.length
  ) {
    return false;
  }
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i];
    const y = b.entries[i];
    if (
      x.deviceId !== y.deviceId ||
      x.status !== y.status ||
      x.hubOnline !== y.hubOnline ||
      x.unreported !== y.unreported
    ) {
      return false;
    }
  }
  return sameIdentity(a.active?.identity ?? null, b.active?.identity ?? null);
}

/** 生产依赖：真实 hub + 原生定时器。 */
const productionDeps: DeviceStatusDeps = {
  fetchDevices: () => hub.devices(),
  isAuthenticated: () => hasSession(),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (timer) => clearInterval(timer as ReturnType<typeof setInterval>),
  pollMs: 20_000,
};

/** 单例经 globalThis 固定（原因见 permission-store.ts 同款注释）。 */
const GLOBAL_KEY = "__aaswitch_device_status_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: DeviceStatusStore };
export const deviceStatusStore: DeviceStatusStore = (globalScope[GLOBAL_KEY] ??=
  new DeviceStatusStore(productionDeps));
