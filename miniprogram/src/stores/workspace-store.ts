/**
 * 当前工作区选择（t16）：Agent 列表页顶部展示、创建 agent 的默认目标。
 * 选择持久化到本机 storage（按连接目标隔离，切换设备后重新选）。
 *
 * 平台无关纯 TS 状态 + 订阅；storage 读写由调用方（页面）在 fetch 后写入。
 */

import type { WorkspaceDescriptor } from "@/connection/protocol-types";

type Listener = () => void;

export interface WorkspaceSelection {
  workspaceId: string;
  /** 展示名：title 优先，其次 name。 */
  label: string;
  /** 创建 agent 用的工作目录：workspaceDirectory 优先，其次项目根。 */
  directory: string;
}

export function toSelection(workspace: WorkspaceDescriptor): WorkspaceSelection {
  return {
    workspaceId: workspace.id,
    label: workspace.title ?? workspace.name,
    directory: workspace.workspaceDirectory ?? workspace.projectRootPath,
  };
}

export function workspaceLabel(workspace: WorkspaceDescriptor): string {
  return `${workspace.projectDisplayName} / ${workspace.title ?? workspace.name}`;
}

class WorkspaceStore {
  private selection: WorkspaceSelection | null = null;
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): WorkspaceSelection | null => {
    return this.selection;
  };

  /** 从 storage 恢复（页面挂载时调用；返回是否有已存选择）。 */
  restore(): boolean {
    if (this.selection) return true;
    const raw = this.getStorage();
    if (!raw) return false;
    this.selection = raw;
    this.notify();
    return true;
  }

  select(workspace: WorkspaceDescriptor): WorkspaceSelection {
    const next = toSelection(workspace);
    this.selection = next;
    this.setStorage(next);
    this.notify();
    return next;
  }

  /** 断开/切换设备时清除（不同 daemon 的工作区 id 不通用）。 */
  clear(persist = true): void {
    this.selection = null;
    if (persist) this.setStorage(null);
    this.notify();
  }

  // storage 钩子：小程序侧由 connection-manager 注入 Taro storage，
  // 单测/Node 下默认内存实现。
  private getStorage: () => WorkspaceSelection | null = () => null;
  private setStorageImpl: (value: WorkspaceSelection | null) => void = () => {};

  installStorage(get: () => WorkspaceSelection | null, set: (v: WorkspaceSelection | null) => void) {
    this.getStorage = get;
    this.setStorageImpl = set;
  }

  private setStorage(value: WorkspaceSelection | null): void {
    this.setStorageImpl(value);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 单例经 globalThis 固定（原因见 permission-store.ts 同款注释）。 */
const GLOBAL_KEY = "__aaswitch_workspace_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: WorkspaceStore };
export const workspaceStore: WorkspaceStore = (globalScope[GLOBAL_KEY] ??= new WorkspaceStore());
