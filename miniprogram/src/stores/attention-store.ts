/**
 * agent attention 全局提醒状态（t18）。
 *
 * daemon 推送 agent_attention_required（legacy 客户端免订阅）→ 这里记录红点集合；
 * agent_update 快照 requiresAttention=false 时自动消除；用户点开 agent 详情时
 * 调用方显式 clear（fire clear_agent_attention RPC）。
 *
 * 副作用（tabBar 徽标 / 振动）通过注入的 SideEffects 触发：
 * 平台 API 不进 store 本体，保持纯 TS 可单测（同 permission-store 模式）。
 */

import type { AttentionPush } from "@/connection/protocol-types";

export interface AttentionEntry {
  agentId: string;
  reason: AttentionPush["reason"];
  timestamp: string;
}

export interface AttentionSideEffects {
  /** attention 数量变化（0 = 清徽标）。 */
  onCountChange?: (count: number) => void;
  /** 新 attention 推送到达（shouldNotify 时；振动/toast 由宿主决定）。 */
  onNotify?: (entry: AttentionEntry, push: AttentionPush) => void;
}

type Listener = () => void;

class AttentionStore {
  private entries = new Map<string, AttentionEntry>();
  private listeners = new Set<Listener>();
  private effects: AttentionSideEffects = {};
  /** 已提示过的 agent 集合：同一 agent 反复 finished 只振动一次，直到被清除。 */
  private notified = new Set<string>();
  private vibrationEnabled = true;

  /** connection-manager 注入平台副作用（tabBar 徽标 / 振动）。 */
  bindSideEffects(effects: AttentionSideEffects | null): void {
    this.effects = effects ?? {};
  }

  setVibrationEnabled(enabled: boolean): void {
    this.vibrationEnabled = enabled;
  }

  isVibrationEnabled(): boolean {
    return this.vibrationEnabled;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AttentionEntry[] => {
    return [...this.entries.values()];
  };

  getCount(): number {
    return this.entries.size;
  }

  has(agentId: string): boolean {
    return this.entries.has(agentId);
  }

  /** daemon attention 推送。 */
  handlePush(push: AttentionPush): void {
    const entry: AttentionEntry = {
      agentId: push.agentId,
      reason: push.reason,
      timestamp: push.timestamp,
    };
    const existed = this.entries.has(push.agentId);
    this.entries.set(push.agentId, entry);
    this.notifyListeners();
    if (!existed && push.shouldNotify) {
      const firstTime = !this.notified.has(push.agentId);
      this.notified.add(push.agentId);
      this.effects.onNotify?.(
        entry,
        firstTime && this.vibrationEnabled ? push : { ...push, shouldNotify: false },
      );
    }
  }

  /** agent_update 快照同步：requiresAttention=false 时清除该 agent 的红点。 */
  syncAgentSnapshot(agent: { id: string; requiresAttention?: boolean }): void {
    if (agent.requiresAttention) {
      if (!this.entries.has(agent.id)) {
        this.entries.set(agent.id, {
          agentId: agent.id,
          reason: "finished",
          timestamp: "",
        });
        this.notifyListeners();
      }
      return;
    }
    if (this.entries.delete(agent.id)) {
      this.notified.delete(agent.id);
      this.notifyListeners();
    }
  }

  /** 本端主动清除（打开详情 / 全部已读）。 */
  clear(agentIds: string[]): void {
    let changed = false;
    for (const id of agentIds) {
      if (this.entries.delete(id)) {
        this.notified.delete(id);
        changed = true;
      }
    }
    if (changed) this.notifyListeners();
  }

  /** 断线/切换设备：全清并复位提示去重。 */
  clearAll(): void {
    if (this.entries.size === 0 && this.notified.size === 0) return;
    this.entries.clear();
    this.notified.clear();
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
    this.effects.onCountChange?.(this.entries.size);
  }
}

/** 单例经 globalThis 固定（原因见 permission-store.ts 同款注释）。 */
const GLOBAL_KEY = "__aaswitch_attention_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: AttentionStore };
export const attentionStore: AttentionStore = (globalScope[GLOBAL_KEY] ??= new AttentionStore());
