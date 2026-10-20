import { useEffect, useRef, useState } from "react";
import { useLoad } from "@tarojs/taro";
import { Button, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentTimelineEntry, AgentTimelineItem } from "@/connection/protocol-types";
import { STATUS_LABELS } from "@/constants/status";
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

function itemPreview(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "tool_call":
      return `[工具] ${item.tool}${item.summary ? `：${item.summary}` : ""}`;
    case "todo":
      return item.items.map((t) => `${t.completed ? "✓" : "○"} ${t.text}`).join("\n");
    case "error":
      return `错误：${item.message}`;
    case "notification":
      return `通知：${item.message}`;
    case "compaction":
      return item.status === "completed" ? "上下文压缩完成" : "上下文压缩中…";
    default:
      return "（暂不支持展示的条目类型）";
  }
}

function itemClass(item: AgentTimelineItem): string {
  switch (item.type) {
    case "user_message":
      return "entry-user";
    case "assistant_message":
      return "entry-assistant";
    case "reasoning":
      return "entry-reasoning";
    case "error":
      return "entry-error";
    case "tool_call":
    case "todo":
    case "notification":
    case "compaction":
      return "entry-system";
    default:
      return "entry-system";
  }
}

export default function AgentPage() {
  const [agentId, setAgentId] = useState("");
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
      setError("未连接 daemon，请返回列表页重连");
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
        {error ? <View className="card error-inline">{error}</View> : null}
        {entries.length === 0 ? (
          <View className="muted empty-timeline">暂无消息</View>
        ) : (
          entries.map((entry) => (
            <View key={entry.key} className={`entry ${itemClass(entry.item)}`}>
              <View className="entry-text">{itemPreview(entry.item)}</View>
            </View>
          ))
        )}
        <View id={bottomAnchor.current} className="timeline-bottom" />
      </ScrollView>
      <View className="composer">
        {status ? (
          <View className={`composer-status ${status === "running" ? "is-running" : ""}`}>
            {STATUS_LABELS[status] ?? status}
          </View>
        ) : null}
        <View className="composer-row">
          <Input
            className="composer-input"
            value={draft}
            onInput={(e) => setDraft(e.detail.value)}
            onConfirm={() => void send()}
            placeholder="输入消息发送给 agent…"
            confirmType="send"
          />
          <Button
            className="button send-btn"
            size="mini"
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
