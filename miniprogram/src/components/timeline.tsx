/**
 * 时间线展示组件（t20，从 pages/agent 提取共用）：气泡渲染
 * （用户/助手/思考/工具/todo/错误/通知/压缩）+ 附件卡片 + 时间戳。
 *
 * t25 操作层（可选 props，不传则渲染与 t20 完全一致）：
 *  - 用户/assistant 气泡支持长按或"…"按钮呼出操作单（复制/编辑重发/引用），
 *    回调 onMessageAction；交互与 RPC 编排见 hooks/use-message-actions。
 *  - 编辑态：editingKey 命中的用户气泡内联 textarea（预填原文），
 *    保存/取消走 onEditSubmit/onEditCancel（页面持有编辑状态机）。
 * 纯展示；数据与订阅见 hooks/use-agent-session。
 */

import { useState } from "react";
import { Image, Textarea, View } from "@tarojs/components";
import type { AgentTimelineItem } from "@/connection/protocol-types";
import { MarkdownView } from "@/components/markdown";
import { iconUrl } from "@/utils/icons";
import { formatFileSize } from "@/utils/files";
import { previewImage } from "@/utils/file-ops";
import type { AttachmentCard } from "@/stores/message-attachment-store";
import type { TimelineDisplay } from "@/hooks/use-agent-session";
import { formatClock } from "@/utils/time";

/** 工具调用状态 → 线条图标（t20 去 emoji）。 */
function toolStatusIcon(status: string): string {
  if (status === "completed") return iconUrl("check", "-active");
  if (status === "failed") return iconUrl("close", "-danger");
  if (status === "canceled") return iconUrl("close");
  return iconUrl("schedule", "-warning");
}

function bubbleClass(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
      return "bubble bubble-user";
    case "assistant_message":
      return "bubble bubble-assistant";
    case "reasoning":
      return "bubble bubble-reasoning";
    case "tool_call":
      return "bubble bubble-tool";
    case "todo":
      return "bubble bubble-todo";
    case "error":
      return "bubble bubble-error";
    case "notification":
      return "bubble bubble-notification";
    default:
      return "bubble bubble-plain";
  }
}

/** t25：可操作条目（仅用户/assistant 消息有操作单）。 */
function isActionable(item: AgentTimelineItem): boolean {
  return item.type === "user_message" || item.type === "assistant_message";
}

function TodoLines({ items }: { items: Array<{ text: string; completed: boolean }> }) {
  return (
    <View>
      {items.map((task, i) => (
        <View key={i} className={`todo-line ${task.completed ? "todo-done" : ""}`}>
          <Image
            className="icon icon-sm todo-mark"
            src={toolStatusIcon(task.completed ? "completed" : "running")}
          />
          <View className="todo-text">{task.text}</View>
        </View>
      ))}
    </View>
  );
}

function AttachmentCards({ cards }: { cards: AttachmentCard[] }) {
  if (cards.length === 0) return null;
  return (
    <View className="attach-cards">
      {cards.map((card, i) =>
        card.kind === "image" && card.localPath ? (
          <Image
            key={i}
            className="attach-image"
            src={card.localPath}
            mode="aspectFill"
            onClick={(e) => {
              // 阻止冒泡：点缩略图全屏预览，不触发气泡其他行为
              e.stopPropagation?.();
              previewImage(card.localPath as string);
            }}
          />
        ) : (
          <View key={i} className="attach-file">
            <Image className="icon" src={iconUrl("paperclip")} />
            <View className="attach-file-main">
              <View className="attach-file-name">{card.fileName}</View>
              <View className="attach-file-size">{formatFileSize(card.size)}</View>
            </View>
          </View>
        ),
      )}
    </View>
  );
}

function BubbleContent({ item }: { item: AgentTimelineItem }) {
  switch (item.type) {
    case "tool_call":
      return (
        <View>
          <View className="tool-head">
            <Image className="icon icon-sm" src={toolStatusIcon(item.status)} />
            <View className="tool-name">{item.tool}</View>
          </View>
          {item.summary ? <View className="tool-summary">{item.summary}</View> : null}
          {item.error ? <View className="tool-error">{item.error}</View> : null}
        </View>
      );
    case "todo":
      return <TodoLines items={item.items} />;
    case "error":
      return <View>{item.message}</View>;
    case "notification":
      return <View>{item.message}</View>;
    case "compaction":
      return <View>{item.status === "completed" ? "上下文压缩完成" : "上下文压缩中…"}</View>;
    case "user_message":
      return <View className="bubble-text">{item.text}</View>;
    case "assistant_message":
      return <MarkdownView text={item.text} />;
    case "reasoning":
      return <View className="bubble-text">{item.text}</View>;
    default:
      return <View className="bubble-text">（暂不支持展示的条目类型）</View>;
  }
}

/**
 * t25 气泡内联编辑态：textarea 预填原文（内部状态，避免每键击穿透页面），
 * hint 说明保存后果（rewind 撤回 vs 草稿降级），保存/取消交页面状态机。
 */
function BubbleEdit({
  initialText,
  hint,
  saving,
  onSubmit,
  onCancel,
}: {
  initialText: string;
  hint: string;
  saving: boolean;
  onSubmit: (text: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState(initialText);
  return (
    <View className="msg-edit">
      <Textarea
        className="msg-edit-area"
        value={text}
        onInput={(e) => setText(e.detail.value)}
        maxlength={8000}
        autoHeight
        showConfirmBar={false}
        disabled={saving}
        focus
      />
      <View className="msg-edit-hint">{hint}</View>
      <View className="msg-edit-row">
        <View
          className={`msg-edit-btn msg-edit-cancel ${saving ? "msg-edit-disabled" : ""}`}
          onClick={onCancel}
        >
          取消
        </View>
        <View
          className={`msg-edit-btn msg-edit-save ${saving ? "msg-edit-disabled" : ""}`}
          onClick={() => onSubmit(text)}
        >
          {saving ? "发送中…" : "发送修改"}
        </View>
      </View>
    </View>
  );
}

export interface TimelineViewProps {
  entries: TimelineDisplay[];
  /** t25：长按/"…"操作单入口；不传则整个操作层不渲染。 */
  onMessageAction?: (entry: TimelineDisplay) => void;
  /** t25：正在编辑的条目 key（气泡切内联 textarea）。 */
  editingKey?: string;
  /** t25：编辑态提示文案（语义随 rewind/draft 模式不同，页面注入）。 */
  editHint?: string;
  /** t25：编辑保存中（rewind RPC 在途时禁用按钮）。 */
  editSaving?: boolean;
  onEditSubmit?: (entry: TimelineDisplay, text: string) => void;
  onEditCancel?: () => void;
}

export function TimelineView({
  entries,
  onMessageAction,
  editingKey,
  editHint,
  editSaving = false,
  onEditSubmit,
  onEditCancel,
}: TimelineViewProps) {
  const actionable = onMessageAction !== undefined;
  return (
    <View>
      {entries.map((entry) => {
        const canOperate = actionable && isActionable(entry.item);
        const editing = editingKey !== undefined && editingKey === entry.key;
        const bubble = (
          <View
            className={bubbleClass(entry.item)}
            onLongPress={canOperate ? () => onMessageAction?.(entry) : undefined}
          >
            {entry.attachments ? <AttachmentCards cards={entry.attachments} /> : null}
            {editing && entry.item.type === "user_message" && onEditSubmit ? (
              <BubbleEdit
                initialText={entry.item.text}
                hint={editHint ?? ""}
                saving={editSaving}
                onSubmit={(text) => onEditSubmit(entry, text)}
                onCancel={() => onEditCancel?.()}
              />
            ) : (
              <BubbleContent item={entry.item} />
            )}
          </View>
        );
        return (
          <View key={entry.key} className="timeline-item">
            <View
              className={`timeline-row ${entry.item.type === "user_message" ? "row-user" : ""}`}
            >
              {/* 用户气泡靠右："…"在左侧；assistant 气泡靠左："…"在右侧 */}
              {canOperate && entry.item.type === "user_message" ? (
                <View className="msg-more" onClick={() => onMessageAction?.(entry)}>
                  <Image className="icon icon-sm" src={iconUrl("more")} />
                </View>
              ) : null}
              {bubble}
              {canOperate && entry.item.type !== "user_message" ? (
                <View className="msg-more" onClick={() => onMessageAction?.(entry)}>
                  <Image className="icon icon-sm" src={iconUrl("more")} />
                </View>
              ) : null}
            </View>
            {entry.timestamp ? (
              <View
                className={`timeline-clock ${entry.item.type === "user_message" ? "row-user" : ""}`}
              >
                {formatClock(entry.timestamp)}
              </View>
            ) : null}
          </View>
        );
      })}
    </View>
  );
}
