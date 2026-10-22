/**
 * 对话主页（t20，中心 tab，默认启动页）——豆包式直达：
 *  - 进入即上次活跃会话（sessionStore 持久化；无则空态 + 快捷输入框）；
 *  - 未连接设备 → 引导连接（设备页功能不动，点设备直达本页）；
 *  - 右上展开按钮呼出会话抽屉（全部会话/筛选/新建）；
 *  - 底部 composer 常驻：四个选择 pill——Agent 框架 / 模型 / thinking effort /
 *    审批模式（packages/app composer 的移动简化版，状态机见 utils/composer-config）：
 *      草稿态（无会话）：选择进入 create_agent_request.config；
 *      会话态：model/mode/thinking 改动走 set_agent_model/mode/thinking RPC。
 *  - 发送即创建（无会话时，需要已选工作区）或发到当前会话；
 *    附件 "+"、斜杠命令、运行中 steer/interrupt 沿用 t17/t19。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Button, Image, Input, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { hasSession } from "@/hub/hub-client";
import type {
  ProviderAvailability,
  ProviderMode,
  ProviderModelDefinition,
  SlashCommand,
  UploadedFileAttachment,
  WorkspaceDescriptor,
} from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { WorkspacePicker } from "@/components/workspace-picker";
import { SessionDrawer } from "@/components/session-drawer";
import { ConfigPickerSheet } from "@/components/config-picker";
import { TimelineView } from "@/components/timeline";
import { useAgentSession } from "@/hooks/use-agent-session";
import { sessionStore } from "@/stores/session-store";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { attentionStore } from "@/stores/attention-store";
import { messageAttachmentStore, type AttachmentCard } from "@/stores/message-attachment-store";
import { useThemeClass } from "@/hooks/use-theme";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { iconUrl, providerIconUrl } from "@/utils/icons";
import { safeSwitchTab } from "@/utils/navigation";
import {
  applyDraftSelection,
  draftPillViews,
  draftToCreateConfig,
  seedDraft,
  sessionPillViews,
  sessionSelectionAction,
  type ComposerCatalog,
  type ComposerDraft,
  type ComposerPill,
} from "@/utils/composer-config";
import { formatFileSize, mimeForFile } from "@/utils/files";
import { readLocalFileBytes } from "@/utils/file-ops";
import { recordAutomationEvent } from "@/utils/automation-log";
import "./index.css";

const PILL_TITLES: Record<ComposerPill, string> = {
  provider: "Agent 框架",
  model: "模型",
  thinking: "Thinking effort",
  mode: "审批模式",
};

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

function createClientMessageId(): string {
  return `mp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
}

/** store 订阅（平台纪律：useState+useEffect，不用 useSyncExternalStore）。 */
function useSessionDirectory() {
  const [state, setState] = useState(() => sessionStore.getSnapshot());
  useEffect(() => sessionStore.subscribe(() => setState(sessionStore.getSnapshot())), []);
  return state;
}

function useWorkspaceSelection(): WorkspaceSelection | null {
  const [selection, setSelection] = useState<WorkspaceSelection | null>(() =>
    workspaceStore.getSnapshot(),
  );
  useEffect(() => workspaceStore.subscribe(() => setSelection(workspaceStore.getSnapshot())), []);
  return selection;
}

export default function ChatPage() {
  const themeClass = useThemeClass();
  const [authed, setAuthed] = useState(() => hasSession());
  const [connState, setConnState] = useState(() => connectionManager.getState());
  useEffect(
    () => connectionManager.subscribe(() => setConnState(connectionManager.getState())),
    [],
  );

  // 未登录 → 登录页（对话主页是启动页，登录守卫在这里）
  useEffect(() => {
    if (!hasSession()) {
      setAuthed(false);
      Taro.reLaunch({ url: "/pages/login/index" });
    }
  }, []);

  // 会话目录 + 活跃会话
  const directory = useSessionDirectory();
  const activeId = directory.activeId;
  const activeAgent = useMemo(
    () => directory.agents.find((a) => a.id === activeId && !a.archivedAt) ?? null,
    [directory.agents, activeId],
  );
  const session = useAgentSession(activeAgent?.id ?? "");
  const snapshot = activeAgent ? session.snapshot : null;

  // 连接建立/页面显示时刷新目录（豆包式直达：恢复上次活跃会话）。
  // fetcher 注入：store 保持平台无关（见 session-store.ts 头注释）。
  const refreshDirectory = useCallback(() => {
    const conn = connectionManager.getConnection();
    if (!conn) {
      sessionStore.reset();
      return Promise.resolve();
    }
    return sessionStore.refresh(() => conn.fetchAgents({ includeArchived: true }));
  }, []);

  useDidShow(() => {
    if (!hasSession()) return;
    if (connectionManager.getState().status === "connected") void refreshDirectory();
  });
  useEffect(() => {
    if (connState.status === "connected") void refreshDirectory();
  }, [connState.status, refreshDirectory]);

  // 抽屉
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 右滑手势呼出抽屉（touchstart/touchend 位移判定，不与 ScrollView 横滚冲突：
  // 时间线是纵向滚动，横向快速右滑 >60rpx 才触发）
  const touchStart = useRef<{ x: number; y: number } | null>(null);

  // composer 目录与草稿
  const workspace = useWorkspaceSelection();
  const [workspacePickerVisible, setWorkspacePickerVisible] = useState(false);
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null);
  const [models, setModels] = useState<ProviderModelDefinition[]>([]);
  const [modes, setModes] = useState<ProviderMode[]>([]);
  const [catalogProvider, setCatalogProvider] = useState("");
  const catalogCwdRef = useRef("");
  const [draft, setDraft] = useState<ComposerDraft>({
    provider: "",
    modelId: "",
    thinkingOptionId: "",
    modeId: "",
  });
  const draftSeeded = useRef(false);
  const [pickerPill, setPickerPill] = useState<ComposerPill | null>(null);
  const [configError, setConfigError] = useState("");

  const connected = connState.status === "connected";
  // 目录跟随：草稿态用草稿 provider；会话态用会话 provider
  const catalogTarget = activeAgent?.provider || draft.provider;

  // provider 目录（连接后拉一次）
  useEffect(() => {
    if (!connected) {
      setProviders(null);
      return;
    }
    let disposed = false;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    void conn
      .listAvailableProviders()
      .then((list) => {
        if (!disposed) setProviders(list);
      })
      .catch(() => {
        if (!disposed) setProviders([]);
      });
    return () => {
      disposed = true;
    };
  }, [connected, connState.status]);

  // provider 或 cwd 变化 → 重拉模型/模式目录（t16 list_provider_models/modes；
  // 模型含 thinkingOptions；目录与 cwd 相关——无 cwd 的拉取在工作区选定后作废重拉）
  useEffect(() => {
    const cwd = workspace?.directory ?? "";
    if (!connected || !catalogTarget) return;
    if (catalogTarget === catalogProvider && cwd === catalogCwdRef.current) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    setCatalogProvider(catalogTarget);
    catalogCwdRef.current = cwd;
    setModels([]);
    setModes([]);
    void (async () => {
      const [modelList, modeList] = await Promise.all([
        conn.listProviderModels(catalogTarget, cwd || undefined).catch(() => []),
        conn.listProviderModes(catalogTarget, cwd || undefined).catch(() => []),
      ]);
      if (disposed) return;
      setModels(modelList);
      setModes(modeList);
      // 草稿态：目录就绪后保持草稿取默认值（provider 不变时也重取默认模型/档位/模式）
      setDraft((prev) => seedDraft({ providers: providers ?? [], models: modelList, modes: modeList }, prev.provider));
    })();
    return () => {
      disposed = true;
    };
  }, [connected, catalogTarget, catalogProvider, workspace?.directory, providers]);

  const catalog: ComposerCatalog = useMemo(
    () => ({ providers: providers ?? [], models, modes }),
    [providers, models, modes],
  );

  // 草稿种子：provider 目录到达后装配默认值（仅草稿态）
  useEffect(() => {
    if (!providers || draftSeeded.current || activeAgent) return;
    draftSeeded.current = true;
    setDraft((prev) => (prev.provider ? prev : seedDraft(catalog, prev.provider)));
  }, [providers, catalog, activeAgent]);

  const pillViews = useMemo(
    () =>
      snapshot
        ? sessionPillViews(snapshot, catalog)
        : draftPillViews(draft, catalog),
    [snapshot, draft, catalog],
  );

  // 会话态选择 → set_* RPC；草稿态选择 → 本地转移
  const onPillSelect = async (pill: ComposerPill, value: string) => {
    setConfigError("");
    if (activeAgent) {
      const action = sessionSelectionAction(snapshot ?? activeAgent, catalog, pill, value);
      if (!action) return;
      try {
        const conn = connectionManager.requireConnection();
        if (action.kind === "mode") await conn.setAgentMode(activeAgent.id, action.modeId);
        if (action.kind === "model") await conn.setAgentModel(activeAgent.id, action.modelId);
        if (action.kind === "thinking")
          await conn.setAgentThinking(activeAgent.id, action.thinkingOptionId);
        Taro.showToast({ title: "已切换", icon: "success", duration: 600 });
        recordAutomationEvent({ kind: "config_switch", pill, value, agentId: activeAgent.id });
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : String(err));
        recordAutomationEvent({
          kind: "config_switch_error",
          pill,
          value,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return;
    }
    setDraft((prev) => applyDraftSelection(prev, pill, value, catalog));
  };

  // ---- 发送侧（乐观追加 + 幂等 id；t19 activeTurnBehavior 沿用） ----

  const [draftText, setDraftText] = useState("");
  const [sending, setSending] = useState(false);
  const [interruptOnSend, setInterruptOnSend] = useState(false);
  const [pendingFiles, setPendingFiles] = useState<PendingAttachment[]>([]);
  const bottomAnchor = useRef(`bottom-${Date.now()}`);
  const timelineRef = useRef("");

  // 斜杠命令目录（首次输入 / 拉取；会话态）
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const commandsLoadedFor = useRef("");

  useEffect(() => {
    const id = activeAgent?.id ?? "";
    if (!id || commands !== null || commandsLoadedFor.current === id) return;
    if (!draftText.startsWith("/")) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    commandsLoadedFor.current = id;
    void conn
      .listCommands(id)
      .then((list) => setCommands(list))
      .catch(() => {
        commandsLoadedFor.current = "";
      });
  }, [draftText, activeAgent?.id, commands]);

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
    const text = draftText.trim();
    const hasAttachments = pendingFiles.some((f) => f.status === "ready");
    if ((!text && !hasAttachments) || sending) return;
    if (pendingFiles.some((f) => f.status === "uploading")) {
      Taro.showToast({ title: "附件还在上传，稍候", icon: "none" });
      return;
    }
    if (pendingFiles.some((f) => f.status === "error")) {
      Taro.showToast({ title: "有上传失败的附件，请移除", icon: "none" });
      return;
    }

    // 无活跃会话：发送即创建（豆包式冷启动）。需要已选工作区。
    if (!activeAgent) {
      if (!workspace) {
        setWorkspacePickerVisible(true);
        Taro.showToast({ title: "先选择项目工作区", icon: "none" });
        return;
      }
      if (!draft.provider) {
        setPickerPill("provider");
        Taro.showToast({ title: "先选择 Agent 框架", icon: "none" });
        return;
      }
      setSending(true);
      try {
        const conn = connectionManager.requireConnection();
        const config = draftToCreateConfig(draft, workspace.directory, workspace.workspaceId);
        const agent = await conn.createAgent({ ...config, initialPrompt: text || "（附件）" });
        // 附件台账挂到新 agent 首条消息
        const clientMessageId = createClientMessageId();
        const cards: AttachmentCard[] = pendingFiles.map((f) => ({
          kind: f.localPath ? "image" : "file",
          fileName: f.fileName,
          size: f.size,
          ...(f.localPath ? { localPath: f.localPath } : {}),
        }));
        if (cards.length > 0) {
          messageAttachmentStore.record(agent.id, { clientMessageId, text, cards });
        }
        sessionStore.setActive(agent.id);
        setDraftText("");
        setPendingFiles([]);
        recordAutomationEvent({
          kind: "composer_create",
          agentId: agent.id,
          provider: config.provider,
          ...(config.model ? { model: config.model } : {}),
          ...(config.thinkingOptionId ? { thinkingOptionId: config.thinkingOptionId } : {}),
          ...(config.modeId ? { modeId: config.modeId } : {}),
        });
        void refreshDirectory();
      } catch (err) {
        setConfigError(err instanceof Error ? err.message : String(err));
      } finally {
        setSending(false);
      }
      return;
    }

    // 已有会话：常规发送
    setSending(true);
    setDraftText("");
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
    session.appendOptimisticUser(text || "（附件）", clientMessageId, cards.length > 0 ? cards : undefined);
    bottomAnchor.current = `bottom-${Date.now()}`;
    try {
      const conn = connectionManager.requireConnection();
      messageAttachmentStore.record(activeAgent.id, { clientMessageId, text, cards });
      const result = await conn.sendAgentMessage(activeAgent.id, text || "（附件）", {
        messageId: clientMessageId,
        ...(attachments.length > 0 ? { attachments } : {}),
        ...(session.status === "running" && interruptOnSend
          ? { activeTurnBehavior: "interrupt" as const }
          : {}),
      });
      if (!result.accepted) {
        setConfigError(result.error ?? "消息未被接受");
      } else {
        setPendingFiles([]);
      }
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  };

  const interrupt = async () => {
    if (!activeAgent) return;
    try {
      await connectionManager.requireConnection().cancelAgent(activeAgent.id);
    } catch (err) {
      setConfigError(err instanceof Error ? err.message : String(err));
    }
  };

  // 抽屉长按动作：归档/恢复/删除（RPC + 目录刷新）
  const drawerArchive = useCallback(async (agentId: string, currentlyArchived: boolean) => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    try {
      if (currentlyArchived) {
        await conn.refreshAgent(agentId);
        Taro.showToast({ title: "已恢复", icon: "success" });
      } else {
        const { confirm } = await Taro.showModal({
          title: "归档会话",
          content: '归档后从进行中列表移除，可在"归档"筛选里找到并恢复。',
          confirmText: "归档",
          cancelText: "取消",
        });
        if (!confirm) return;
        await conn.archiveAgent(agentId);
        Taro.showToast({ title: "已归档", icon: "none" });
      }
      void refreshDirectory();
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
    }
  }, []);

  const drawerDelete = useCallback(async (agentId: string) => {
    const { confirm } = await Taro.showModal({
      title: "删除会话",
      content: "删除后该会话将从设备上永久移除，确定删除？",
      confirmText: "删除",
      confirmColor: "#fa5151",
      cancelText: "取消",
    });
    if (!confirm) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    try {
      await conn.deleteAgent(agentId);
      attentionStore.clear([agentId]);
      messageAttachmentStore.clear(agentId);
      Taro.showToast({ title: "已删除", icon: "success" });
      void refreshDirectory();
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : String(err), icon: "none" });
    }
  }, []);

  const onWorkspaceSelected = useCallback((ws: WorkspaceDescriptor) => {
    workspaceStore.select(ws);
    // 换工作区可能影响模型目录（cwd 相关），重新装配草稿
    draftSeeded.current = false;
    setDraft((prev) => seedDraft(
      { providers: providers ?? [], models, modes },
      prev.provider,
    ));
  }, [providers, models, modes]);

  const sendable =
    (draftText.trim() || pendingFiles.some((f) => f.status === "ready")) && !sending && connected;

  // 时间线滚动锚点（新消息到达时更新）
  if (timelineRef.current !== `${activeId}-${session.entries.length}`) {
    timelineRef.current = `${activeId}-${session.entries.length}`;
    bottomAnchor.current = `bottom-${Date.now()}`;
  }

  if (!authed) return <View />;

  const headerTitle = snapshot?.title ?? activeAgent?.title ?? (activeAgent ? activeAgent.id.slice(0, 8) : "新对话");
  const projectLabel = activeAgent
    ? (activeAgent.cwd.split("/").filter(Boolean).pop() ?? activeAgent.cwd)
    : (workspace?.label ?? "选择项目");

  return (
    <View
      className={`chat-page ${themeClass}`}
      onTouchStart={(e) => {
        const ev = e as unknown as { touches?: Array<{ clientX: number; clientY: number }> };
        const t = ev.touches?.[0];
        if (t) touchStart.current = { x: t.clientX, y: t.clientY };
      }}
      onTouchEnd={(e) => {
        const start = touchStart.current;
        touchStart.current = null;
        const ev = e as unknown as { changedTouches?: Array<{ clientX: number; clientY: number }> };
        const t = ev.changedTouches?.[0];
        if (!start || !t || drawerOpen) return;
        // 右滑呼出抽屉：横向位移 > 60 且纵向 < 40（避免与滚动混淆）
        if (t.clientX - start.x > 60 && Math.abs(t.clientY - start.y) < 40 && connected) {
          setDrawerOpen(true);
        }
      }}
    >
      {/* 顶栏：标题 + 状态 + 展开会话栏 */}
      <View className="chat-header">
        <View className="chat-header-main">
          <View className="chat-title-row">
            <View className="chat-title">{headerTitle}</View>
            {activeAgent && session.status ? (
              <View className={statusPillClass(session.status)}>
                {snapshot?.archivedAt ? "已归档" : (STATUS_LABELS[session.status] ?? session.status)}
              </View>
            ) : null}
          </View>
          <View className="chat-header-sub">
            {connected ? (
              <View className="chat-project" onClick={() => !activeAgent && setWorkspacePickerVisible(true)}>
                <Image className="icon icon-sm" src={iconUrl("project")} />
                <View className={`chat-project-text ${activeAgent ? "" : "chat-project-tap"}`}>
                  {projectLabel}
                </View>
                {!activeAgent ? (
                  <Image className="icon icon-sm" src={iconUrl("chevron-down")} />
                ) : null}
              </View>
            ) : (
              <View className="faint">{connState.status === "error" ? connState.message : "未连接设备"}</View>
            )}
          </View>
        </View>
        <View className="chat-expand" onClick={() => setDrawerOpen(true)}>
          <Image className="icon" src={iconUrl("expand")} />
        </View>
      </View>

      {/* 时间线 / 空态 */}
      <ScrollView
        className="chat-timeline"
        scrollY
        scrollIntoView={bottomAnchor.current}
        enhanced
        showScrollbar={false}
      >
        {session.error || configError ? (
          <View className="error-inline">{session.error || configError}</View>
        ) : null}
        {!connected ? (
          <View className="card empty">
            <Image className="icon icon-xl" src={iconUrl("devices")} />
            <View className="empty-title">连接你的开发机开始对话</View>
            <View className="empty-desc">
              在设备页选择一台在线设备，连接后这里就是你的对话工作台。
            </View>
            <Button className="btn btn-mini" onClick={() => void safeSwitchTab("/pages/devices/index")}>
              去设备页
            </Button>
          </View>
        ) : activeAgent ? (
          session.entries.length === 0 ? (
            <View className="card empty">
              <Image className="icon icon-xl" src={iconUrl("chat")} />
              <View className="empty-title">开始对话</View>
              <View className="empty-desc">在下方输入框给这个会话发第一条指令。</View>
            </View>
          ) : (
            <TimelineView entries={session.entries} />
          )
        ) : (
          <View className="chat-welcome">
            <Image className="icon icon-xl chat-welcome-icon" src={iconUrl("spark", "-active")} />
            <View className="chat-welcome-title">有什么要做的？</View>
            <View className="empty-desc">
              直接输入任务，发送即创建会话。可在下方选择 Agent 框架、模型与审批模式。
            </View>
          </View>
        )}
        <View id={bottomAnchor.current} className="timeline-bottom" />
      </ScrollView>

      {/* composer 常驻 */}
      <View className="chat-composer">
        {activeAgent && session.status === "running" ? (
          <View className="chat-live-row">
            <Button className="btn btn-mini btn-ghost chat-live-btn" onClick={() => void interrupt()}>
              中断
            </Button>
            <Button
              className={`btn btn-mini chat-live-btn ${interruptOnSend ? "btn-danger" : "btn-ghost"}`}
              onClick={() => setInterruptOnSend((v) => !v)}
            >
              {interruptOnSend ? "发送:打断" : "发送:插入"}
            </Button>
          </View>
        ) : null}
        {/* 四选择 pill（会话态 provider 锁定；无目录的 pill 隐藏） */}
        <ScrollView className="chat-pills" scrollX enhanced showScrollbar={false}>
          {pillViews
            .filter((pill) => !pill.hidden)
            .map((pill) => (
              <View
                key={pill.key}
                className={`chat-pill ${pill.locked ? "chat-pill-locked" : ""}`}
                onClick={() => {
                  if (pill.locked) return;
                  setPickerPill(pill.key);
                }}
              >
                {pill.key === "provider" ? (
                  <Image className="icon icon-sm" src={providerIconUrl(pill.label)} />
                ) : null}
                <View className="chat-pill-text">{pill.label}</View>
                {!pill.locked ? (
                  <Image className="icon icon-sm" src={iconUrl("chevron-down")} />
                ) : null}
              </View>
            ))}
        </ScrollView>
        {pendingFiles.length > 0 ? (
          <ScrollView className="attach-tray" scrollX enhanced showScrollbar={false}>
            {pendingFiles.map((file) => (
              <View key={file.key} className={`attach-chip attach-chip-${file.status}`}>
                {file.status === "uploading" ? (
                  <View className="attach-chip-progress num">{file.progress}%</View>
                ) : file.status === "error" ? (
                  <Image className="icon icon-sm" src={iconUrl("warning")} />
                ) : (
                  <Image
                    className="icon icon-sm"
                    src={iconUrl(file.localPath ? "image" : "paperclip")}
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
        {/* 斜杠命令面板（输入 / 触发） */}
        {draftText.startsWith("/") && commands !== null && commands.length > 0 && activeAgent ? (
          <ScrollView className="slash-panel" scrollY enhanced showScrollbar={false}>
            {commands
              .filter((cmd) =>
                draftText === "/" ? true : `/${cmd.name}`.startsWith(draftText.split(" ")[0] ?? ""),
              )
              .slice(0, 8)
              .map((cmd) => (
                <View
                  key={cmd.name}
                  className="slash-row"
                  onClick={() => setDraftText(`/${cmd.name} `)}
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
            value={draftText}
            onInput={(e) => setDraftText(e.detail.value)}
            onConfirm={() => void send()}
            placeholder={connected ? (activeAgent ? "输入消息…" : "描述任务，发送即创建会话…") : "连接设备后开始对话"}
            placeholderClass="composer-placeholder"
            confirmType="send"
            confirmHold
            disabled={!connected}
          />
          <View
            className={`send-btn ${sendable ? "send-ready" : ""}`}
            onClick={() => void send()}
          >
            <Image className="icon" src={iconUrl("send", "-inverse")} />
          </View>
        </View>
      </View>

      <SessionDrawer
        visible={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onSelect={(id) => sessionStore.setActive(id)}
        onArchive={(id, archived) => void drawerArchive(id, archived)}
        onDelete={(id) => void drawerDelete(id)}
        onNewChat={() => sessionStore.setActive(null)}
      />
      <ConfigPickerSheet
        visible={pickerPill !== null}
        title={pickerPill ? PILL_TITLES[pickerPill] : ""}
        pill={pillViews.find((p) => p.key === pickerPill) ?? null}
        onClose={() => setPickerPill(null)}
        onSelect={(value) => {
          if (pickerPill) void onPillSelect(pickerPill, value);
        }}
      />
      <WorkspacePicker
        visible={workspacePickerVisible}
        selectedId={workspace?.workspaceId ?? null}
        onClose={() => setWorkspacePickerVisible(false)}
        onSelect={onWorkspaceSelected}
      />
      <PermissionOverlay />
    </View>
  );
}
