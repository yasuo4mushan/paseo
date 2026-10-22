/**
 * 权限请求全局状态机（t16）。
 *
 * daemon 推送 agent_permission_request → 这里排队；任何页面挂载的
 * PermissionOverlay 从 store 渲染弹层；用户选择动作 → respond 回调
 * （由 connection-manager 注入 respondToPermission RPC）→ 本端立即出队，
 * agent_permission_resolved 推送兜底清理（含其他端已回应的场景）。
 *
 * 平台无关：不 import Taro/React，纯 TS 状态 + 订阅，方便单测。
 */

import type {
  PermissionRequestPush,
  PermissionResolvedPush,
  PermissionResponsePayload,
} from "@/connection/protocol-types";
import { parsePermissionRequest } from "@/connection/protocol-types";

export interface PendingPermission {
  /** 去重键：agentId + 权限请求 id。 */
  key: string;
  agentId: string;
  request: PermissionRequestPush["request"];
}

export type RespondSender = (
  agentId: string,
  permissionRequestId: string,
  response: PermissionResponsePayload,
) => void;

type Listener = () => void;

export function permissionKey(agentId: string, requestId: string): string {
  return `${agentId}:${requestId}`;
}

class PermissionStore {
  private queue: PendingPermission[] = [];
  private listeners = new Set<Listener>();
  private sender: RespondSender | null = null;

  /** connection-manager 连接成功时注入 respond 发送器；断开时置空。 */
  bindSender(sender: RespondSender | null): void {
    this.sender = sender;
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): PendingPermission[] => {
    return this.queue;
  };

  /** daemon 推送新权限请求（按 key 去重，重复推送不重复入队）。 */
  handlePush(push: PermissionRequestPush): void {
    // 入队前规范化（actions 补默认两档等）：连接层已解析过，这里兜住
    // 自动化桥/未来调用方直接喂原始 daemon 形状的情况，避免渲染层崩。
    const request = parsePermissionRequest(push.request);
    if (!request) return;
    const key = permissionKey(push.agentId, request.id);
    if (this.queue.some((pending) => pending.key === key)) return;
    this.queue = [...this.queue, { key, agentId: push.agentId, request }];
    this.notify();
  }

  /** daemon 推送权限已解决（本端或其他端回应过）；按 key 出队。 */
  handleResolved(push: PermissionResolvedPush): void {
    const key = permissionKey(push.agentId, push.requestId);
    if (!this.queue.some((pending) => pending.key === key)) return;
    this.queue = this.queue.filter((pending) => pending.key !== key);
    this.notify();
  }

  /** 用户在弹层上选择动作。返回 false 表示发送失败（弹层保持展示并提示）。 */
  respond(agentId: string, requestId: string, response: PermissionResponsePayload): boolean {
    if (!this.sender) return false;
    const key = permissionKey(agentId, requestId);
    let sendError: unknown = null;
    try {
      this.sender(agentId, requestId, response);
    } catch (error) {
      sendError = error;
    }
    if (sendError) return false;
    // 发送成功即出队（fire-and-forget；resolved 推送兜底）
    if (this.queue.some((pending) => pending.key === key)) {
      this.queue = this.queue.filter((pending) => pending.key !== key);
      this.notify();
    }
    return true;
  }

  /** 清空（断线/切换设备时调用，避免残留别的主机的请求）。 */
  clearAll(): void {
    if (this.queue.length === 0) return;
    this.queue = [];
    this.notify();
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * 单例经 globalThis 固定：Taro/webpack 会把 entry（app.ts）与页面公共块拆成
 * 两个 chunk，模块可能各带一份拷贝（t16 实测：自动化桥写入的实例与页面订阅的
 * 实例不一致，推送永远到不了弹层）。挂到 globalWith保证任何拷贝导出同一实例。
 */
const GLOBAL_KEY = "__aaswitch_permission_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: PermissionStore };
export const permissionStore: PermissionStore = (globalScope[GLOBAL_KEY] ??= new PermissionStore());
