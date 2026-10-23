/**
 * 项目文件侧面板（t31）：对话页右侧滑入的工作区文件树。
 *
 * 数据与协议完全复用 files 页（file_explorer_request mode:"list"，cwd 固定为
 * 会话 cwd / 已选工作区目录，path 为相对路径）；交互差异：本组件是侧滑面板
 * （非整页），只读浏览 + 跳转——目录逐级进出、面包屑回点，点文件带
 * path/open 参数跳 files 页预览（预览/下载/编辑能力都归 files 页，不复制）。
 *
 * 深色：全部走 var(--*) tokens（页面根 .theme-dark 覆盖自动生效），无硬编码色。
 */

import { useCallback, useEffect, useState } from "react";
import { Image, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { FileExplorerEntry } from "@/connection/protocol-types";
import { useThemeClass } from "@/hooks/use-theme";
import { formatFileSize, fileIcon } from "@/utils/files";
import { iconUrl } from "@/utils/icons";
import { safeNavigateTo } from "@/utils/navigation";
import "./workspace-files-sheet.css";

export function WorkspaceFilesSheet({
  visible,
  onClose,
  cwd,
  workspaceLabel,
}: {
  visible: boolean;
  onClose: () => void;
  /** 工作区根（agent cwd 或已选工作区目录；空 = 无可浏览目录）。 */
  cwd: string;
  workspaceLabel: string;
}) {
  const themeClass = useThemeClass();
  // 目录栈（每层存累计相对路径；空栈 = 根，与 files 页 dirStack 同模型）
  const [dirStack, setDirStack] = useState<string[]>([]);
  const [entries, setEntries] = useState<FileExplorerEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [loadedCwd, setLoadedCwd] = useState("");

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
        const result = await conn.browseDirectory(cwd, path, 30_000);
        setEntries(result.entries);
      } catch (err) {
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [cwd],
  );

  // 打开/换工作区：换根重置到根目录；同根重开保留浏览位置（刷新当前层）
  useEffect(() => {
    if (!visible || !cwd) return;
    if (loadedCwd !== cwd) {
      setLoadedCwd(cwd);
      setDirStack([]);
      void loadDirectory(".");
      return;
    }
    void loadDirectory(dirStack[dirStack.length - 1] ?? ".");
    // dirStack 变化由 openDirectory/goBack 显式触发加载，这里只管开关面板
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, cwd, loadedCwd]);

  const openDirectory = (entry: FileExplorerEntry) => {
    setDirStack((prev) => [...prev, entry.path]);
    void loadDirectory(entry.path);
  };

  const goUp = () => {
    setDirStack((prev) => {
      const next = prev.slice(0, -1);
      void loadDirectory(next[next.length - 1] ?? ".");
      return next;
    });
  };

  const jumpToDepth = (depth: number) => {
    setDirStack((prev) => {
      const next = prev.slice(0, Math.max(0, Math.min(depth, prev.length)));
      void loadDirectory(next[next.length - 1] ?? ".");
      return next;
    });
  };

  /** 点文件 → files 页所在目录并自动打开预览（预览/下载/编辑都在那页）。 */
  const openFile = (entry: FileExplorerEntry) => {
    const parent = dirStack[dirStack.length - 1] ?? ".";
    void safeNavigateTo(
      `/pages/files/index?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(
        parent,
      )}&open=${encodeURIComponent(entry.path)}`,
    );
  };

  if (!visible) return null;

  const breadcrumb = ["根", ...dirStack.map((p) => p.split("/").pop() ?? p)];

  return (
    <View className={`wfs-mask ${themeClass}`} onClick={onClose} catchMove>
      <View className="wfs-panel" onClick={(e) => e.stopPropagation()}>
        <View className="wfs-head">
          <View className="wfs-head-main">
            <View className="wfs-title">项目文件</View>
            <View className="faint wfs-ws num">{workspaceLabel || cwd}</View>
          </View>
          <View className="wfs-close" onClick={onClose}>
            <Image className="icon" src={iconUrl("close")} />
          </View>
        </View>

        {!cwd ? (
          <View className="wfs-empty">
            <Image className="icon icon-xl" src={iconUrl("project")} />
            <View className="wfs-empty-title">还没有项目目录</View>
            <View className="wfs-empty-desc">
              先在上方选择项目工作区，或开始一个会话后再看它的文件。
            </View>
          </View>
        ) : (
          <>
            <View className="wfs-crumbs-row">
              <View
                className={`wfs-up ${dirStack.length === 0 ? "wfs-up-disabled" : ""}`}
                onClick={() => dirStack.length > 0 && goUp()}
              >
                <Image className="icon icon-sm" src={iconUrl("back")} />
                <View>上一级</View>
              </View>
              <ScrollView className="wfs-crumbs" scrollX enhanced showScrollbar={false}>
                {breadcrumb.map((part, index) => (
                  <View key={`${index}-${part}`} className="wfs-crumb-item">
                    {index > 0 ? <View className="wfs-crumb-sep">/</View> : null}
                    <View
                      className={`wfs-crumb ${index === breadcrumb.length - 1 ? "wfs-crumb-current" : ""}`}
                      onClick={() => jumpToDepth(index)}
                    >
                      {part}
                    </View>
                  </View>
                ))}
              </ScrollView>
            </View>

            {error ? <View className="field-error wfs-error">{error}</View> : null}

            <ScrollView className="wfs-list" scrollY enhanced showScrollbar={false}>
              {loading && entries.length === 0 ? (
                <View className="loading-tip">读取目录中…</View>
              ) : entries.length === 0 && !error ? (
                <View className="wfs-empty">
                  <Image className="icon icon-lg" src={iconUrl("project")} />
                  <View className="wfs-empty-desc">空目录</View>
                </View>
              ) : (
                entries.map((entry) => (
                  <View
                    key={entry.path}
                    className="wfs-row"
                    onClick={() =>
                      entry.kind === "directory" ? openDirectory(entry) : openFile(entry)
                    }
                  >
                    <Image
                      className="icon wfs-row-icon"
                      src={iconUrl(fileIcon(entry.kind, entry.name))}
                    />
                    <View className="wfs-row-main">
                      <View className="wfs-row-name">{entry.name}</View>
                      {entry.kind === "file" ? (
                        <View className="faint wfs-row-meta num">{formatFileSize(entry.size)}</View>
                      ) : null}
                    </View>
                    {entry.kind === "directory" ? (
                      <View className="faint wfs-row-arrow">›</View>
                    ) : null}
                  </View>
                ))
              )}
              <View className="faint wfs-hint">点文件跳转预览 · 点目录逐级展开</View>
            </ScrollView>
          </>
        )}
      </View>
    </View>
  );
}
