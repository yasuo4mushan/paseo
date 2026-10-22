/**
 * 时间线展示组件（t20，从 pages/agent 提取共用）：气泡渲染
 * （用户/助手/思考/工具/todo/错误/通知/压缩）+ 附件卡片 + 时间戳。
 *
 * 纯展示；数据与订阅见 hooks/use-agent-session。
 */

import { Image, View } from "@tarojs/components";
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

function TodoLines({ items }: { items: Array<{ text: string; completed: boolean }> }) {
  return (
    <View>
      {items.map((task, i) => (
        <View key={i} className={`todo-line ${task.completed ? "todo-done" : ""}`}>
          <Image className="icon icon-sm todo-mark" src={toolStatusIcon(task.completed ? "completed" : "running")} />
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

export function TimelineView({ entries }: { entries: TimelineDisplay[] }) {
  return (
    <View>
      {entries.map((entry) => (
        <View key={entry.key} className="timeline-item">
          <View className={`timeline-row ${entry.item.type === "user_message" ? "row-user" : ""}`}>
            <View className={bubbleClass(entry.item)}>
              {entry.attachments ? <AttachmentCards cards={entry.attachments} /> : null}
              <BubbleContent item={entry.item} />
            </View>
          </View>
          {entry.timestamp ? (
            <View className={`timeline-clock ${entry.item.type === "user_message" ? "row-user" : ""}`}>
              {formatClock(entry.timestamp)}
            </View>
          ) : null}
        </View>
      ))}
    </View>
  );
}
