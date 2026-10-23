/**
 * t21 设备选择测试：默认设备选择策略（记忆 > 首个在线 > 无在线回退）、
 * 上次使用设备的账号维度隔离、composer 草稿暂存（设备×会话键、LRU 上限）、
 * 顶栏/横幅状态机（连接中/已连接/掉线/断开/无设备）与引导态判定。
 *
 * store 的 storage 注入内存实现，不碰 Taro；状态机是纯函数直测。
 */

import { beforeEach, describe, expect, it } from "vitest";
import type { HubDevice } from "../src/hub/hub-types";
import {
  devicePreferenceStore,
  draftKey,
  selectDefaultDevice,
} from "../src/stores/device-preference-store";
import {
  chatDeviceView,
  needsGuidance,
  type ChatDeviceInput,
} from "../src/utils/chat-device-state";

function device(overrides: Partial<HubDevice> = {}): HubDevice {
  return {
    deviceId: "d1",
    name: "dev-1",
    os: "darwin",
    online: true,
    lastSeenAt: "2026-10-01T00:00:00Z",
    offer: { serverId: "srv", daemonPublicKeyB64: "k", endpoint: "h:1", useTls: false },
    ...overrides,
  };
}

let storageRaw: string | null = null;

beforeEach(() => {
  storageRaw = null;
  devicePreferenceStore.installStorage(
    () => storageRaw,
    (raw) => {
      storageRaw = raw;
    },
  );
});

describe("selectDefaultDevice（默认设备策略）", () => {
  it("记忆设备优先（即使不是列表第一个）", () => {
    const devices = [device({ deviceId: "a", name: "A" }), device({ deviceId: "b", name: "B" })];
    const pick = selectDefaultDevice(devices, { deviceId: "b", name: "B" });
    expect(pick?.deviceId).toBe("b");
  });

  it("记忆设备离线 → 回退第一个在线设备", () => {
    const devices = [
      device({ deviceId: "a", online: false }),
      device({ deviceId: "b", name: "B" }),
      device({ deviceId: "c", name: "C" }),
    ];
    const pick = selectDefaultDevice(devices, { deviceId: "a", name: "A" });
    expect(pick?.deviceId).toBe("b");
  });

  it("记忆设备不在列表 → 第一个在线设备", () => {
    const devices = [device({ deviceId: "a", online: false }), device({ deviceId: "b" })];
    const pick = selectDefaultDevice(devices, { deviceId: "gone", name: "G" });
    expect(pick?.deviceId).toBe("b");
  });

  it("无记忆 → 第一个在线设备；跳过无 offer 的在线设备", () => {
    const devices = [device({ deviceId: "no-offer", offer: null }), device({ deviceId: "ok" })];
    expect(selectDefaultDevice(devices, null)?.deviceId).toBe("ok");
  });

  it("无在线设备 → null（页面引导态）", () => {
    const devices = [
      device({ deviceId: "a", online: false }),
      device({ deviceId: "b", online: false, offer: null }),
    ];
    expect(selectDefaultDevice(devices, null)).toBeNull();
    expect(selectDefaultDevice(devices, { deviceId: "a", name: "A" })).toBeNull();
  });
});

describe("上次使用的设备（账号维度隔离）", () => {
  it("各账号各自记忆，互不串扰", () => {
    devicePreferenceStore.setRemembered("acc-1", { deviceId: "d1", name: "Dev1" });
    devicePreferenceStore.setRemembered("acc-2", { deviceId: "d2", name: "Dev2" });
    expect(devicePreferenceStore.getRemembered("acc-1")).toEqual({ deviceId: "d1", name: "Dev1" });
    expect(devicePreferenceStore.getRemembered("acc-2")).toEqual({ deviceId: "d2", name: "Dev2" });
  });

  it("清除单账号不影响其他账号；经 storage 往返持久", () => {
    devicePreferenceStore.setRemembered("acc-1", { deviceId: "d1", name: "Dev1" });
    devicePreferenceStore.setRemembered("acc-2", { deviceId: "d2", name: "Dev2" });
    devicePreferenceStore.clearRemembered("acc-1");
    expect(devicePreferenceStore.getRemembered("acc-1")).toBeNull();
    expect(devicePreferenceStore.getRemembered("acc-2")?.deviceId).toBe("d2");

    // 重新 install（等价冷启动读 storage）
    devicePreferenceStore.installStorage(
      () => storageRaw,
      (raw) => {
        storageRaw = raw;
      },
    );
    expect(devicePreferenceStore.getRemembered("acc-2")?.name).toBe("Dev2");
  });
});

describe("composer 草稿暂存（设备×会话）", () => {
  it("draftKey：设备 + 会话（无会话用 new）", () => {
    expect(draftKey("dev1", "agent-9")).toBe("dev1:agent-9");
    expect(draftKey("dev1", null)).toBe("dev1:new");
  });

  it("save/load/clear：切换设备会话来回文本保留；发送后清空", () => {
    const k1 = draftKey("dev1", "a1");
    const k2 = draftKey("dev2", "a1");
    devicePreferenceStore.saveDraft(k1, "帮我看下构建失败");
    devicePreferenceStore.saveDraft(k2, "另一台的任务");
    expect(devicePreferenceStore.loadDraft(k1)).toBe("帮我看下构建失败");
    expect(devicePreferenceStore.loadDraft(k2)).toBe("另一台的任务");
    // 切回 dev1 草稿还在
    expect(devicePreferenceStore.loadDraft(k1)).toBe("帮我看下构建失败");
    // 发送成功 → 清
    devicePreferenceStore.clearDraft(k1);
    expect(devicePreferenceStore.loadDraft(k1)).toBe("");
  });

  it("空串保存等同清除；LRU 上限淘汰最旧", () => {
    devicePreferenceStore.saveDraft("d:a", "x");
    devicePreferenceStore.saveDraft("d:a", "");
    expect(devicePreferenceStore.loadDraft("d:a")).toBe("");

    for (let i = 0; i < 30; i++) {
      devicePreferenceStore.saveDraft(`dev${i}:new`, `t${i}`);
    }
    // 前 6 条被淘汰（上限 24），最新保留
    expect(devicePreferenceStore.loadDraft("dev0:new")).toBe("");
    expect(devicePreferenceStore.loadDraft("dev5:new")).toBe("");
    expect(devicePreferenceStore.loadDraft("dev6:new")).toBe("t6");
    expect(devicePreferenceStore.loadDraft("dev29:new")).toBe("t29");
  });

  it("storage 损坏内容回退空偏好不抛错", () => {
    storageRaw = "{not json";
    expect(() =>
      devicePreferenceStore.installStorage(
        () => storageRaw,
        (raw) => {
          storageRaw = raw;
        },
      ),
    ).not.toThrow();
    expect(devicePreferenceStore.getRemembered("acc")).toBeNull();
  });
});

function input(overrides: Partial<ChatDeviceInput> = {}): ChatDeviceInput {
  return {
    connectionStatus: "connected",
    activeDevice: { deviceId: "d1", name: "Dev1" },
    devices: [{ deviceId: "d1", online: true }],
    ...overrides,
  };
}

describe("顶栏/横幅状态机（chatDeviceView）", () => {
  it("已连接且 hub 在线 → 设备名 + 在线点，无横幅", () => {
    const view = chatDeviceView(input());
    expect(view).toEqual({ deviceLabel: "Dev1", dot: "online", banner: null });
  });

  it("已连接但 hub 心跳掉线 → offline 点 + 设备已离线横幅", () => {
    const view = chatDeviceView(input({ devices: [{ deviceId: "d1", online: false }] }));
    expect(view.dot).toBe("offline");
    expect(view.banner).toEqual({ kind: "offline" });
  });

  it("连接中 → 连接中点，永不横幅（即使旧设备离线）", () => {
    const view = chatDeviceView(
      input({
        connectionStatus: "connecting",
        devices: [{ deviceId: "d1", online: false }],
      }),
    );
    expect(view.deviceLabel).toBe("连接中…");
    expect(view.dot).toBe("connecting");
    expect(view.banner).toBeNull();
  });

  it("网络断开（设备保留在 manager）→ 断开横幅；hub 同时离线则离线横幅", () => {
    const onlineList = [{ deviceId: "d1", online: true }];
    const dropped = chatDeviceView(
      input({ connectionStatus: "disconnected", devices: onlineList }),
    );
    expect(dropped.banner).toEqual({ kind: "disconnected" });

    const offlineToo = chatDeviceView(
      input({
        connectionStatus: "disconnected",
        devices: [{ deviceId: "d1", online: false }],
      }),
    );
    expect(offlineToo.banner).toEqual({ kind: "offline" });
  });

  it("主动断开（无 activeDevice）→ 选择设备态，无横幅", () => {
    const view = chatDeviceView(input({ connectionStatus: "disconnected", activeDevice: null }));
    expect(view.deviceLabel).toBe("选择设备");
    expect(view.dot).toBe("idle");
    expect(view.banner).toBeNull();
  });

  it("hub 列表未拉到 → 已连接显示 idle 点（未知不误报掉线）", () => {
    const view = chatDeviceView(input({ devices: null }));
    expect(view.dot).toBe("idle");
    expect(view.banner).toBeNull();
  });
});

describe("引导态判定（needsGuidance）", () => {
  it("未连接且无在线可连设备 → 引导；有在线设备不引导", () => {
    const offlineOnly = [{ deviceId: "d", online: false, offer: null }];
    expect(needsGuidance("disconnected", offlineOnly)).toBe(true);
    expect(needsGuidance("error", offlineOnly)).toBe(true);
    const hasOnline = [
      { deviceId: "d", online: false, offer: null },
      { deviceId: "e", online: true, offer: { serverId: "s" } },
    ];
    expect(needsGuidance("disconnected", hasOnline)).toBe(false);
  });

  it("连接中/已连接不引导；列表未到不引导（先骨架）", () => {
    expect(needsGuidance("connected", null)).toBe(false);
    expect(needsGuidance("connecting", null)).toBe(false);
    expect(needsGuidance("disconnected", null)).toBe(false);
  });
});
