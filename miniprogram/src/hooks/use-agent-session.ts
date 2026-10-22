/**
 * 会话时间线订阅 hook（t20，从 pages/agent 提取共用）：
 * agentId → 快照 + 时间线尾部 + agent_stream 推送流，含乐观本地消息合并。
 *
 * 读取侧状态机（发送侧由页面持有）：
 *  - fetchAgents 全量里找自己（快照态 + 归档标记）；
 *  - fetch_agent_timeline 尾部 50 条；
 *  - agent.timeline.set_subscription 订阅增量（timeline 事件按 seq 去重合并）；
 *  - agent_update upsert 同步 status/snapshot；
 *  - daemon 回显 user_message（clientMessageId 匹配）取代乐观本地条目。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentSnapshot, AgentTimelineEntry, AgentTimelineItem } from "@/connection/protocol-types";
import { messageAttachmentStore, type AttachmentCard } from "@/stores/message-attachment-store";

export interface TimelineDisplay {
  key: string;
  seq: number;
  item: AgentTimelineItem;
  timestamp: string;
  attachments?: AttachmentCard[];
}

export function timelineToDisplay(agentId: string, entry: AgentTimelineEntry): TimelineDisplay {
  const attachments =
    entry.item.type === "user_message" ? messageAttachmentStore.match(agentId, entry.item) : [];
  return {
    key: `s${entry.seqStart}`,
    seq: entry.seqStart,
    item: entry.item,
    timestamp: entry.timestamp,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function useAgentSession(agentId: string): {
  snapshot: AgentSnapshot | null;
  entries: TimelineDisplay[];
  status: string;
  error: string;
  /** 乐观追加本地用户消息（daemon 回显后按 clientMessageId 去重取代）。 */
  appendOptimisticUser: (text: string, clientMessageId: string, cards?: AttachmentCard[]) => void;
} {
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [entries, setEntries] = useState<TimelineDisplay[]>([]);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const bumpRef = useRef(0);

  useEffect(() => {
    if (!agentId) return;
    let disposed = false;
    const conn = connectionManager.getConnection();
    if (!conn) {
      setError("未连接设备，请返回重连");
      return;
    }

    const appendEntries = (incoming: TimelineDisplay[]) => {
      if (disposed || incoming.length === 0) return;
      setEntries((prev) => {
        const seen = new Set(prev.map((e) => e.key));
        const merged = [...prev];
        const confirmedIds = new Set(
          incoming
            .filter((e) => e.item.type === "user_message" && e.item.clientMessageId)
            .map((e) => (e.item as { clientMessageId: string }).clientMessageId),
        );
        for (let i = merged.length - 1; i >= 0; i -= 1) {
          const entry = merged[i];
          if (
            entry.key.startsWith("local-") &&
            entry.item.type === "user_message" &&
            entry.item.clientMessageId &&
            confirmedIds.has(entry.item.clientMessageId)
          ) {
            merged.splice(i, 1);
          }
        }
        for (const entry of incoming) {
          if (!seen.has(entry.key)) merged.push(entry);
        }
        merged.sort((a, b) => a.seq - b.seq);
        // 只保留最近 200 条，防止长会话内存膨胀
        return merged.slice(-200);
      });
      bumpRef.current += 1;
    };

    void (async () => {
      try {
        const agents = await conn.fetchAgents({ includeArchived: true });
        if (disposed) return;
        const self = agents.find((a) => a.id === agentId);
        if (self) {
          setStatus(self.status);
          setSnapshot(self);
        }
        const timeline = await conn.fetchAgentTimeline(agentId, 50);
        if (disposed) return;
        appendEntries(timeline.map((entry) => timelineToDisplay(agentId, entry)));
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
            timelineToDisplay(agentId, {
              item: payload.event.item,
              timestamp: payload.timestamp,
              seqStart: payload.seq ?? Date.now(),
              seqEnd: payload.seq ?? Date.now(),
            }),
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
        setSnapshot(update.agent);
      }
    });

    return () => {
      disposed = true;
      unsubscribeStream();
      unsubscribeAgents();
    };
  }, [agentId]);

  const appendOptimisticUser = useMemo(
    () =>
      (text: string, clientMessageId: string, cards?: AttachmentCard[]) => {
        const localSeq = 9_000_000_000 + (Date.now() % 1_000_000_000);
        setEntries((prev) => [
          ...prev,
          {
            key: `local-${clientMessageId}`,
            seq: localSeq,
            item: { type: "user_message", text, clientMessageId },
            timestamp: new Date().toISOString(),
            ...(cards && cards.length > 0 ? { attachments: cards } : {}),
          },
        ]);
      },
    [],
  );

  return { snapshot, entries, status, error, appendOptimisticUser };
}
