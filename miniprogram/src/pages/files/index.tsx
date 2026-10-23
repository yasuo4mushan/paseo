/**
 * 文件浏览器（t17 建立，t19 增强）。
 *
 * 连接层：
 * - file_explorer_request（list / file+acceptBinary 二进制帧）—— t17
 * - fs.file.write / fs.entry.create / fs.entry.rename / fs.entry.delete —— t19
 * - fs.file.subscribe → fs.file.update 推送（编辑器打开期间检测远端变更）—— t19
 *
 * 预览策略（按扩展名粗分，真实 mime 以 daemon 返回为准）：
 * - 文本/代码：内嵌渲染（可进编辑器写回），超过 maxBytes 由 daemon 直接拒绝
 * - 图片：读字节 → 写本地临时文件 → wx.previewImage 全屏
 * - PDF/Office：读字节 → 写下载目录 → wx.openDocument
 * - 其他：提供下载保存（wx.shareFileMessage 转发/另存入口）
 *
 * 写回冲突（utils/file-edit.ts 状态机）：expectedModifiedAt/revision 是读时版本；
 * daemon 报 conflict 时弹三选（重新加载 / 覆盖远端 / 继续编辑）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { useLoad, usePullDownRefresh } from "@tarojs/taro";
import { Button, ScrollView, Textarea, View, Image } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { MODAL_DANGER_COLOR } from "@/constants/colors";
import type { FileExplorerEntry } from "@/connection/protocol-types";
import { decodeUtf8 } from "@/connection/utf8";
import { useThemeClass } from "@/hooks/use-theme";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { fileCategory, fileIcon, formatFileSize } from "@/utils/files";
import { iconUrl } from "@/utils/icons";
import { safeNavigateTo } from "@/utils/navigation";
import {
  documentFileType,
  openDocument,
  previewImage,
  saveBytesToDownload,
  shareFile,
} from "@/utils/file-ops";
import {
  initialFileEditState,
  nextFileEditState,
  type FileEditState,
  type FileEditVersion,
} from "@/utils/file-edit";
import "./index.css";

/** 内联文本预览的读取上限与渲染上限。 */
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024;
const TEXT_RENDER_MAX_CHARS = 40_000;

interface TextPreview {
  fileName: string;
  content: string;
  truncated: boolean;
  size: number;
}

interface DownloadState {
  fileName: string;
  received: number;
  total: number;
}

/** t19：编辑器会话（fs.file.write 写回）。 */
interface EditorSession {
  path: string;
  name: string;
  content: string;
}

/** 订阅工作区选择（同 agents 页模式：useState+useEffect，不用 useSyncExternalStore）。 */
function useWorkspaceSelection(): WorkspaceSelection | null {
  const [selection, setSelection] = useState<WorkspaceSelection | null>(() =>
    workspaceStore.getSnapshot(),
  );
  useEffect(() => workspaceStore.subscribe(() => setSelection(workspaceStore.getSnapshot())), []);
  return selection;
}

function formatFileTime(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const now = new Date();
  const sameYear = date.getFullYear() === now.getFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  const core = `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return sameYear ? core : `${date.getFullYear()}-${core}`;
}

/** 自动化/调试桥：记录关键 wx 调用结果（app.ts 安装，未安装时静默）。 */
function recordAutomationEvent(event: Record<string, unknown>): void {
  const app = Taro.getApp?.() as unknown as
    | {
        __automation?: { downloadLog?: Array<Record<string, unknown>> };
      }
    | undefined;
  app?.__automation?.downloadLog?.push({ ...event, at: Date.now() });
}

/**
 * 可输入弹窗（wx.showModal editable）：Taro 4.3 类型未跟上微信 baselib 的
 * editable/placeholderText 参数与 content 返回值，这里做局部断言。
 */
function editableModal(input: {
  title: string;
  placeholderText?: string;
  content?: string;
  confirmText?: string;
  cancelText?: string;
}): Promise<{ confirm: boolean; content: string }> {
  return Taro.showModal({
    title: input.title,
    editable: true,
    placeholderText: input.placeholderText,
    ...(input.content !== undefined ? { content: input.content } : {}),
    ...(input.confirmText ? { confirmText: input.confirmText } : {}),
    ...(input.cancelText ? { cancelText: input.cancelText } : {}),
  } as Taro.showModal.Option) as unknown as Promise<{ confirm: boolean; content: string }>;
}

export default function FilesPage() {
  const themeClass = useThemeClass();
  const workspace = useWorkspaceSelection();
  const [entries, setEntries] = useState<FileExplorerEntry[]>([]);
  const [dirStack, setDirStack] = useState<string[]>([]); // 相对路径栈，["."]=根
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textPreview, setTextPreview] = useState<TextPreview | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);
  // t24：cwd 直达参数（会话详情"文件"按钮/向导第④步入口带会话目录进来）
  const [cwdOverride, setCwdOverride] = useState("");
  // t24：无工作区时的冷启动兜底（设备卡"文件"直达可能还没选过工作区）
  const [autoSelectState, setAutoSelectState] = useState<"idle" | "trying" | "none">("idle");

  useLoad((options) => {
    const raw = options?.cwd ? decodeURIComponent(options.cwd) : "";
    setCwdOverride(raw.startsWith("/") || raw.startsWith("~") ? raw : "");
  });

  const cwd = cwdOverride || workspace?.directory || "";

  // 冷启动兜底：无直达参数且未选工作区 → 拉工作区列表选第一个（P1 入口找回）
  useEffect(() => {
    if (cwdOverride || workspace) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    setAutoSelectState("trying");
    void (async () => {
      try {
        const result = await conn.fetchWorkspaces();
        if (disposed) return;
        if (result.workspaces.length > 0) {
          workspaceStore.select(result.workspaces[0]);
          setAutoSelectState("idle");
        } else {
          setAutoSelectState("none");
        }
      } catch {
        if (!disposed) setAutoSelectState("none");
      }
    })();
    return () => {
      disposed = true;
    };
  }, [cwdOverride, workspace]);

  // t19：编辑器状态机 + 会话 + 文件订阅
  const [editState, setEditState] = useState<FileEditState>(initialFileEditState);
  const [editor, setEditor] = useState<EditorSession | null>(null);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const fileSubscriptionRef = useRef<string | null>(null);

  const currentDir = dirStack[dirStack.length - 1] ?? ".";

  const loadDirectory = useCallback(
    async (path: string) => {
      const conn = connectionManager.getConnection();
      if (!conn) {
        setError("未连接设备");
        return;
      }
      setLoading(true);
      setError("");
      try {
        const list = await conn.listDirectory(cwd, path, 30_000);
        setEntries(list);
      } catch (err) {
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  useEffect(() => {
    workspaceStore.restore();
  }, []);

  useEffect(() => {
    if (!cwd) return;
    void loadDirectory(".");
    setDirStack([]);
  }, [cwd, loadDirectory]);

  usePullDownRefresh(async () => {
    const current = dirStack[dirStack.length - 1] ?? ".";
    await loadDirectory(current);
    Taro.stopPullDownRefresh();
  });

  // t19：fs.file.update → 编辑器远端变更横幅（按 subscriptionId 过滤——编辑期间只订这一个文件）
  useEffect(() => {
    if (!editor) return;
    const unsubscribe = connectionManager.onFileUpdate((push) => {
      const subscriptionId = fileSubscriptionRef.current;
      if (!subscriptionId || push.subscriptionId !== subscriptionId) return;
      if (push.version.status !== "ready") return;
      if (push.version.modifiedAt !== editState.base?.modifiedAt) {
        setRemoteChanged(true);
      }
    });
    return unsubscribe;
  }, [editor, editState.base?.modifiedAt]);

  const openDirectory = (entry: FileExplorerEntry) => {
    setDirStack((prev) => [...prev, entry.path]);
    void loadDirectory(entry.path);
  };

  const goBack = () => {
    setDirStack((prev) => {
      const next = prev.slice(0, -1);
      void loadDirectory(next[next.length - 1] ?? ".");
      return next;
    });
  };

  /** 读取文件字节（下载/预览共用；无 maxBytes = 完整下载）。 */
  const fetchFileBytes = async (
    entry: FileExplorerEntry,
    maxBytes?: number,
  ): Promise<{
    bytes: Uint8Array;
    mime: string;
    size: number;
    modifiedAt?: string;
    revision?: string;
  }> => {
    const conn = connectionManager.requireConnection();
    const result = await conn.readFile({
      cwd,
      path: entry.path,
      ...(maxBytes ? { maxBytes } : {}),
      timeoutMs: 180_000,
      onProgress: (received, total) => setDownload({ fileName: entry.name, received, total }),
    });
    return {
      bytes: result.bytes,
      mime: result.mime,
      size: result.size,
      modifiedAt: result.modifiedAt,
      revision: result.revision,
    };
  };

  /** 下载保存到手机：读字节 → 下载目录 → toast；返回本地路径。 */
  const downloadAndSave = async (entry: FileExplorerEntry): Promise<string | null> => {
    try {
      setDownload({ fileName: entry.name, received: 0, total: entry.size });
      const { bytes } = await fetchFileBytes(entry);
      const filePath = await saveBytesToDownload(entry.name, bytes);
      setDownload(null);
      recordAutomationEvent({
        kind: "download_complete",
        fileName: entry.name,
        filePath,
        size: bytes.byteLength,
      });
      Taro.showToast({ title: "已保存到手机", icon: "success" });
      return filePath;
    } catch (err) {
      setDownload(null);
      const message = err instanceof Error ? err.message : String(err);
      recordAutomationEvent({ kind: "download_failed", fileName: entry.name, error: message });
      Taro.showToast({ title: `下载失败：${message.slice(0, 40)}`, icon: "none" });
      return null;
    }
  };

  const previewText = async (entry: FileExplorerEntry) => {
    try {
      setDownload({ fileName: entry.name, received: 0, total: entry.size });
      const { bytes, size } = await fetchFileBytes(entry, TEXT_PREVIEW_MAX_BYTES);
      setDownload(null);
      const full = decodeUtf8(bytes);
      const truncated = full.length > TEXT_RENDER_MAX_CHARS || size > TEXT_PREVIEW_MAX_BYTES;
      setTextPreview({
        fileName: entry.name,
        content: full.slice(0, TEXT_RENDER_MAX_CHARS),
        truncated,
        size,
      });
    } catch (err) {
      setDownload(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const previewImageFile = async (entry: FileExplorerEntry) => {
    try {
      setDownload({ fileName: entry.name, received: 0, total: entry.size });
      const { bytes } = await fetchFileBytes(entry);
      const filePath = await saveBytesToDownload(entry.name, bytes);
      setDownload(null);
      recordAutomationEvent({ kind: "preview_image", fileName: entry.name, filePath });
      previewImage(filePath);
    } catch (err) {
      setDownload(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const previewDocument = async (entry: FileExplorerEntry) => {
    const filePath = await downloadAndSave(entry);
    if (!filePath) return;
    try {
      await openDocument(filePath, documentFileType(entry.name));
      recordAutomationEvent({ kind: "open_document", ok: true, fileName: entry.name, filePath });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAutomationEvent({
        kind: "open_document",
        ok: false,
        fileName: entry.name,
        error: message,
      });
      Taro.showToast({ title: `文档预览失败：${message.slice(0, 30)}`, icon: "none" });
    }
  };

  const offerShare = async (entry: FileExplorerEntry, filePath: string) => {
    const { confirm } = await Taro.showModal({
      title: entry.name,
      content: `已保存 ${formatFileSize(entry.size)}。转发到聊天可长期保存。`,
      confirmText: "转发",
      cancelText: "关闭",
    });
    if (!confirm) return;
    try {
      await shareFile(filePath, entry.name);
    } catch {
      Taro.showToast({ title: "转发已取消", icon: "none" });
    }
  };

  const openFile = async (entry: FileExplorerEntry) => {
    const category = fileCategory(entry.name);
    if (entry.size > 50 * 1024 * 1024) {
      Taro.showToast({ title: "文件超过 50MB，暂不支持", icon: "none" });
      return;
    }
    switch (category) {
      case "text":
        await previewText(entry);
        return;
      case "image":
        await previewImageFile(entry);
        return;
      case "document":
        await previewDocument(entry);
        return;
      default: {
        // 二进制/压缩包：直接下载保存 + 转发入口
        const filePath = await downloadAndSave(entry);
        if (filePath) await offerShare(entry, filePath);
      }
    }
  };

  const downloadCurrent = async (entry: FileExplorerEntry) => {
    const filePath = await downloadAndSave(entry);
    if (filePath) await offerShare(entry, filePath);
  };

  // ---- t19：编辑器（fs.file.write 写回 + fs.file.subscribe 远端变更检测） ----

  /** 打开编辑器：重读文件（拿权威 modifiedAt/revision）→ 订阅变更。 */
  const openEditor = async (entry: FileExplorerEntry) => {
    const preview = textPreview;
    setTextPreview(null);
    if (!preview || preview.truncated || preview.fileName !== entry.name) {
      Taro.showToast({ title: "请先从预览进入编辑", icon: "none" });
      return;
    }
    try {
      setDownload({ fileName: entry.name, received: 0, total: entry.size });
      const { bytes, modifiedAt, revision } = await fetchFileBytes(entry, TEXT_PREVIEW_MAX_BYTES);
      setDownload(null);
      const content = decodeUtf8(bytes);
      setEditor({ path: entry.path, name: entry.name, content });
      setRemoteChanged(false);
      setEditState(
        nextFileEditState(initialFileEditState, {
          type: "loaded",
          version: {
            modifiedAt: modifiedAt ?? new Date().toISOString(),
            ...(revision ? { revision } : {}),
          },
        }),
      );
      recordAutomationEvent({ kind: "editor_open", path: entry.path, modifiedAt });
      // 订阅远端变更（编辑期间文件被 agent/他人修改 → 横幅提示）
      const conn = connectionManager.getConnection();
      if (conn) {
        try {
          const sub = await conn.subscribeFile({ cwd, path: entry.path });
          fileSubscriptionRef.current = sub.subscriptionId;
        } catch {
          // 订阅失败不阻塞编辑（保存时的冲突检测仍兜底）
        }
      }
    } catch (err) {
      setDownload(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const closeEditor = async () => {
    if (editState.status === "dirty" || editState.status === "conflict") {
      const { confirm } = await Taro.showModal({
        title: "放弃修改",
        content: "有未保存的修改，确定关闭编辑器？",
        confirmText: "放弃",
        cancelText: "继续编辑",
        confirmColor: MODAL_DANGER_COLOR,
      });
      if (!confirm) return;
    }
    const subId = fileSubscriptionRef.current;
    fileSubscriptionRef.current = null;
    if (subId) {
      await connectionManager
        .getConnection()
        ?.unsubscribeFile(subId)
        .catch(() => {});
    }
    setEditor(null);
    setEditState(initialFileEditState);
    setRemoteChanged(false);
  };

  const performWrite = async (version: FileEditVersion | null) => {
    if (!editor) return;
    setEditState((prev) => nextFileEditState(prev, { type: "save_started" }));
    try {
      const conn = connectionManager.requireConnection();
      const base = version ?? editState.base;
      if (!base) throw new Error("缺少版本信息，请重新打开文件");
      const result = await conn.writeFile({
        cwd,
        path: editor.path,
        content: editor.content,
        expectedModifiedAt: base.modifiedAt,
        ...(base.revision ? { expectedRevision: base.revision } : {}),
      });
      if (result.status === "written") {
        setEditState((prev) =>
          nextFileEditState(prev, {
            type: "save_written",
            version: {
              modifiedAt: result.modifiedAt,
              ...(result.revision ? { revision: result.revision } : {}),
            },
          }),
        );
        setRemoteChanged(false);
        recordAutomationEvent({ kind: "write_saved", path: editor.path, size: result.size });
        Taro.showToast({ title: "已保存", icon: "success" });
        setTimeout(
          () => setEditState((prev) => nextFileEditState(prev, { type: "acknowledge" })),
          800,
        );
      } else if (result.status === "conflict") {
        const remote =
          result.version.status === "ready"
            ? {
                modifiedAt: result.version.modifiedAt,
                ...(result.version.revision ? { revision: result.version.revision } : {}),
              }
            : null;
        recordAutomationEvent({ kind: "write_conflict", path: editor.path });
        if (remote) {
          setEditState((prev) => nextFileEditState(prev, { type: "save_conflict", remote }));
        } else {
          setEditState((prev) =>
            nextFileEditState(prev, {
              type: "save_failed",
              error:
                result.version.status === "missing"
                  ? "文件在设备上已被删除"
                  : result.version.status === "error"
                    ? result.version.error
                    : "冲突且无法读取远端版本",
            }),
          );
        }
      } else {
        setEditState((prev) =>
          nextFileEditState(prev, { type: "save_failed", error: result.error }),
        );
      }
    } catch (err) {
      setEditState((prev) =>
        nextFileEditState(prev, {
          type: "save_failed",
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  };

  const saveEditor = async () => {
    if (!editor || editState.status !== "dirty") return;
    await performWrite(null);
  };

  /** 冲突三选：重新加载（重读内容）/ 覆盖远端（以远端版本号重写）/ 继续编辑。 */
  const resolveConflict = async () => {
    if (!editor || editState.status !== "conflict") return;
    const { tapIndex } = await Taro.showActionSheet({
      itemList: ["重新加载（丢弃本地修改）", "覆盖远端版本", "继续编辑"],
    });
    if (tapIndex === 0) {
      setEditState((prev) => nextFileEditState(prev, { type: "conflict_reload" }));
      const entry = entries.find((e) => e.path === editor.path);
      if (entry) {
        try {
          const { bytes, modifiedAt, revision } = await fetchFileBytes(
            entry,
            TEXT_PREVIEW_MAX_BYTES,
          );
          setEditor({ ...editor, content: decodeUtf8(bytes) });
          setEditState((prev) =>
            nextFileEditState(prev, {
              type: "loaded",
              version: {
                modifiedAt: modifiedAt ?? new Date().toISOString(),
                ...(revision ? { revision } : {}),
              },
            }),
          );
          setRemoteChanged(false);
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    } else if (tapIndex === 1) {
      const base = editState.remote ?? editState.base;
      setEditState((prev) => nextFileEditState(prev, { type: "conflict_overwrite_started" }));
      await performWrite(base);
    }
    // tapIndex 2 / 取消：留在 conflict 态，用户改内容自然回 dirty
  };

  // ---- t19：条目操作（fs.entry.*） ----

  const createEntry = async () => {
    const { tapIndex } = await Taro.showActionSheet({ itemList: ["新建文件", "新建文件夹"] });
    if (tapIndex !== 0 && tapIndex !== 1) return;
    const kind = tapIndex === 0 ? "file" : "directory";
    const { confirm, content } = await editableModal({
      title: kind === "file" ? "新建文件" : "新建文件夹",
      placeholderText: kind === "file" ? "例如 notes.md" : "例如 docs",
      confirmText: "创建",
      cancelText: "取消",
    });
    const name = (content ?? "").trim();
    if (!confirm || !name || name.includes("/")) return;
    try {
      const result = await connectionManager.requireConnection().createFsEntry({
        cwd,
        parentPath: currentDir,
        name,
        kind,
      });
      if (!result.success) throw new Error(result.error ?? "创建失败");
      recordAutomationEvent({ kind: "entry_created", path: result.path ?? name, kindType: kind });
      Taro.showToast({ title: "已创建", icon: "success" });
      await loadDirectory(currentDir);
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : "创建失败",
        icon: "none",
      });
    }
  };

  const entryActions = async (entry: FileExplorerEntry) => {
    const itemList = entry.kind === "file" ? ["重命名", "下载保存", "删除"] : ["重命名", "删除"];
    const { tapIndex } = await Taro.showActionSheet({ itemList });
    if (tapIndex === undefined || tapIndex < 0) return;
    if (itemList[tapIndex] === "重命名") {
      const { confirm, content } = await editableModal({
        title: "重命名",
        placeholderText: entry.name,
        content: entry.name,
        confirmText: "重命名",
        cancelText: "取消",
      });
      const name = (content ?? "").trim();
      if (!confirm || !name || name === entry.name || name.includes("/")) return;
      try {
        const result = await connectionManager.requireConnection().renameFsEntry({
          cwd,
          path: entry.path,
          name,
        });
        if (!result.success) throw new Error(result.error ?? "重命名失败");
        recordAutomationEvent({ kind: "entry_renamed", from: entry.path, to: result.renamedPath });
        await loadDirectory(currentDir);
      } catch (err) {
        Taro.showToast({ title: err instanceof Error ? err.message : "重命名失败", icon: "none" });
      }
      return;
    }
    if (itemList[tapIndex] === "下载保存") {
      await downloadCurrent(entry);
      return;
    }
    if (itemList[tapIndex] === "删除") {
      const { confirm } = await Taro.showModal({
        title: "删除",
        content: `确定删除 ${entry.kind === "directory" ? "文件夹" : "文件"} "${entry.name}"？${
          entry.kind === "directory" ? "文件夹内容将一并删除。" : ""
        }`,
        confirmText: "删除",
        confirmColor: MODAL_DANGER_COLOR,
        cancelText: "取消",
      });
      if (!confirm) return;
      try {
        const result = await connectionManager.requireConnection().deleteFsEntry({
          cwd,
          path: entry.path,
        });
        if (!result.success) throw new Error(result.error ?? "删除失败");
        recordAutomationEvent({ kind: "entry_deleted", path: entry.path });
        Taro.showToast({ title: "已删除", icon: "none" });
        await loadDirectory(currentDir);
      } catch (err) {
        Taro.showToast({ title: err instanceof Error ? err.message : "删除失败", icon: "none" });
      }
    }
  };

  // ---- t19：工作区终端（create_terminal → pages/terminal） ----

  const openWorkspaceTerminal = async () => {
    try {
      Taro.showLoading({ title: "打开终端…" });
      const conn = connectionManager.requireConnection();
      const terminal = await conn.createTerminal({
        cwd,
        ...(workspace?.workspaceId ? { workspaceId: workspace.workspaceId } : {}),
      });
      Taro.hideLoading();
      recordAutomationEvent({ kind: "terminal_created", terminalId: terminal.id });
      Taro.navigateTo({
        url: `/pages/terminal/index?terminalId=${encodeURIComponent(terminal.id)}&title=${encodeURIComponent(
          workspace?.label ?? "工作区终端",
        )}&kill=1`,
      });
    } catch (err) {
      Taro.hideLoading();
      Taro.showToast({ title: err instanceof Error ? err.message : "终端打开失败", icon: "none" });
    }
  };

  if (!cwd) {
    return (
      <View className={`page ${themeClass}`}>
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("project")} />
          <View className="empty-title">未选择工作区</View>
          <View className="empty-desc">
            {autoSelectState === "none"
              ? "设备上还没有项目工作区。用创建向导选一个设备文件夹即可注册。"
              : "文件浏览基于当前工作区，正在检查设备上的工作区…"}
          </View>
          {autoSelectState === "none" ? (
            <Button
              className="btn btn-mini"
              onClick={() => void safeNavigateTo("/pages/create/index")}
            >
              去创建项目
            </Button>
          ) : null}
        </View>
      </View>
    );
  }

  const breadcrumb = ["根", ...dirStack.map((p) => p.split("/").pop() ?? p)];
  const downloadPercent =
    download && download.total > 0
      ? Math.min(100, Math.round((download.received / download.total) * 100))
      : 0;

  return (
    <View className={`page files-page ${themeClass}`}>
      <View className="files-header">
        <View className="files-crumbs">
          {dirStack.length > 0 ? (
            <View className="crumbs-back" onClick={goBack}>
              ‹ 返回
            </View>
          ) : null}
          <View className="crumbs-path">
            {breadcrumb.map((part, i) => (
              <View key={i} className="crumbs-part">
                {i > 0 ? <View className="crumbs-sep">/</View> : null}
                <View
                  className={`crumbs-name ${i === breadcrumb.length - 1 ? "crumbs-current" : ""}`}
                >
                  {part}
                </View>
              </View>
            ))}
          </View>
          {/* t19：新建文件/文件夹入口 */}
          <View className="crumbs-add" onClick={() => void createEntry()}>
            <Image className="icon" src={iconUrl("plus")} />
          </View>
          {/* t19：工作区终端（create_terminal → 简化终端视图） */}
          <View className="crumbs-term" onClick={() => void openWorkspaceTerminal()}>
            &gt;_
          </View>
        </View>
        <View className="faint files-ws num">{cwdOverride || workspace?.label || ""}</View>
      </View>

      {error ? <View className="error-inline">{error}</View> : null}

      {download ? (
        <View className="card download-card">
          <View className="download-row">
            <View className="download-name">{download.fileName}</View>
            <View className="muted num">
              {download.total > 0
                ? `${formatFileSize(download.received)} / ${formatFileSize(download.total)}`
                : "准备中…"}
            </View>
          </View>
          <View className="download-bar">
            <View className="download-bar-fill" style={{ width: `${downloadPercent}%` }} />
          </View>
        </View>
      ) : null}

      {loading && entries.length === 0 ? (
        <View className="card empty">
          <View className="empty-title">读取目录中…</View>
        </View>
      ) : !loading && entries.length === 0 && !error ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("project")} />
          <View className="empty-title">空目录</View>
        </View>
      ) : (
        <ScrollView className="files-list" scrollY enhanced showScrollbar={false}>
          {entries.map((entry) => (
            <View
              key={entry.path}
              className="card file-row"
              onClick={() =>
                entry.kind === "directory" ? openDirectory(entry) : void openFile(entry)
              }
              onLongPress={() => void entryActions(entry)}
            >
              <Image className="icon file-icon" src={iconUrl(fileIcon(entry.kind, entry.name))} />
              <View className="file-main">
                <View className="file-name">{entry.name}</View>
                <View className="muted num file-meta">
                  {formatFileSize(entry.size)}
                  {formatFileTime(entry.modifiedAt) ? ` · ${formatFileTime(entry.modifiedAt)}` : ""}
                </View>
              </View>
              {entry.kind === "directory" ? <View className="faint file-arrow">›</View> : null}
            </View>
          ))}
          <View className="faint files-hint">
            点按打开 · 长按重命名/删除/下载（当前目录：{currentDir === "." ? "根" : currentDir}）
          </View>
        </ScrollView>
      )}

      {textPreview ? (
        <View className="preview-overlay">
          <View className="preview-head">
            <View className="preview-title">{textPreview.fileName}</View>
            <View className="preview-close" onClick={() => setTextPreview(null)}>
              <Image className="icon" src={iconUrl("close")} />
            </View>
          </View>
          <ScrollView className="preview-body" scrollY enhanced showScrollbar={false}>
            <View className="preview-text">{textPreview.content || "（空文件）"}</View>
          </ScrollView>
          <View className="preview-foot">
            {textPreview.truncated ? (
              <View className="faint preview-note">
                文件较大（{formatFileSize(textPreview.size)}），仅显示开头部分，可下载查看全文
              </View>
            ) : null}
            <Button
              className="btn btn-mini preview-edit"
              disabled={textPreview.truncated}
              onClick={() => {
                const entry = entries.find((e) => e.name === textPreview.fileName);
                if (entry) void openEditor(entry);
              }}
            >
              编辑
            </Button>
            <Button
              className="btn btn-mini preview-download"
              onClick={() => {
                const entry = entries.find((e) => e.name === textPreview.fileName);
                if (entry) void downloadCurrent(entry);
              }}
            >
              下载保存
            </Button>
          </View>
        </View>
      ) : null}

      {editor ? (
        <View className="preview-overlay editor-overlay">
          <View className="preview-head">
            <View className="preview-title">编辑 · {editor.name}</View>
            <View className="preview-close" onClick={() => void closeEditor()}>
              <Image className="icon" src={iconUrl("close")} />
            </View>
          </View>
          {remoteChanged ? (
            <View className="editor-banner">文件已在设备上被修改，保存前建议先处理冲突提示。</View>
          ) : null}
          {editState.error ? (
            <View className="error-inline editor-error">{editState.error}</View>
          ) : null}
          <Textarea
            className="editor-textarea num"
            value={editor.content}
            onInput={(e) => {
              setEditor({ ...editor, content: e.detail.value });
              setEditState((prev) => nextFileEditState(prev, { type: "change" }));
            }}
            maxlength={-1}
            autoHeight={false}
            disabled={editState.status === "saving"}
            placeholder="文件内容"
            placeholderClass="composer-placeholder"
          />
          <View className="editor-foot">
            <View className="faint editor-state">
              {editState.status === "dirty"
                ? "未保存"
                : editState.status === "saving"
                  ? "保存中…"
                  : editState.status === "conflict"
                    ? "冲突：远端已修改"
                    : "已同步"}
            </View>
            {editState.status === "conflict" ? (
              <Button className="btn btn-mini editor-save" onClick={() => void resolveConflict()}>
                处理冲突
              </Button>
            ) : (
              <Button
                className="btn btn-mini editor-save"
                disabled={editState.status !== "dirty"}
                onClick={() => void saveEditor()}
              >
                保存到设备
              </Button>
            )}
          </View>
        </View>
      ) : null}
    </View>
  );
}
