/**
 * 时间线消息操作状态机（t25）：长按/"…"操作单的可用项、编辑模式的裁决、
 * 复制/引用的文本构造。纯函数（页面胶水见 hooks/use-message-actions）。
 *
 * 编辑语义（考古 packages/app 的结论，无独立"编辑已发消息"协议）：
 *  - app 的用户消息操作是 RewindMenu → agent.rewind.request(mode) 回退会话，
 *    回退成功后把原文放回 composer 草稿（composer-restore），用户改完再发。
 *  - 小程序把它收敛成一步"编辑重发"：气泡进入编辑态（textarea 预填原文），
 *    保存 = rewind conversation + 重发修正文本（"rewind" 模式）。
 *  - provider 不支持回退（capabilities.supportsRewindConversation 缺省 false）
 *    或乐观本地条目（daemon 未回执、无 messageId）→ "draft" 模式降级：
 *    修正文本填入 composer 作为新消息草稿，不发明协议。
 */

import type { AgentTimelineItem } from "@/connection/protocol-types";

export type MessageActionKey = "copy" | "edit" | "quote";

export interface MessageActionItem {
  key: MessageActionKey;
  label: string;
}

/** 编辑（重发）模式：rewind = 回退到该消息后重发；draft = 作为新消息草稿。 */
export type MessageEditMode = "rewind" | "draft";

export interface MessageActionContext {
  item: AgentTimelineItem;
  /** provider 能力（AgentSnapshot.capabilities.supportsRewindConversation）。 */
  canRewind: boolean;
}

/** 操作单可用项：仅用户/assistant 消息有操作层，用户消息多"编辑重发"。 */
export function messageActionsFor({ item, canRewind }: MessageActionContext): MessageActionItem[] {
  if (item.type !== "user_message" && item.type !== "assistant_message") return [];
  const items: MessageActionItem[] = [{ key: "copy", label: "复制" }];
  if (item.type === "user_message") {
    items.push({
      key: "edit",
      label: canRewind && item.messageId ? "编辑重发" : "编辑（作新消息）",
    });
  }
  items.push({ key: "quote", label: "引用复制" });
  return items;
}

/**
 * 编辑模式裁决：非用户消息不可编辑；有 daemon messageId 且 provider 支持回退
 * → rewind（会话回退到该消息之前再重发）；否则 draft（草稿降级）。
 * canRewind 只影响 rewind 可用性，不吞掉编辑入口（总有降级路径）。
 */
export function editModeFor({ item, canRewind }: MessageActionContext): MessageEditMode | null {
  if (item.type !== "user_message") return null;
  if (canRewind && item.messageId) return "rewind";
  return "draft";
}

/** 编辑态气泡内的语义提示（用户在保存前需要知道后果）。 */
export function editHintFor(mode: MessageEditMode): string {
  if (mode === "rewind") {
    return "保存后回退到这条消息并重新发送，其后的对话会被撤回。";
  }
  return "当前会话不支持回退，修改后将填入输入框作为新消息发送。";
}

/**
 * 复制文本：一律原始文本（assistant 的 markdown 消息复制其 markdown 原文
 * item.text，不是渲染后的富文本；用户消息即原文）。其余条目类型无操作层。
 */
export function copyTextFor(item: AgentTimelineItem): string | null {
  if (item.type === "user_message" || item.type === "assistant_message") return item.text;
  return null;
}

/** 引用文本（P2）：会话标题 + 消息摘要，作为分享文本复制。 */
export function quoteTextFor(title: string | null, text: string, maxLen = 160): string {
  const clipped =
    text.length > maxLen ? `${text.slice(0, maxLen).trimEnd()}…` : text.replace(/\s+$/, "");
  const header = title?.trim() ? title.trim() : "会话消息";
  return `${header}\n\n> ${clipped.replace(/\n/g, "\n> ")}`;
}

/**
 * 操作单点选分发：wx.showActionSheet 只回 tapIndex，这里映射回动作项。
 * 越界（面板并发改动等）返回 null 由调用方静默。
 */
export function actionForTapIndex(
  items: MessageActionItem[],
  tapIndex: number,
): MessageActionItem | null {
  return items[tapIndex] ?? null;
}
