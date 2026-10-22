/**
 * 工作区选择器（t16）：半屏弹层，按项目分组列出 daemon 返回的工作区。
 * Agent 列表页顶部与创建表单共用。
 */

import { useCallback, useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { ScrollView, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { WorkspaceDescriptor } from "@/connection/protocol-types";
import "./workspace-picker.css";

export interface WorkspacePickerProps {
  visible: boolean;
  /** 当前选中的工作区 id（高亮标记）。 */
  selectedId: string | null;
  onClose: () => void;
  onSelect: (workspace: WorkspaceDescriptor) => void;
}

const STATUS_DOT_CLASS: Record<WorkspaceDescriptor["status"], string> = {
  needs_input: "ws-dot ws-dot-warn",
  failed: "ws-dot ws-dot-error",
  running: "ws-dot ws-dot-run",
  attention: "ws-dot ws-dot-warn",
  done: "ws-dot",
};

interface ProjectGroup {
  projectId: string;
  displayName: string;
  workspaces: WorkspaceDescriptor[];
}

export function groupByProject(workspaces: WorkspaceDescriptor[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const ws of workspaces) {
    const key = ws.projectId || ws.projectRootPath || "default";
    let group = groups.get(key);
    if (!group) {
      group = { projectId: key, displayName: ws.projectDisplayName || ws.projectRootPath, workspaces: [] };
      groups.set(key, group);
    }
    group.workspaces.push(ws);
  }
  return [...groups.values()];
}

export function WorkspacePicker({ visible, selectedId, onClose, onSelect }: WorkspacePickerProps) {
  const [workspaces, setWorkspaces] = useState<WorkspaceDescriptor[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    setWorkspaces(null);
    setError("");
    void (async () => {
      const conn = connectionManager.getConnection();
      if (!conn) {
        setError("未连接设备");
        return;
      }
      try {
        const result = await conn.fetchWorkspaces();
        if (!disposed) setWorkspaces(result.workspaces);
      } catch (err) {
        if (!disposed) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [visible]);

  const handleSelect = useCallback(
    (ws: WorkspaceDescriptor) => {
      onSelect(ws);
      onClose();
    },
    [onSelect, onClose],
  );

  if (!visible) return null;

  return (
    <View className="ws-mask" onClick={onClose}>
      <View className="ws-sheet" onClick={(e) => e.stopPropagation()}>
        <View className="ws-sheet-title">选择工作区</View>
        <ScrollView className="ws-list" scrollY enhanced showScrollbar={false}>
          {error ? <View className="error-inline">{error}</View> : null}
          {!workspaces && !error ? (
            <View className="loading-tip">加载中…</View>
          ) : null}
          {workspaces && workspaces.length === 0 && !error ? (
            <View className="loading-tip">daemon 上还没有已打开的工作区</View>
          ) : null}
          {workspaces
            ? groupByProject(workspaces).map((group) => (
                <View key={group.projectId} className="ws-group">
                  <View className="ws-group-name faint">{group.displayName}</View>
                  {group.workspaces.map((ws) => (
                    <View
                      key={ws.id}
                      className={`ws-row ${ws.id === selectedId ? "ws-row-active" : ""}`}
                      onClick={() => handleSelect(ws)}
                    >
                      <View className={STATUS_DOT_CLASS[ws.status] ?? "ws-dot"} />
                      <View className="ws-row-main">
                        <View className="ws-row-name">{ws.title ?? ws.name}</View>
                        <View className="ws-row-path faint">
                          {ws.workspaceDirectory ?? ws.projectRootPath}
                        </View>
                      </View>
                      {ws.id === selectedId ? <View className="ws-row-check">✓</View> : null}
                    </View>
                  ))}
                </View>
              ))
            : null}
          <View
            className="ws-new-row"
            onClick={() => {
              onClose();
              Taro.navigateTo({ url: "/pages/new-workspace/index" });
            }}
          >
            <View className="ws-new-icon">＋</View>
            <View className="ws-new-text">新建工作区（注册本机目录 / GitHub 克隆）</View>
          </View>
        </ScrollView>
      </View>
    </View>
  );
}
