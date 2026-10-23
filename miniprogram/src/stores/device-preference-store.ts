/**
 * 设备偏好 store（t21）：对话页设备选择的持久化层。
 *
 * 职责：
 *  - 「上次使用的设备」记忆，按账号维度隔离（accountId → {deviceId,name}）：
 *    对话页自动连接的优先候选（见 selectDefaultDevice）；
 *  - composer 草稿暂存，键 = `${deviceId}:${agentId|new}`：切换设备/会话时
 *    未发送文本先存后取，回来还在（发送成功即清）。
 *
 * 平台无关纯 TS + 注入式 storage（Node 可测），Taro 接线在
 * connection-manager 构造器（同 workspace/session store 模式）；
 * 单例挂 globalThis（原因见 permission-store.ts）。
 *
 * 在线判定语义：本 store 只管「记忆与草稿」，online/offer 判断一律以
 * hub devices.list 快照为准（t23 将提供统一状态层，此处不造第二套语义）。
 */

import type { HubDevice } from "@/hub/hub-types";

type Listener = () => void;

export interface RememberedDevice {
  deviceId: string;
  name: string;
}

interface PrefsShape {
  /** accountId → 上次使用的设备。 */
  remembered: Record<string, RememberedDevice>;
  /** `${deviceId}:${agentId|new}` → 草稿文本；插入序即新旧序（LRU 淘汰用）。 */
  drafts: Record<string, string>;
  /** drafts 写入序（键有序数组，避免依赖对象键序语义）。 */
  draftOrder: string[];
}

/** 草稿条目上限：防 storage 无界膨胀（超出淘汰最旧）。 */
const MAX_DRAFTS = 24;

function emptyPrefs(): PrefsShape {
  return { remembered: {}, drafts: {}, draftOrder: [] };
}

/** 防御式解析（storage 内容可能来自旧版本/异常写入）。 */
function parsePrefs(raw: string | null): PrefsShape {
  if (!raw) return emptyPrefs();
  try {
    const parsed = JSON.parse(raw) as Partial<PrefsShape>;
    const remembered: Record<string, RememberedDevice> = {};
    if (parsed.remembered && typeof parsed.remembered === "object") {
      for (const [accountId, value] of Object.entries(parsed.remembered)) {
        if (
          value &&
          typeof value === "object" &&
          typeof value.deviceId === "string" &&
          value.deviceId
        ) {
          remembered[accountId] = { deviceId: value.deviceId, name: String(value.name ?? "") };
        }
      }
    }
    const drafts: Record<string, string> = {};
    const draftOrder: string[] = [];
    if (parsed.drafts && typeof parsed.drafts === "object") {
      for (const key of Object.keys(parsed.drafts)) {
        if (typeof parsed.drafts[key] === "string") {
          drafts[key] = parsed.drafts[key] as string;
          draftOrder.push(key);
        }
      }
    }
    return { remembered, drafts, draftOrder };
  } catch {
    return emptyPrefs();
  }
}

/**
 * 默认设备选择策略（t21 P0-1）：
 *  1. 有记忆且记忆设备在列表中在线（且有 offer）→ 用记忆；
 *  2. 否则取列表第一个在线且有 offer 的设备；
 *  3. 无在线设备 → null（页面显示引导）。
 * 纯函数，单测直接覆盖。
 */
export function selectDefaultDevice(
  devices: HubDevice[],
  remembered: RememberedDevice | null,
): HubDevice | null {
  if (remembered) {
    const hit = devices.find((d) => d.deviceId === remembered.deviceId);
    if (hit && hit.online && hit.offer) return hit;
  }
  return devices.find((d) => d.online && d.offer) ?? null;
}

/** 草稿键：设备 × 会话（无活跃会话用 "new"）。 */
export function draftKey(deviceKey: string, agentId: string | null): string {
  return `${deviceKey}:${agentId ?? "new"}`;
}

class DevicePreferenceStore {
  private prefs: PrefsShape = emptyPrefs();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  // ---- 上次使用的设备（账号维度） ----

  getRemembered(accountId: string): RememberedDevice | null {
    return this.prefs.remembered[accountId] ?? null;
  }

  setRemembered(accountId: string, device: RememberedDevice): void {
    this.prefs = {
      ...this.prefs,
      remembered: { ...this.prefs.remembered, [accountId]: device },
    };
    this.persist();
    this.notify();
  }

  clearRemembered(accountId: string): void {
    if (!(accountId in this.prefs.remembered)) return;
    const remembered = { ...this.prefs.remembered };
    delete remembered[accountId];
    this.prefs = { ...this.prefs, remembered };
    this.persist();
    this.notify();
  }

  // ---- composer 草稿（设备 × 会话） ----

  loadDraft(key: string): string {
    return this.prefs.drafts[key] ?? "";
  }

  /** 保存草稿；空串等同清除（不留空壳占 storage 与 LRU 位）。 */
  saveDraft(key: string, text: string): void {
    const drafts = { ...this.prefs.drafts };
    const order = this.prefs.draftOrder.filter((k) => k !== key);
    if (text) {
      drafts[key] = text;
      order.push(key);
    } else {
      delete drafts[key];
    }
    // LRU 淘汰最旧
    while (order.length > MAX_DRAFTS) {
      const oldest = order.shift();
      if (oldest === undefined) break;
      delete drafts[oldest];
    }
    this.prefs = { ...this.prefs, drafts, draftOrder: order };
    this.persist();
  }

  clearDraft(key: string): void {
    this.saveDraft(key, "");
  }

  // ---- storage 注入（connection-manager 接 Taro；测试注内存） ----

  private writeStorage: (raw: string) => void = () => {};

  installStorage(get: () => string | null, set: (raw: string) => void): void {
    this.writeStorage = set;
    this.prefs = parsePrefs(get());
  }

  private persist(): void {
    try {
      this.writeStorage(JSON.stringify(this.prefs));
    } catch {
      // storage 不可用时静默（内存态仍生效）
    }
  }
}

/** 单例经 globalThis 固定（HMR/多 bundle 下保持同一实例）。 */
const GLOBAL_KEY = "__aaswitch_device_pref_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: DevicePreferenceStore };
export const devicePreferenceStore: DevicePreferenceStore = (globalScope[GLOBAL_KEY] ??=
  new DevicePreferenceStore());
