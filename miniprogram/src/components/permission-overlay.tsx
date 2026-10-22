/**
 * 权限请求全局弹层（t16）。
 *
 * 小程序没有跨页面的全局浮层原语：每个页面根部挂一个 <PermissionOverlay />，
 * 数据来自 permissionStore（daemon 推送驱动），任意页面都能弹。
 * 交互：actions（协议支持几档就渲染几档，缺省两档=拒绝/允许）→ respond RPC。
 */

import { useCallback, useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, ScrollView, View } from "@tarojs/components";
import { permissionStore, type PendingPermission } from "@/permission/permission-store";
import {
  permissionKindLabel,
  permissionTitle,
  summarizePermissionInput,
} from "@/permission/summarize";
import "./permission-overlay.css";

export function PermissionOverlay() {
  // Taro 的 react-reconciler 下 useSyncExternalStore 的订阅更新不可靠，
  // 用 useState + useEffect 订阅保证推送后必渲染（初始快照 + 变更即拉）。
  const [queue, setQueue] = useState<PendingPermission[]>(() => permissionStore.getSnapshot());
  useEffect(
    () => permissionStore.subscribe(() => setQueue(permissionStore.getSnapshot())),
    [],
  );
  const pending = queue[0];
  if (!pending) return null;
  return <PermissionSheet key={pending.key} pending={pending} remaining={queue.length - 1} />;
}

function PermissionSheet({ pending, remaining }: { pending: PendingPermission; remaining: number }) {
  const { agentId, request } = pending;
  const inputSummary = summarizePermissionInput(request.input);

  const choose = useCallback(
    (actionId: string, behavior: "allow" | "deny") => {
      const ok = permissionStore.respond(
        agentId,
        request.id,
        behavior === "allow"
          ? { behavior: "allow", selectedActionId: actionId }
          : { behavior: "deny", selectedActionId: actionId, message: "Denied by user" },
      );
      if (!ok) {
        Taro.showToast({ title: "回应失败，请重试", icon: "none" });
      }
    },
    [agentId, request.id],
  );

  return (
    <View className="perm-mask">
      <View className="perm-sheet">
        <View className="perm-header">
          <View className="perm-kind">{permissionKindLabel(request.kind)}</View>
          {remaining > 0 ? (
            <View className="perm-remaining faint">还有 {remaining} 个待处理</View>
          ) : null}
        </View>
        <View className="perm-title">{permissionTitle(request)}</View>
        {request.description ? <View className="perm-desc muted">{request.description}</View> : null}
        {request.kind === "tool" && request.name ? (
          <View className="perm-tool-row">
            <View className="perm-tool-tag">工具</View>
            <View className="perm-tool-name">{request.name}</View>
          </View>
        ) : null}
        {inputSummary ? (
          <ScrollView className="perm-input" scrollY enhanced showScrollbar={false}>
            <View className="perm-input-text">{inputSummary}</View>
          </ScrollView>
        ) : null}
        <View className="perm-agent faint">Agent {agentId.slice(0, 8)}</View>
        <View className="perm-actions">
          {request.actions.map((action) => (
            <Button
              key={action.id}
              className={`perm-btn ${
                action.behavior === "allow" ? "perm-btn-allow" : "perm-btn-deny"
              } ${action.variant === "danger" ? "perm-btn-danger" : ""} ${
                action.variant === "primary" ? "perm-btn-primary" : ""
              }`}
              onClick={() => choose(action.id, action.behavior)}
            >
              {action.label}
            </Button>
          ))}
        </View>
        <View className="perm-hint faint">允许后 agent 将继续执行；拒绝会告知 agent 用户未授权</View>
      </View>
    </View>
  );
}
