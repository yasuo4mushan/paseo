/**
 * 会话详情管理页（t20 重构：时间线渲染与订阅提取到 hooks/use-agent-session +
 * components/timeline 共用；本页保留管理面——归档/标签/重命名/导出/子代理轨道/
 * 斜杠命令/上下文计量）。对话主入口移至 pages/chat（豆包式直达）。
 */

import { useEffect, useRef, useState } from "react";
import Taro, { useLoad } from "@tarojs/taro";
import { Button, Image, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { MODAL_DANGER_COLOR } from "@/constants/colors";
import type {
  ProviderSubagentSummary,
  SlashCommand,
  UploadedFileAttachment,
} from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { TimelineView } from "@/components/timeline";
import { useAgentSession, } from "@/hooks/use-agent-session";
import { useThemeClass } from "@/hooks/use-theme";
import { messageAttachmentStore, type AttachmentCard } from "@/stores/message-attachment-store";
import { displayLabels, setDisplayLabels } from "@/utils/agent-directory";
import { formatFileSize, mimeForFile } from "@/utils/files";
import { readLocalFileBytes } from "@/utils/file-ops";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { iconUrl } from "@/utils/icons";
import "./index.css";

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

/** t19：subagent 状态文案（ProviderSubagentDescriptorPayload.status）。 */
const SUBAGENT_STATUS_LABEL: Record<string, string> = {
  running: "运行中",
  completed: "完成",
  failed: "失败",
  canceled: "取消",
};

function createClientMessageId(): string {
  return `mp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

export default function AgentPage() {
  const themeClass = useThemeClass();
  const [agentId, setAgentId] = useState("");
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const bottomAnchor = useRef(`bottom-${Date.now()}`);
  // t18：归档态 + 标签编辑
  const [labelEditing, setLabelEditing] = useState(false);
  const [labelDraft, setLabelDraft] = useState("");
  const [labelSaving, setLabelSaving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  // t19：重命名（label 编辑器共用保存通道）
  const [nameDraft, setNameDraft] = useState("");
  // t19：subagents 轨道
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [subagents, setSubagents] = useState<ProviderSubagentSummary[]>([]);
  // t19：斜杠命令目录（首次输入 / 时拉取）
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const commandsLoadedFor = useRef("");
  // t19：运行中发送行为（steer=插入对话 / interrupt=先中断）
  const [interruptOnSend, setInterruptOnSend] = useState(false);

  useLoad((options) => {
    const id = options?.id ? decodeURIComponent(options.id) : "";
    if (id) setAgentId(id);
  });

  // 共享会话状态（快照/时间线/流订阅；乐观追加）
  const session = useAgentSession(agentId);
  const snapshot = session.snapshot;
  const entries = session.entries;
  const status = session.status;
  const error = session.error;
  const title = snapshot?.title ?? "";

  useEffect(() => {
    if (snapshot) {
      const navTitle = snapshot.title ?? snapshot.id.slice(0, 8);
      setNameDraft(snapshot.title ?? "");
      Taro.setNavigationBarTitle({ title: navTitle });
    }
  }, [snapshot?.title, snapshot?.id, snapshot]);

  // t19：打开 subagents 面板时拉取列表（此后由推送维护）
  useEffect(() => {
    if (!subagentsOpen || !agentId) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    void conn
      .listSubagents(agentId)
      .then((list) => setSubagents([...list].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))))
      .catch((err) => {
        setSubagents([]);
        void err;
      });
  }, [subagentsOpen, agentId]);

  // t19：subagents 轨道实时更新（upsert/remove；打开面板时可见）
  useEffect(() => {
    if (!agentId) return;
    return connectionManager.onSubagentUpdate((update) => {
      if (update.kind === "upsert") {
        if (update.subagent.parentAgentId !== agentId) return;
        setSubagents((prev) => {
          const rest = prev.filter((s) => s.id !== update.subagent.id);
          return [...rest, update.subagent].sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
        });
      } else {
        if (update.parentAgentId !== agentId) return;
        setSubagents((prev) => prev.filter((s) => s.id !== update.subagentId));
      }
    });
  }, [agentId]);

  // t19：首次输入 / 时拉取斜杠命令目录（每 agent 一次）
  useEffect(() => {
    if (!agentId || commands !== null || commandsLoadedFor.current === agentId) return;
    if (!draft.startsWith("/")) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    commandsLoadedFor.current = agentId;
    void conn
      .listCommands(agentId)
      .then((list) => setCommands(list))
      .catch(() => {
        commandsLoadedFor.current = ""; // 失败允许重试
      });
  }, [draft, agentId, commands]);

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
    session.appendOptimisticUser(text || "（附件）", clientMessageId, cards.length > 0 ? cards : undefined);
    bottomAnchor.current = `bottom-${Date.now()}`;
    try {
      const conn = connectionManager.requireConnection();
      messageAttachmentStore.record(agentId, { clientMessageId, text, cards });
      const result = await conn.sendAgentMessage(agentId, text || "（附件）", {
        messageId: clientMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
        // t19：运行中按 toggle 决定 插入对话(steer) / 先中断再投递(interrupt)
        ...(status === "running" && interruptOnSend
          ? { activeTurnBehavior: "interrupt" as const }
          : {}),
      });
      if (!result.accepted) {
        Taro.showToast({ title: result.error ?? "消息未被接受", icon: "none" });
      } else {
        setPendingFiles([]);
      }
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!agentId || cancelling) return;
    setCancelling(true);
    try {
      await connectionManager.requireConnection().cancelAgent(agentId);
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
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
      confirmColor: MODAL_DANGER_COLOR,
      cancelText: "取消",
    });
    if (!confirm) return;
    setDeleting(true);
    try {
      await connectionManager.requireConnection().deleteAgent(agentId);
      messageAttachmentStore.clear(agentId);
      Taro.navigateBack();
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
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
        Taro.showToast({ title: "已恢复", icon: "success" });
      } catch (err) {
        Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
      } finally {
        setArchiving(false);
      }
      return;
    }
    const { confirm } = await Taro.showModal({
      title: "归档 Agent",
      content: '归档后从进行中列表移除，可在"归档"筛选里找到并恢复。',
      confirmText: "归档",
      cancelText: "取消",
    });
    if (!confirm) return;
    setArchiving(true);
    try {
      await conn.archiveAgent(agentId);
      Taro.showToast({ title: "已归档", icon: "none" });
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
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
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
    } finally {
      setLabelSaving(false);
    }
  };

  // ---- t19：重命名 / 导出 / 上下文计量 ----

  /** 重命名（update_agent name；导航栏与气泡标题同步刷新）。 */
  const saveName = async () => {
    const name = nameDraft.trim();
    if (!agentId || !name || name === (snapshot?.title ?? "") || labelSaving) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    setLabelSaving(true);
    try {
      await conn.updateAgent(agentId, { name });
      Taro.setNavigationBarTitle({ title: name });
      Taro.showToast({ title: "已重命名", icon: "success" });
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
    } finally {
      setLabelSaving(false);
    }
  };

  /**
   * 导出会话（本地操作，无专用 RPC——官方 app 的导出即剪贴板 markdown）：
   * 时间线 → markdown 文本 → 剪贴板。
   */
  const exportTimeline = async () => {
    if (entries.length === 0) {
      Taro.showToast({ title: "暂无可导出的消息", icon: "none" });
      return;
    }
    const lines: string[] = [`# ${title || agentId}`, ""];
    for (const entry of entries) {
      const item = entry.item;
      if (
        item.type === "user_message" ||
        item.type === "assistant_message" ||
        item.type === "reasoning"
      ) {
        const who =
          item.type === "user_message"
            ? "## 用户"
            : item.type === "assistant_message"
              ? "## 助手"
              : "### 思考";
        lines.push(who, "", item.text, "");
      } else if (item.type === "error") {
        lines.push("> 错误：", item.message, "");
      }
    }
    const markdown = lines.join("\n");
    try {
      await Taro.setClipboardData({ data: markdown });
      Taro.showToast({ title: `已复制 ${entries.length} 条消息`, icon: "none" });
    } catch {
      Taro.showToast({ title: "复制失败", icon: "none" });
    }
  };

  /** t19：上下文窗口计量（agent_update 全量 snapshot.lastUsage 提供）。 */
  const usage = snapshot?.usage ?? null;
  const contextPercent =
    usage?.contextWindowMaxTokens && usage.contextWindowUsedTokens !== undefined
      ? Math.min(
          100,
          Math.round((usage.contextWindowUsedTokens / usage.contextWindowMaxTokens) * 100),
        )
      : null;

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
                    <Image className="icon icon-sm" src={iconUrl("close")} />
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
            {/* t19：重命名（update_agent name） */}
            <View className="label-editor-title rename-title">名称</View>
            <View className="label-editor-row">
              <Input
                className="label-input"
                value={nameDraft}
                onInput={(e) => setNameDraft(e.detail.value)}
                onConfirm={() => void saveName()}
                placeholder="会话名称"
                placeholderClass="composer-placeholder"
                confirmType="done"
              />
              <Button
                className="btn btn-mini label-add-btn"
                disabled={labelSaving || !nameDraft.trim() || nameDraft.trim() === snapshot?.title}
                onClick={() => void saveName()}
              >
                重命名
              </Button>
            </View>
            <View className="label-editor-done" onClick={() => setLabelEditing(false)}>
              收起
            </View>
          </View>
        ) : null}
        {/* t19：subagents 轨道 */}
        {subagentsOpen ? (
          <View className="subagent-panel">
            <View className="subagent-head">
              <View className="subagent-title">子代理（{subagents.length}）</View>
              <View className="subagent-close" onClick={() => setSubagentsOpen(false)}>
                收起
              </View>
            </View>
            {subagents.length === 0 ? (
              <View className="faint subagent-empty">
                暂无子代理。provider 发起 subagent 后会出现在这里。
              </View>
            ) : (
              subagents.map((sub) => (
                <View key={sub.id} className="subagent-row">
                  <View className={`subagent-dot subagent-dot-${sub.status}`} />
                  <View className="subagent-main">
                    <View className="subagent-name">{sub.title ?? sub.id}</View>
                    <View className="faint subagent-desc">
                      {sub.subtitle ?? sub.description ?? sub.provider}
                    </View>
                  </View>
                  <View className={`subagent-status subagent-status-${sub.status}`}>
                    {SUBAGENT_STATUS_LABEL[sub.status]}
                  </View>
                </View>
              ))
            )}
          </View>
        ) : null}
        {entries.length === 0 ? (
          <View className="card empty">
            <Image className="icon icon-xl" src={iconUrl("chat")} />
            <View className="empty-title">暂无消息</View>
            <View className="empty-desc">在下方输入框给 agent 发第一条指令。</View>
          </View>
        ) : (
          <TimelineView entries={entries} />
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
          {/* t19：上下文窗口计量条（lastUsage；详情态 agent_update 推送提供） */}
          {contextPercent !== null ? (
            <View className="ctx-gauge">
              <View className="ctx-gauge-bar">
                <View
                  className={`ctx-gauge-fill ${contextPercent >= 80 ? "ctx-gauge-hot" : ""}`}
                  style={{ width: `${contextPercent}%` }}
                />
              </View>
              <View className="faint num ctx-gauge-text">{contextPercent}%</View>
            </View>
          ) : null}
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
            {/* t19：运行中发送行为切换（steer=插入 / interrupt=打断后投递） */}
            {status === "running" && !snapshot?.archivedAt ? (
              <Button
                className={`btn btn-mini action-btn ${interruptOnSend ? "btn-danger" : "btn-ghost"}`}
                onClick={() => setInterruptOnSend((v) => !v)}
              >
                {interruptOnSend ? "发送:打断" : "发送:插入"}
              </Button>
            ) : null}
            {/* t19：subagents 轨道入口 */}
            <Button
              className="btn btn-mini btn-ghost action-btn"
              onClick={() => setSubagentsOpen((v) => !v)}
            >
              子代理{subagents.length > 0 ? `(${subagents.length})` : ""}
            </Button>
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
            {/* t19：导出（本地 markdown → 剪贴板） */}
            <Button
              className="btn btn-mini btn-ghost action-btn"
              onClick={() => void exportTimeline()}
            >
              导出
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
                  <Image
                    className="icon icon-sm"
                    src={iconUrl(file.status === "error" ? "warning" : file.localPath ? "image" : "paperclip")}
                  />
                )}
                <View className="attach-chip-main">
                  <View className="attach-chip-name">{file.fileName}</View>
                  <View className="attach-chip-size">
                    {file.status === "error"
                      ? (file.error ?? "上传失败").slice(0, 20)
                      : formatFileSize(file.size)}
                  </View>
                </View>
                <View
                  className="attach-chip-remove"
                  onClick={() => setPendingFiles((prev) => prev.filter((f) => f.key !== file.key))}
                >
                  <Image className="icon icon-sm" src={iconUrl("close")} />
                </View>
              </View>
            ))}
          </ScrollView>
        ) : null}
        {/* t19：斜杠命令面板（输入 / 触发；list_commands 目录） */}
        {draft.startsWith("/") && commands !== null && commands.length > 0 ? (
          <ScrollView className="slash-panel" scrollY enhanced showScrollbar={false}>
            {commands
              .filter((cmd) =>
                draft === "/" ? true : `/${cmd.name}`.startsWith(draft.split(" ")[0] ?? ""),
              )
              .slice(0, 8)
              .map((cmd) => (
                <View
                  key={cmd.name}
                  className="slash-row"
                  onClick={() => setDraft(`/${cmd.name} `)}
                >
                  <View className="slash-name num">{`/${cmd.name}`}</View>
                  <View className="slash-desc">
                    {cmd.description}
                    {cmd.argumentHint ? ` ${cmd.argumentHint}` : ""}
                  </View>
                </View>
              ))}
          </ScrollView>
        ) : null}
        <View className="composer-row">
          <View className="attach-btn" onClick={() => void pickAttachment()}>
            <Image className="icon" src={iconUrl("plus")} />
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
