/**
 * t23 设备状态统一 store 测试：三态归并（connected > online > offline）、
 * 心跳过期翻转、连接断开回退、订阅生命周期（轮询启停/并发去重/清理）、
 * 会话失效与错误文案。
 *
 * store 依赖经 deps 注入（fetch/鉴权/定时器全 mock，不碰 Taro 网络层）；
 * vi.mock("@tarojs/taro") 仅为消化 hub-client 的模块级 import。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { storage } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  return { storage };
});

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: (key: string) => storage.get(key) ?? "",
    setStorageSync: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeStorageSync: (key: string) => {
      storage.delete(key);
    },
    request: () => Promise.reject(new Error("tests 不走 Taro request")),
  },
}));

import { HubApiError } from "../src/hub/hub-client";
import type { HubDevice } from "../src/hub/hub-types";
import {
  DeviceStatusStore,
  mergeDeviceStatuses,
  type ActiveConnectionIdentity,
  type DeviceStatusDeps,
} from "../src/connection/device-status-store";

function device(overrides: Partial<HubDevice> = {}): HubDevice {
  return {
    deviceId: "dev-1",
    name: "Dev One",
    os: "macos",
    online: true,
    lastSeenAt: "2026-01-02T00:00:00Z",
    offer: {
      serverId: "srv-1",
      daemonPublicKeyB64: "KEY",
      endpoint: "relay.example:80",
      useTls: false,
    },
    ...overrides,
  };
}

interface ManualTimer {
  fn: () => void;
  ms: number;
  stopped: boolean;
}

function createHarness() {
  const timers: ManualTimer[] = [];
  const ctl = {
    fetch: (async () => [] as HubDevice[]) as () => Promise<HubDevice[]>,
    authenticated: true,
    calls: 0,
  };
  const deps: DeviceStatusDeps = {
    fetchDevices: () => {
      ctl.calls += 1;
      return ctl.fetch();
    },
    isAuthenticated: () => ctl.authenticated,
    setInterval: (fn, ms) => {
      const timer: ManualTimer = { fn, ms, stopped: false };
      timers.push(timer);
      return timer;
    },
    clearInterval: (timer) => {
      (timer as ManualTimer).stopped = true;
    },
    pollMs: 20_000,
  };
  const store = new DeviceStatusStore(deps);
  return { store, timers, ctl };
}

const IDENTITY_DEVICE: ActiveConnectionIdentity = {
  deviceId: "dev-1",
  serverId: "srv-1",
  label: "Dev One",
};

const IDENTITY_MANUAL: ActiveConnectionIdentity = {
  deviceId: null,
  serverId: "srv-1",
  label: "relay.example:80",
};

const IDENTITY_FOREIGN: ActiveConnectionIdentity = {
  deviceId: null,
  serverId: "srv-foreign",
  label: "relay.other:80",
};

let harness: ReturnType<typeof createHarness>;

/** 冲刷微任务队列（async fetch → applyHubDevices → 通知 全部落地）。 */
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  harness = createHarness();
});

describe("三态归并（mergeDeviceStatuses 纯函数）", () => {
  it("connected > online > offline：deviceId 匹配最高优先", () => {
    const devices = [
      device({ deviceId: "a", online: true }),
      device({ deviceId: "b", online: false, offer: null }),
    ];
    const { entries, active } = mergeDeviceStatuses(
      devices,
      { deviceId: "a", serverId: null, label: "a" },
      true,
    );
    expect(entries.map((e) => e.status)).toEqual(["connected", "offline"]);
    expect(active?.device?.deviceId).toBe("a");
    expect(active?.unreported).toBe(false);
  });

  it("serverId 匹配覆盖手动配对（relay:// 链接连到已上表设备）", () => {
    const { entries } = mergeDeviceStatuses(
      [device({ deviceId: "a", online: true })],
      IDENTITY_MANUAL,
      true,
    );
    expect(entries[0]?.status).toBe("connected");
  });

  it("本地已连但 hub 心跳离线 → connected + unreported", () => {
    const { entries, active } = mergeDeviceStatuses(
      [device({ deviceId: "dev-1", online: false })],
      IDENTITY_DEVICE,
      true,
    );
    expect(entries[0]?.status).toBe("connected");
    expect(entries[0]?.unreported).toBe(true);
    expect(active?.unreported).toBe(true);
  });

  it("仅 hub 心跳在线 → online；无连接无心跳 → offline", () => {
    const { entries, active } = mergeDeviceStatuses(
      [device({ deviceId: "a", online: true }), device({ deviceId: "b", online: false })],
      null,
      true,
    );
    expect(entries.map((e) => e.status)).toEqual(["online", "offline"]);
    expect(active).toBeNull();
  });

  it("手动配对不在 hub 列表 → active.unreported（hub 侧无此设备）", () => {
    const { active } = mergeDeviceStatuses([device({ deviceId: "a" })], IDENTITY_FOREIGN, true);
    expect(active?.unreported).toBe(true);
    expect(active?.device).toBeNull();
  });

  it("首次加载未完成时不判定未上表（避免误报）", () => {
    const { active } = mergeDeviceStatuses([], IDENTITY_FOREIGN, false);
    expect(active?.unreported).toBe(false);
  });
});

describe("store 归并与翻转", () => {
  it("心跳过期翻转：online → offline；已连接设备保持 connected 但转为未上表", async () => {
    const { store, ctl } = harness;
    ctl.fetch = async () => [device({ deviceId: "dev-1", online: true })];
    await store.refreshNow();
    store.applyActiveConnection(IDENTITY_DEVICE);
    expect(store.getSnapshot().entries[0]?.status).toBe("connected");
    expect(store.getSnapshot().entries[0]?.unreported).toBe(false);
    await flush(); // 首次连接触发的强刷落地

    // daemon 停止心跳：TTL 过期后 hub 下一次 devices.list 报 offline
    ctl.fetch = async () => [device({ deviceId: "dev-1", online: false })];
    await store.refreshNow();
    expect(store.getSnapshot().entries[0]?.status).toBe("connected");
    expect(store.getSnapshot().entries[0]?.unreported).toBe(true);
    expect(store.getSnapshot().active?.unreported).toBe(true);
  });

  it("连接断开回退：connected → 按 hub 态回退 online/offline", async () => {
    const { store, ctl } = harness;
    ctl.fetch = async () => [
      device({ deviceId: "a", online: true }),
      device({ deviceId: "b", online: false, offer: null }),
    ];
    await store.refreshNow();
    store.applyActiveConnection({ deviceId: "a", serverId: "srv-1", label: "a" });
    expect(store.getSnapshot().entries.map((e) => e.status)).toEqual(["connected", "offline"]);

    store.applyActiveConnection(null);
    expect(store.getSnapshot().entries.map((e) => e.status)).toEqual(["online", "offline"]);
    expect(store.getSnapshot().active).toBeNull();
  });

  it("同数据轮询不重复通知（快照引用稳定）", async () => {
    const { store, ctl } = harness;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    const before = store.getSnapshot();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    const notifiedAtSubscribe = notified; // 首订阅可能触发拉取，此处只记录基线
    await store.refreshNow();
    expect(notified).toBe(notifiedAtSubscribe);
    expect(store.getSnapshot()).toBe(before);
  });

  it("applyActiveConnection 同标识幂等；首次连接触发一次强刷", async () => {
    const { store, ctl } = harness;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    const callsBefore = ctl.calls;
    store.applyActiveConnection(IDENTITY_DEVICE);
    store.applyActiveConnection(IDENTITY_DEVICE);
    expect(ctl.calls).toBe(callsBefore + 1); // 仅首次
    await flush(); // 强刷落地（inFlight 释放）
    // 断开后再连：再次强刷
    store.applyActiveConnection(null);
    store.applyActiveConnection(IDENTITY_DEVICE);
    expect(ctl.calls).toBe(callsBefore + 2);
  });
});

describe("订阅生命周期与轮询", () => {
  it("首个订阅启动轮询、最后一个退订停止", async () => {
    const { store, timers, ctl } = harness;
    ctl.fetch = async () => [device()];
    const unsubA = store.subscribe(() => {});
    expect(timers.length).toBe(1);
    const unsubB = store.subscribe(() => {});
    expect(timers.length).toBe(1); // 已在轮询，不重复起 timer
    unsubA();
    expect(timers[0]?.stopped).toBe(false);
    unsubB();
    expect(timers[0]?.stopped).toBe(true);
  });

  it("订阅即拉首份（未加载时）；轮询 tick 驱动刷新", async () => {
    const { store, timers, ctl } = harness;
    let online = true;
    ctl.fetch = async () => [device({ online })];
    store.subscribe(() => {});
    expect(ctl.calls).toBe(1);
    await flush();
    expect(store.getSnapshot().entries[0]?.status).toBe("online");
    online = false;
    await timers[0]?.fn();
    expect(store.getSnapshot().entries[0]?.status).toBe("offline");
  });

  it("并发去重：inFlight 期间 refreshNow 复用同一请求", async () => {
    const { store, ctl } = harness;
    // 持有对象属性，规避 TS 对回调内赋值的流式收窄
    const gate: { release: (() => void) | null } = { release: null };
    ctl.fetch = () =>
      new Promise<HubDevice[]>((resolve) => {
        gate.release = () => resolve([device()]);
      });
    const first = store.refreshNow();
    const second = store.refreshNow();
    expect(ctl.calls).toBe(1);
    gate.release?.();
    await Promise.all([first, second]);
    expect(store.getSnapshot().entries.length).toBe(1);
  });

  it("未登录不拉取；重新登录后可恢复", async () => {
    const { store, ctl } = harness;
    ctl.authenticated = false;
    await store.refreshNow();
    expect(ctl.calls).toBe(0);
    expect(store.getSnapshot().loading).toBe(true);
    ctl.authenticated = true;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    expect(ctl.calls).toBe(1);
  });

  it("reset 清空状态并停轮询", async () => {
    const { store, timers, ctl } = harness;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    const unsub = store.subscribe(() => {});
    store.applyActiveConnection(IDENTITY_DEVICE);
    store.reset();
    unsub();
    const snapshot = store.getSnapshot();
    expect(snapshot.entries).toEqual([]);
    expect(snapshot.loading).toBe(true);
    expect(snapshot.active).toBeNull();
    expect(timers[0]?.stopped).toBe(true);
  });
});

describe("错误与会话失效", () => {
  it("网络/服务端错误 → error 文案，保留旧列表", async () => {
    const { store, ctl } = harness;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    ctl.fetch = async () => {
      throw new HubApiError("hub.network_error", "无法连接服务器（timeout）");
    };
    await store.refreshNow();
    const snapshot = store.getSnapshot();
    expect(snapshot.error).toContain("无法连接服务器");
    expect(snapshot.entries.length).toBe(1); // 旧列表保留
    expect(snapshot.authExpired).toBe(false);
  });

  it("会话失效 → authExpired 静默置位（不弹错误横幅），轮询跳过", async () => {
    const { store, timers, ctl } = harness;
    ctl.fetch = async () => [device()];
    await store.refreshNow();
    store.subscribe(() => {}); // 起轮询 timer（已 loaded，不重复拉）
    const callsBefore = ctl.calls;
    ctl.fetch = async () => {
      throw new HubApiError("auth.unauthorized", "token expired");
    };
    await store.refreshNow();
    const snapshot = store.getSnapshot();
    expect(snapshot.authExpired).toBe(true);
    expect(snapshot.error).toBe("");
    // authExpired 期间轮询 tick 不再打 hub
    await timers[0]?.fn();
    expect(ctl.calls).toBe(callsBefore + 1);
  });
});
