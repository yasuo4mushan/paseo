/**
 * 设备侧文件夹选择器（t24，向导第②步内联面板）。
 *
 * 协议（考古 packages/app add-project-flow + daemon file-explorer service）：
 * - 浏览：file_explorer_request(mode:"list") 的 cwd 不限定已注册工作区——任意
 *   绝对路径或 "~" 都可作 root（daemon expandUserPath 展开），path 只不得逃出
 *   root。本组件固定 root="/"、path 传 trail，响应的归一化 path 即绝对 trail
 *   （初始 "~" → "Users/<name>"，home 路径由此还原，无需额外 RPC）。
 * - 新建文件夹：fs.entry.create.request(kind:"directory")，纯 mkdir、不注册项目
 *   （daemon 另有 project.create_directory = mkdir+立即注册；向导在确认时统一
 *   open_project 注册，避免双注册）。
 * - 确认：返回绝对路径 + 名称，由向导走 open_project_request → create_agent。
 *
 * Windows daemon（无 "/" 根）回落 root="~"：路径显示 ~/…，open_project 同样
 * 支持 "~" 前缀（daemon 侧展开）。
 */

import { useCallback, useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Image, ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { FileExplorerEntry } from "@/connection/protocol-types";
import { iconUrl } from "@/utils/icons";
import {
  absoluteTrailPath,
  breadcrumbSegments,
  childTrail,
  parentTrail,
  relativeTrailPath,
  trailFromDaemonPath,
  trailName,
  trailToDepth,
  validateFolderName,
} from "@/utils/folder-path";
import "./folder-picker.css";

export interface FolderSelection {
  path: string;
  name: string;
}

export interface FolderPickerProps {
  /** 记住上次浏览位置（向导回点第②步不重置）。 */
  initialTrail?: string[];
  initialRootLabel?: string;
  /** 选择确认（返回绝对路径 + 名称）。 */
  onSelect: (folder: FolderSelection) => void;
  /** trail 变化回调（父级持久化浏览位置）。 */
  onTrailChange?: (trail: string[], rootLabel: string) => void;
}

/** 可输入弹窗（wx.showModal editable；Taro 类型未跟上，同 files 页局部断言）。 */
function editableModal(input: {
  title: string;
  placeholderText?: string;
}): Promise<{ confirm: boolean; content: string }> {
  return Taro.showModal({
    title: input.title,
    editable: true,
    placeholderText: input.placeholderText,
  } as Taro.showModal.Option) as unknown as Promise<{ confirm: boolean; content: string }>;
}

export function FolderPicker({
  initialTrail,
  initialRootLabel,
  onSelect,
  onTrailChange,
}: FolderPickerProps) {
  const [rootLabel, setRootLabel] = useState(initialRootLabel ?? "/");
  // null = 尚未完成首次定位（先 browse "/"+"~" 还原 home trail）
  const [trail, setTrail] = useState<string[] | null>(initialTrail ?? null);
  const [entries, setEntries] = useState<FileExplorerEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const notifyTrail = useCallback(
    (next: string[], label: string) => {
      onTrailChange?.(next, label);
    },
    [onTrailChange],
  );

  const browse = useCallback(
    async (targetTrail: string[], label: string) => {
      const conn = connectionManager.getConnection();
      if (!conn) {
        setError("未连接设备");
        setLoading(false);
        return;
      }
      setLoading(true);
      setError("");
      try {
        const result = await conn.browseDirectory(label, relativeTrailPath(targetTrail), 30_000);
        setEntries(result.entries);
        setTrail(targetTrail);
        notifyTrail(targetTrail, label);
      } catch (err) {
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [notifyTrail],
  );

  // 首次挂载：定位 home（POSIX 根 browse "~" 会返回 "Users/<name>"；
  // 失败（Windows/无 "/" 根）回落 root "~"）
  useEffect(() => {
    if (trail) {
      void browse(trail, rootLabel);
      return;
    }
    let disposed = false;
    void (async () => {
      const conn = connectionManager.getConnection();
      if (!conn) {
        setError("未连接设备");
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const home = await conn.browseDirectory("/", "~", 30_000);
        if (disposed) return;
        const homeTrail = trailFromDaemonPath(home.path);
        setRootLabel("/");
        setEntries(home.entries);
        setTrail(homeTrail);
        notifyTrail(homeTrail, "/");
      } catch {
        if (disposed) return;
        try {
          const fallback = await conn.browseDirectory("~", ".", 30_000);
          if (disposed) return;
          setRootLabel("~");
          setEntries(fallback.entries);
          setTrail([]);
          notifyTrail([], "~");
        } catch (err) {
          if (!disposed) setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (!disposed) setLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
    // 仅首挂载执行定位；后续导航走 browse()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enterDirectory = (entry: FileExplorerEntry) => {
    if (!trail) return;
    void browse(childTrail(trail, entry.name), rootLabel);
  };

  const goUp = () => {
    if (!trail) return;
    void browse(parentTrail(trail), rootLabel);
  };

  const jumpToDepth = (depth: number) => {
    if (!trail) return;
    void browse(trailToDepth(trail, depth), rootLabel);
  };

  const createFolder = async () => {
    if (!trail) return;
    const { confirm, content } = await editableModal({
      title: `在 ${absoluteTrailPath(trail, rootLabel)} 下新建文件夹`,
      placeholderText: "文件夹名称",
    });
    const name = content?.trim() ?? "";
    if (!confirm || !name) return;
    const invalid = validateFolderName(name);
    if (invalid) {
      Taro.showToast({ title: invalid, icon: "none" });
      return;
    }
    try {
      const result = await connectionManager.requireConnection().createFsEntry({
        cwd: rootLabel,
        parentPath: relativeTrailPath(trail),
        name,
        kind: "directory",
      });
      if (!result.success) throw new Error(result.error ?? "创建失败");
      Taro.showToast({ title: "已创建", icon: "success" });
      // 创建后直接进入新文件夹（常见意图：新项目就建在这里）
      void browse(childTrail(trail, name), rootLabel);
    } catch (err) {
      Taro.showToast({
        title: `创建失败：${(err instanceof Error ? err.message : String(err)).slice(0, 40)}`,
        icon: "none",
      });
    }
  };

  const confirmSelection = () => {
    if (!trail) return;
    onSelect({
      path: absoluteTrailPath(trail, rootLabel),
      name: trailName(trail, rootLabel),
    });
  };

  const directories = (entries ?? []).filter((entry) => entry.kind === "directory");
  const crumbs = trail ? breadcrumbSegments(trail, rootLabel) : [];

  return (
    <View className="fp-panel">
      <View className="fp-head">
        <View className="fp-up" onClick={goUp}>
          <Image className="icon icon-sm" src={iconUrl("back")} />
          <View>上一级</View>
        </View>
        <View className="fp-actions">
          <View className="fp-new" onClick={() => void createFolder()}>
            <Image className="icon icon-sm" src={iconUrl("plus")} />
            <View>新建文件夹</View>
          </View>
        </View>
      </View>

      {crumbs.length > 0 ? (
        <ScrollView className="fp-crumbs" scrollX enhanced showScrollbar={false}>
          {crumbs.map((crumb, index) => (
            <View key={`${crumb.depth}-${crumb.label}`} className="fp-crumb-row">
              {index > 0 ? <View className="fp-crumb-sep">/</View> : null}
              <View
                className={`fp-crumb ${index === crumbs.length - 1 ? "fp-crumb-current" : ""}`}
                onClick={() => jumpToDepth(crumb.depth)}
              >
                {crumb.label}
              </View>
            </View>
          ))}
        </ScrollView>
      ) : null}

      {error ? <View className="field-error">{error}</View> : null}

      <ScrollView className="fp-list" scrollY enhanced showScrollbar={false}>
        {loading ? (
          <View className="loading-tip">读取设备目录…</View>
        ) : directories.length === 0 ? (
          <View className="muted fp-empty">这个目录下没有子文件夹</View>
        ) : (
          directories.map((entry) => (
            <View key={entry.path} className="fp-row" onClick={() => enterDirectory(entry)}>
              <Image className="icon icon-sm fp-row-icon" src={iconUrl("project")} />
              <View className="fp-row-name">{entry.name}</View>
              <Image className="icon icon-sm fp-row-arrow" src={iconUrl("chevron-down")} />
            </View>
          ))
        )}
      </ScrollView>

      <Button className="btn btn-block fp-confirm" onClick={confirmSelection}>
        选择此文件夹
      </Button>
      <View className="faint fp-hint">
        在设备文件系统上逐级浏览；"新建文件夹"会在当前目录创建后直接进入。
      </View>
    </View>
  );
}
