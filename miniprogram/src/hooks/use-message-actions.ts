/**
 * 时间线消息操作胶水层（t25）：utils/message-actions 状态机 + Taro 交互
 * （操作单/剪贴板/toast）+ rewind RPC 编排。chat 主页与 agent 详情页共用。
 *
 * 编辑重发编排（rewind 模式）：
 *   rewindAgent(conversation) → reload()（daemon 时间线已重置，本地重取）
 *   → resend(text)（页面注入的发送通道，乐观追加同常规发送）。
 * rewind 失败保留编辑态（如 provider 未回执前不可回退）；rewind 成功但重发
 * 失败时降级 applyDraft 兜底，避免修正文本丢失。
 *
 * 平台纪律：useState/useRef，不用 useSyncExternalStore；hook 只在页面层使用。
 */

import { useCallback, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { connectionManager } from "@/connection/connection-manager";
import type { TimelineDisplay } from "@/hooks/use-agent-session";
import {
  actionForTapIndex,
  copyTextFor,
  editHintFor,
  editModeFor,
  messageActionsFor,
  quoteTextFor,
  type MessageEditMode,
} from "@/utils/message-actions";
import { recordAutomationEvent } from "@/utils/automation-log";

export interface MessageEditingState {
  entry: TimelineDisplay;
  mode: MessageEditMode;
  hint: string;
}

export interface UseMessageActionsInput {
  agentId: string;
  /** provider 能力（AgentSnapshot.capabilities.supportsRewindConversation）。 */
  canRewind: boolean;
  /** 引用文本的会话标题。 */
  title: string | null;
  /** rewind 成功后重载时间线（useAgentSession.reload）。 */
  reload: () => void | Promise<void>;
  /** rewind 模式保存后的重发通道（页面常规发送的文本路径）。 */
  resend: (text: string) => Promise<void> | void;
  /** draft 模式保存后的草稿注入（composer 输入框）。 */
  applyDraft: (text: string) => void;
}

export function useMessageActions({
  agentId,
  canRewind,
  title,
  reload,
  resend,
  applyDraft,
}: UseMessageActionsInput) {
  const [editing, setEditing] = useState<MessageEditingState | null>(null);
  const [editSaving, setEditSaving] = useState(false);
  const canRewindRef = useRef(canRewind);
  canRewindRef.current = canRewind;

  /** 长按/"…"入口：操作单（复制 / 编辑重发 / 引用复制）。 */
  const openActions = useCallback(
    async (entry: TimelineDisplay) => {
      const item = entry.item;
      const items = messageActionsFor({ item, canRewind: canRewindRef.current });
      if (items.length === 0) return;
      let tapIndex: number;
      try {
        const res = await Taro.showActionSheet({ itemList: items.map((i) => i.label) });
        tapIndex = res.tapIndex;
      } catch {
        return; // 用户取消
      }
      const action = actionForTapIndex(items, tapIndex);
      if (!action) return;
      recordAutomationEvent({
        kind: "message_action",
        action: action.key,
        itemType: item.type,
        agentId,
      });
      if (action.key === "copy") {
        const text = copyTextFor(item);
        if (text === null) return;
        try {
          await Taro.setClipboardData({ data: text });
          Taro.showToast({ title: "已复制", icon: "none", duration: 800 });
        } catch {
          Taro.showToast({ title: "复制失败", icon: "none" });
        }
        return;
      }
      if (action.key === "quote") {
        const text = copyTextFor(item) ?? "";
        try {
          await Taro.setClipboardData({ data: quoteTextFor(title, text) });
          Taro.showToast({ title: "引用已复制", icon: "none", duration: 800 });
        } catch {
          Taro.showToast({ title: "复制失败", icon: "none" });
        }
        return;
      }
      // edit：进入气泡编辑态（模式由状态机裁决）
      const mode = editModeFor({ item, canRewind: canRewindRef.current });
      if (!mode) return;
      recordAutomationEvent({ kind: "message_edit", mode, agentId });
      setEditing({ entry, mode, hint: editHintFor(mode) });
    },
    [agentId, title],
  );

  /** 编辑保存：rewind → reload → resend；draft → applyDraft。失败保留编辑态。 */
  const submitEdit = useCallback(
    async (text: string) => {
      if (!editing || editSaving) return;
      const trimmed = text.trim();
      if (!trimmed) {
        Taro.showToast({ title: "内容为空", icon: "none" });
        return;
      }
      const { entry, mode } = editing;
      if (mode === "draft") {
        setEditing(null);
        applyDraft(trimmed);
        Taro.showToast({ title: "已填入输入框", icon: "none", duration: 800 });
        return;
      }
      const messageId = entry.item.type === "user_message" ? entry.item.messageId : undefined;
      if (!messageId || !agentId) {
        // rewind 前置条件在中途失效（如快照刷新）：降级草稿
        setEditing(null);
        applyDraft(trimmed);
        Taro.showToast({ title: "已填入输入框", icon: "none", duration: 800 });
        return;
      }
      setEditSaving(true);
      Taro.showLoading({ title: "回退中…", mask: true });
      try {
        await connectionManager.requireConnection().rewindAgent(agentId, messageId, "conversation");
        await reload();
        setEditing(null);
        try {
          await resend(trimmed);
          recordAutomationEvent({ kind: "message_edit_resent", mode, agentId });
          Taro.showToast({ title: "已重发", icon: "success", duration: 800 });
        } catch (err) {
          // rewind 已成功但重发失败：草稿兜底，修正文本不丢
          applyDraft(trimmed);
          Taro.showToast({
            title: `重发失败已存草稿：${err instanceof Error ? err.message : String(err)}`,
            icon: "none",
            duration: 2500,
          });
        }
      } catch (err) {
        // rewind 失败（provider 未回执/能力缺失）：保留编辑态供重试或取消
        Taro.showToast({
          title: err instanceof Error ? err.message : String(err),
          icon: "none",
          duration: 2500,
        });
      } finally {
        Taro.hideLoading();
        setEditSaving(false);
      }
    },
    [editing, editSaving, agentId, reload, resend, applyDraft],
  );

  const cancelEdit = useCallback(() => {
    if (editSaving) return;
    setEditing(null);
  }, [editSaving]);

  return { editing, editSaving, openActions, submitEdit, cancelEdit };
}
