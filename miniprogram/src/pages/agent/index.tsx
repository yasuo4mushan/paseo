import { useEffect, useRef, useState } from "react";
import Taro, { useLoad } from "@tarojs/taro";
import { Button, Image, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type {
  AgentSnapshot,
  AgentTimelineEntry,
  AgentTimelineItem,
  UploadedFileAttachment,
} from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { messageAttachmentStore, type AttachmentCard } from "@/stores/message-attachment-store";
import { displayLabels, setDisplayLabels } from "@/utils/agent-directory";
import { formatFileSize, mimeForFile } from "@/utils/files";
import { previewImage, readLocalFileBytes } from "@/utils/file-ops";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { formatClock } from "@/utils/time";
import "./index.css";

interface DisplayEntry {
  key: string;
  seq: number;
  item: AgentTimelineItem;
  timestamp: string;
  /** t17：user_message 气泡上的附件卡片（本地台账回配对）。 */
  attachments?: AttachmentCard[];
}

function toDisplay(agentId: string, entry: AgentTimelineEntry): DisplayEntry {
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

/** composer 待发送附件（t17）：选图/选文件 → 上传 → 随消息发送。 */
interface PendingAttachment {
  key: string;
  fileName: string;
  size: number;
  mimeType: string;
  localPath?: string;
  status: "uploading" | "ready" | "error";
  progress: number;
  error?: string;
  attachment?: UploadedFileAttachment;
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
            <View className="attach-file-icon">📎</View>
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

function createClientMessageId(): string {
  return `mp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export default function AgentPage() {
  const themeClass = useThemeClass();
  const [agentId, setAgentId] = useState("");
  const [title, setTitle] = useState("");
  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [status, setStatus] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const bottomAnchor = useRef(`bottom-${Date.now()}`);
  // t18：归档态 + 标签编辑
  const [snapshot, setSnapshot] = useState<AgentSnapshot | null>(null);
  const [labelEditing, setLabelEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);

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
        // daemon 回显的 user_message 带 clientMessageId 时，取代同 id 的乐观本地条目
        // （避免重复气泡；附件卡片由台账 match 挂到回显条目上）。
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
      bottomAnchor.current = `bottom-${Date.now()}`;
    };

    void (async () => {
      try {
        const agents = await conn.fetchAgents({ includeArchived: true });
        const self = agents.find((a) => a.id === agentId);
        if (self) {
          setStatus(self.status);
          setSnapshot(self);
          const navTitle = self.title ?? self.id.slice(0, 8);
          setTitle(navTitle);
          Taro.setNavigationBarTitle({ title: navTitle });
        }
        const timeline = await conn.fetchAgentTimeline(agentId, 50);
        appendEntries(timeline.map((entry) => toDisplay(agentId, entry)));
        await conn.subscribeAgentTimelines([agentId]);
        setError("");
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();

    const unsubscribeStream = connectionManager.onStreamEvent((payload) => {
      if (payload.agentId !== agentId) return;
      switch (payload.event.type) {
        case "timeline": {
          const display = toDisplay(agentId, {
            item: payload.event.item,
            timestamp: payload.timestamp,
            seqStart: payload.seq ?? Date.now(),
            seqEnd: payload.seq ?? Date.now(),
          });
          appendEntries([display]);
          break;
        }
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

  // ---- 附件选择与上传（t17） ----

  const uploadPending = async (picked: { fileName: string; size: number; path: string }) => {
    const key = `p-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const isImage = picked.fileName.match(/\.(png|jpe?g|gif|webp|bmp)$/i) !== null;
    const pending: PendingAttachment = {
      key,
      fileName: picked.fileName,
      size: picked.size,
      mimeType: mimeForFile(picked.fileName),
      localPath: isImage ? picked.path : undefined,
      status: "uploading",
      progress: 0,
    };
    setPendingFiles((prev) => [...prev, pending]);
    try {
      const bytes = await readLocalFileBytes(picked.path);
      const conn = connectionManager.requireConnection();
      const attachment = await conn.uploadFile({
        fileName: picked.fileName,
        mimeType: pending.mimeType,
        bytes,
        onProgress: (sent, total) => {
          setPendingFiles((prev) =>
            prev.map((f) =>
              f.key === key
                ? { ...f, progress: total > 0 ? Math.round((sent / total) * 100) : 0 }
                : f,
            ),
          );
        },
      });
      setPendingFiles((prev) =>
        prev.map((f) => (f.key === key ? { ...f, status: "ready", progress: 100, attachment } : f)),
      );
    } catch (err) {
      setPendingFiles((prev) =>
        prev.map((f) =>
          f.key === key
            ? { ...f, status: "error", error: err instanceof Error ? err.message : String(err) }
            : f,
        ),
      );
    }
  };

  const pickAttachment = async () => {
    try {
      const { tapIndex } = await Taro.showActionSheet({ itemList: ["选择图片", "从聊天选择文件"] });
      if (tapIndex === 0) {
        const res = await Taro.chooseMedia({
          count: 1,
          mediaType: ["image"],
          sizeType: ["compressed"],
        });
        const file = res.tempFiles?.[0];
        if (!file) return;
        await uploadPending({
          fileName: file.tempFilePath.split("/").pop() ?? "image.png",
          size: file.size ?? 0,
          path: file.tempFilePath,
        });
      } else {
        const res = await Taro.chooseMessageFile({ count: 1, type: "file" });
        const file = res.tempFiles?.[0];
        if (!file) return;
        await uploadPending({ fileName: file.name, size: file.size, path: file.path });
      }
    } catch {
      // 用户取消选择，静默
    }
  };

  const removePending = (key: string) => {
    setPendingFiles((prev) => prev.filter((f) => f.key !== key));
  };

  const send = async () => {
    const text = draft.trim();
    const hasAttachments = pendingFiles.some((f) => f.status === "ready");
    if ((!text && !hasAttachments) || !agentId || sending) return;
    if (pendingFiles.some((f) => f.status === "uploading")) {
      Taro.showToast({ title: "附件还在上传，稍候", icon: "none" });
      return;
    }
    if (pendingFiles.some((f) => f.status === "error")) {
      Taro.showToast({ title: "有上传失败的附件，请移除", icon: "none" });
      return;
    }
    setSending(true);
    setDraft("");
    const clientMessageId = createClientMessageId();
    const cards: AttachmentCard[] = pendingFiles.map((f) => ({
      kind: f.localPath ? "image" : "file",
      fileName: f.fileName,
      size: f.size,
      ...(f.localPath ? { localPath: f.localPath } : {}),
    }));
    const attachments = pendingFiles
      .map((f) => f.attachment)
      .filter((a): a is UploadedFileAttachment => a !== undefined);
    // 乐观追加本地用户消息（daemon 回推的 user_message 由 seq 去重）
    const localSeq = 9_000_000_000 + (Date.now() % 1_000_000_000);
    setEntries((prev) => [
      ...prev,
      {
        key: `local-${clientMessageId}`,
        seq: localSeq,
        item: { type: "user_message", text, clientMessageId },
        timestamp: new Date().toISOString(),
        ...(cards.length > 0 ? { attachments: cards } : {}),
      },
    ]);
    bottomAnchor.current = `bottom-${Date.now()}`;
    try {
      const conn = connectionManager.requireConnection();
      messageAttachmentStore.record(agentId, { clientMessageId, text, cards });
      const result = await conn.sendAgentMessage(agentId, text || "（附件）", {
        messageId: clientMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
      });
      if (!result.accepted) {
        setError(result.error ?? "消息未被接受");
      } else {
        setPendingFiles([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!agentId || cancelling) return;
    setCancelling(true);
    try {
      await connectionManager.requireConnection().cancelAgent(agentId);
      setStatus("idle");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCancelling(false);
    }
  };

  const remove = async () => {
    if (!agentId || deleting) return;
    const { confirm } = await Taro.showModal({
      title: "删除 Agent",
      content: "删除后该会话将从设备上永久移除，确定删除？",
      confirmText: "删除",
      confirmColor: "#fa5151",
      cancelText: "取消",
    });
    if (!confirm) return;
    setDeleting(true);
    try {
      await connectionManager.requireConnection().deleteAgent(agentId);
      messageAttachmentStore.clear(agentId);
      Taro.navigateBack();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setDeleting(false);
    }
  };

  const sendable = (draft.trim() || pendingFiles.some((f) => f.status === "ready")) && !sending;

  // ---- t18：归档 / 恢复 / 标签 ----

  const toggleArchive = async () => {
    if (!agentId || archiving) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    if (snapshot?.archivedAt) {
      setArchiving(true);
      try {
        await conn.refreshAgent(agentId);
        setSnapshot((prev) => (prev ? { ...prev, archivedAt: null } : prev));
        Taro.showToast({ title: "已恢复", icon: "success" });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setArchiving(false);
      }
      return;
    }
    const { confirm } = await Taro.showModal({
      title: "归档 Agent",
      content: "归档后从进行中列表移除，可在\"归档\"筛选里找到并恢复。",
      confirmText: "归档",
      cancelText: "取消",
    });
    if (!confirm) return;
    setArchiving(true);
    try {
      await conn.archiveAgent(agentId);
      setSnapshot((prev) =>
        prev ? { ...prev, archivedAt: new Date().toISOString() } : prev,
      );
      Taro.showToast({ title: "已归档", icon: "none" });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setArchiving(false);
    }
  };

  const addLabel = () => {
    const value = labelDraft.trim();
    if (!value) return;
    const current = displayLabels(snapshot?.labels);
    if (current.includes(value)) {
      setLabelDraft("");
      return;
    }
    void saveLabels([...current, value]);
    setLabelDraft("");
  };

  const removeLabel = (label: string) => {
    void saveLabels(displayLabels(snapshot?.labels).filter((l) => l !== label));
  };

  const saveLabels = async (next: string[]) => {
    if (!agentId || labelSaving) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    setLabelSaving(true);
    try {
      const labels = setDisplayLabels(snapshot?.labels, next);
      await conn.updateAgent(agentId, { labels });
      setSnapshot((prev) => (prev ? { ...prev, labels } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLabelSaving(false);
    }
  };

  const labels = displayLabels(snapshot?.labels);

  return (
    <View className={`agent-page ${themeClass}`}>
      <ScrollView
        className="timeline"
        scrollY
        scrollIntoView={bottomAnchor.current}
        enhanced
        showScrollbar={false}
      >
        {error ? <View className="error-inline error-in-timeline">{error}</View> : null}
        {snapshot?.archivedAt ? (
          <View className="archived-callout">
            <View className="archived-callout-text">该会话已归档，发送消息前需先恢复。</View>
            <Button
              className="btn btn-mini"
              disabled={archiving}
              onClick={() => void toggleArchive()}
            >
              恢复
            </Button>
          </View>
        ) : null}
        {labelEditing ? (
          <View className="label-editor">
            <View className="label-editor-title">标签</View>
            <View className="label-editor-chips">
              {labels.map((label) => (
                <View key={label} className="label-chip">
                  <View className="label-chip-text">{label}</View>
                  <View
                    className="label-chip-remove"
                    onClick={() => (labelSaving ? undefined : removeLabel(label))}
                  >
                    ✕
                  </View>
                </View>
              ))}
              {labels.length === 0 ? <View className="faint">还没有标签</View> : null}
            </View>
            <View className="label-editor-row">
              <Input
                className="label-input"
                value={labelDraft}
                onInput={(e) => setLabelDraft(e.detail.value)}
                onConfirm={() => addLabel()}
                placeholder="输入标签名"
                placeholderClass="composer-placeholder"
                confirmType="done"
              />
              <Button
                className="btn btn-mini label-add-btn"
                disabled={labelSaving || !labelDraft.trim()}
                onClick={() => addLabel()}
              >
                添加
              </Button>
            </View>
            <View className="label-editor-done" onClick={() => setLabelEditing(false)}>
              收起
            </View>
          </View>
        ) : null}
        {entries.length === 0 ? (
          <View className="card empty">
            <View className="empty-icon">💬</View>
            <View className="empty-title">暂无消息</View>
            <View className="empty-desc">在下方输入框给 agent 发第一条指令。</View>
          </View>
        ) : (
          entries.map((entry) => (
            <View key={entry.key} className="timeline-item">
              <View
                className={`timeline-row ${entry.item.type === "user_message" ? "row-user" : ""}`}
              >
                <View className={bubbleClass(entry.item)}>
                  {entry.attachments ? <AttachmentCards cards={entry.attachments} /> : null}
                  <BubbleContent item={entry.item} />
                </View>
              </View>
              {entry.timestamp ? (
                <View
                  className={`timeline-clock ${entry.item.type === "user_message" ? "row-user" : ""}`}
                >
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
            <View className={snapshot?.archivedAt ? "pill pill-idle" : statusPillClass(status)}>
              {snapshot?.archivedAt ? "已归档" : (STATUS_LABELS[status] ?? status)}
            </View>
          ) : null}
          {title ? <View className="faint composer-title">{title}</View> : null}
          <View className="composer-actions">
            {status === "running" && !snapshot?.archivedAt ? (
              <Button
                className="btn btn-mini btn-ghost action-btn"
                disabled={cancelling}
                onClick={() => void interrupt()}
              >
                {cancelling ? "中断中…" : "中断"}
              </Button>
            ) : null}
            <Button
              className="btn btn-mini btn-ghost action-btn"
              disabled={labelSaving}
              onClick={() => setLabelEditing((v) => !v)}
            >
              标签{labels.length > 0 ? `(${labels.length})` : ""}
            </Button>
            <Button
              className="btn btn-mini btn-ghost action-btn"
              disabled={archiving}
              onClick={() => void toggleArchive()}
            >
              {snapshot?.archivedAt ? "恢复" : "归档"}
            </Button>
            <Button
              className="btn btn-mini btn-danger action-btn"
              disabled={deleting}
              onClick={() => void remove()}
            >
              删除
            </Button>
          </View>
        </View>
        {pendingFiles.length > 0 ? (
          <ScrollView className="attach-tray" scrollX enhanced showScrollbar={false}>
            {pendingFiles.map((file) => (
              <View key={file.key} className={`attach-chip attach-chip-${file.status}`}>
                {file.status === "uploading" ? (
                  <View className="attach-chip-progress num">{file.progress}%</View>
                ) : (
                  <View className="attach-chip-icon">
                    {file.status === "error" ? "⚠️" : file.localPath ? "🖼" : "📎"}
                  </View>
                )}
                <View className="attach-chip-main">
                  <View className="attach-chip-name">{file.fileName}</View>
                  <View className="attach-chip-size">
                    {file.status === "error"
                      ? (file.error ?? "上传失败").slice(0, 20)
                      : formatFileSize(file.size)}
                  </View>
                </View>
                <View className="attach-chip-remove" onClick={() => removePending(file.key)}>
                  ✕
                </View>
              </View>
            ))}
          </ScrollView>
        ) : null}
        <View className="composer-row">
          <View className="attach-btn" onClick={() => void pickAttachment()}>
            ＋
          </View>
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
            className={`btn send-btn ${sendable ? "send-ready" : ""}`}
            disabled={!sendable}
            onClick={() => void send()}
          >
            发送
          </Button>
        </View>
      </View>
      <PermissionOverlay />
    </View>
  );
}
