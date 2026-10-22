import { useEffect, useRef, useState } from "react";
import Taro, { useLoad } from "@tarojs/taro";
import { Button, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentTimelineEntry, AgentTimelineItem } from "@/connection/protocol-types";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { formatClock } from "@/utils/time";
import "./index.css";

interface DisplayEntry {
  key: string;
  seq: number;
  item: AgentTimelineItem;
  timestamp: string;
}

function toDisplay(entry: AgentTimelineEntry): DisplayEntry {
  return {
    key: `s${entry.seqStart}`,
    seq: entry.seqStart,
    item: entry.item,
    timestamp: entry.timestamp,
  };
}

const TOOL_STATUS_ICON: Record<string, string> = {
  running: "⏳",
  completed: "✓",
  failed: "✗",
  canceled: "–",
};

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
          <View className="todo-check">{task.completed ? "✓" : "○"}</View>
          <View className="todo-text">{task.text}</View>
        </View>
      ))}
    </View>
  );
}

function BubbleContent({ item }: { item: AgentTimelineItem }) {
  switch (item.type) {
    case "tool_call":
      return (
        <View>
          <View className="tool-head">
            <View className="tool-icon">{TOOL_STATUS_ICON[item.status] ?? "⏳"}</View>
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
    case "assistant_message":
    case "reasoning":
      return <View className="bubble-text">{item.text}</View>;
    default:
      return <View className="bubble-text">（暂不支持展示的条目类型）</View>;
  }
}

export default function AgentPage() {
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const bottomAnchor = useRef(`bottom-${Date.now()}`);

  useLoad((options) => {
    const id = options?.id ? decodeURIComponent(options.id) : "";
    if (id) setAgentId(id);
  });

  useEffect(() => {
    if (!agentId) return;
    let disposed = false;
    const conn = connectionManager.getConnection();
    if (!conn) {
      setError("未连接设备，请返回重连");
      return;
    }

    const appendEntries = (incoming: DisplayEntry[]) => {
      if (disposed || incoming.length === 0) return;
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.key));
        const merged = [...prev];
        for (const entry of incoming) {
          if (!seen.has(entry.key)) merged.push(entry);
        }
        merged.sort((a, b) => a.seq - b.seq);
        // 只保留最近 200 条，防止长会话内存膨胀
        return merged.slice(-200);
      });
      bottomAnchor.current = `bottom-${Date.now()}`;
    };

    void (async () => {
      try {
        const agents = await conn.fetchAgents();
        const self = agents.find((a) => a.id === agentId);
        if (self) {
          setStatus(self.status);
          const navTitle = self.title ?? self.id.slice(0, 8);
          setTitle(navTitle);
          Taro.setNavigationBarTitle({ title: navTitle });
        }
        const timeline = await conn.fetchAgentTimeline(agentId, 50);
        appendEntries(timeline.map(toDisplay));
        await conn.subscribeAgentTimelines([agentId]);
        setError("");
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const unsubscribeStream = connectionManager.onStreamEvent((payload) => {
      if (payload.agentId !== agentId) return;
      switch (payload.event.type) {
        case "timeline":
          appendEntries([
            {
              key: `s${payload.seq ?? Date.now()}`,
              seq: payload.seq ?? Date.now(),
              item: payload.event.item,
              timestamp: payload.timestamp,
            },
          ]);
          break;
        case "turn_started":
          setStatus("running");
          break;
        case "turn_completed":
        case "turn_canceled":
          setStatus("idle");
          break;
        case "turn_failed":
          setStatus("error");
          break;
        default:
          break;
      }
    });

    const unsubscribeAgents = connectionManager.onAgentUpdate((update) => {
      if (update.kind === "upsert" && update.agent.id === agentId) {
        setStatus(update.agent.status);
      }
    });

    return () => {
      disposed = true;
      unsubscribeStream();
      unsubscribeAgents();
    };
  }, [agentId]);

  const send = async () => {
    const text = draft.trim();
    if (!text || !agentId || sending) return;
    setSending(true);
    setDraft("");
    // 乐观追加本地用户消息（daemon 回推的 user_message 由 seq 去重）
    const localSeq = 9_000_000_000 + (Date.now() % 1_000_000_000);
    setEntries((prev) => [
      ...prev,
      {
        key: `local-${Date.now()}`,
        seq: localSeq,
        item: { type: "user_message", text },
        timestamp: new Date().toISOString(),
      },
    ]);
    bottomAnchor.current = `bottom-${Date.now()}`;
    try {
      const conn = connectionManager.requireConnection();
      const result = await conn.sendAgentMessage(agentId, text);
      if (!result.accepted) {
        setError(result.error ?? "消息未被接受");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <View className="agent-page">
      <ScrollView
        className="timeline"
        scrollY
        scrollIntoView={bottomAnchor.current}
        enhanced
        showScrollbar={false}
      >
        {error ? <View className="error-inline error-in-timeline">{error}</View> : null}
        {entries.length === 0 ? (
          <View className="card empty">
            <View className="empty-icon">💬</View>
            <View className="empty-title">暂无消息</View>
            <View className="empty-desc">在下方输入框给 agent 发第一条指令。</View>
          </View>
        ) : (
          entries.map((entry) => (
            <View key={entry.key} className="timeline-item">
              <View className={`timeline-row ${entry.item.type === "user_message" ? "row-user" : ""}`}>
                <View className={bubbleClass(entry.item)}>
                  <BubbleContent item={entry.item} />
                </View>
              </View>
              {entry.timestamp ? (
                <View className={`timeline-clock ${entry.item.type === "user_message" ? "row-user" : ""}`}>
                  {formatClock(entry.timestamp)}
                </View>
              ) : null}
            </View>
          ))
        )}
        <View id={bottomAnchor.current} className="timeline-bottom" />
      </ScrollView>
      <View className="composer">
        <View className="composer-head">
          {status ? (
            <View className={statusPillClass(status)}>{STATUS_LABELS[status] ?? status}</View>
          ) : null}
          {title ? <View className="faint composer-title">{title}</View> : null}
        </View>
        <View className="composer-row">
          <Input
            className="composer-input"
            value={draft}
            onInput={(e) => setDraft(e.detail.value)}
            onConfirm={() => void send()}
            placeholder="输入消息发送给 agent…"
            placeholderClass="composer-placeholder"
            confirmType="send"
            confirmHold
          />
          <Button
            className={`btn send-btn ${draft.trim() && !sending ? "send-ready" : ""}`}
            disabled={sending || !draft.trim()}
            onClick={() => void send()}
          >
            发送
          </Button>
        </View>
      </View>
    </View>
  );
}
