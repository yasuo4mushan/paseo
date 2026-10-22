/**
 * 文件浏览器（t17）：当前工作区范围内的目录浏览、预览与下载保存。
 *
 * 连接层：file_explorer_request（list / file+acceptBinary 二进制帧）。
 * 预览策略（按扩展名粗分，真实 mime 以 daemon 返回为准）：
 * - 文本/代码：内嵌渲染，超过 maxBytes 由 daemon 直接拒绝（"File is too large to display"）
 * - 图片：读字节 → 写本地临时文件 → wx.previewImage 全屏
 * - PDF/Office：读字节 → 写下载目录 → wx.openDocument
 * - 其他：提供下载保存（wx.shareFileMessage 转发/另存入口）
 */

import { useCallback, useEffect, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { FileExplorerEntry } from "@/connection/protocol-types";
import { decodeUtf8 } from "@/connection/utf8";
import { useThemeClass } from "@/hooks/use-theme";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { fileCategory, fileIcon, formatFileSize } from "@/utils/files";
import {
  documentFileType,
  openDocument,
  previewImage,
  saveBytesToDownload,
  shareFile,
} from "@/utils/file-ops";
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

export default function FilesPage() {
  const themeClass = useThemeClass();
  const workspace = useWorkspaceSelection();
  const [entries, setEntries] = useState<FileExplorerEntry[]>([]);
  const [dirStack, setDirStack] = useState<string[]>([]); // 相对路径栈，["."]=根
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [textPreview, setTextPreview] = useState<TextPreview | null>(null);
  const [download, setDownload] = useState<DownloadState | null>(null);

  const cwd = workspace?.directory ?? "";

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
  ): Promise<{ bytes: Uint8Array; mime: string; size: number }> => {
    const conn = connectionManager.requireConnection();
    const result = await conn.readFile({
      cwd,
      path: entry.path,
      ...(maxBytes ? { maxBytes } : {}),
      timeoutMs: 180_000,
      onProgress: (received, total) => setDownload({ fileName: entry.name, received, total }),
    });
    return { bytes: result.bytes, mime: result.mime, size: result.size };
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

  if (!cwd) {
    return (
      <View className={`page ${themeClass}`}>
        <View className="card empty">
          <View className="empty-icon">📂</View>
          <View className="empty-title">未选择工作区</View>
          <View className="empty-desc">
            文件浏览基于当前工作区，先在 Agent 列表顶部选择一个工作区。
          </View>
          <Button className="btn btn-mini" onClick={() => Taro.navigateBack()}>
            返回选择
          </Button>
        </View>
      </View>
    );
  }

  const currentDir = dirStack[dirStack.length - 1] ?? ".";
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
        </View>
        <View className="faint files-ws">{workspace?.label ?? ""}</View>
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
          <View className="empty-icon">🗂</View>
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
              onLongPress={() => (entry.kind === "file" ? void downloadCurrent(entry) : undefined)}
            >
              <View className="file-icon">{fileIcon(entry.kind, entry.name)}</View>
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
            点按文件预览 · 长按下载保存到手机（当前目录：{currentDir === "." ? "根" : currentDir}）
          </View>
        </ScrollView>
      )}

      {textPreview ? (
        <View className="preview-overlay">
          <View className="preview-head">
            <View className="preview-title">{textPreview.fileName}</View>
            <View className="preview-close" onClick={() => setTextPreview(null)}>
              ✕
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
    </View>
  );
}
