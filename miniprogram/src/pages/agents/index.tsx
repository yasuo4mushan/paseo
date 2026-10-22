import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentSnapshot, WorkspaceDescriptor } from "@/connection/protocol-types";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { PermissionOverlay } from "@/components/permission-overlay";
import { WorkspacePicker } from "@/components/workspace-picker";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import "./index.css";

function agentSubtitle(agent: AgentSnapshot): string {
  const parts = [agent.provider, agent.model ?? ""].filter(Boolean);
  return parts.join(" · ");
}

/** 订阅工作区选择（同 permission-overlay：不用 useSyncExternalStore，见该文件注释）。 */
function useWorkspaceSelection(): WorkspaceSelection | null {
  const [selection, setSelection] = useState<WorkspaceSelection | null>(() =>
    workspaceStore.getSnapshot(),
  );
  useEffect(() => workspaceStore.subscribe(() => setSelection(workspaceStore.getSnapshot())), []);
  return selection;
}

export default function AgentsPage() {
  const state = useSyncExternalStore(
    (cb) => connectionManager.subscribe(cb),
    () => connectionManager.getState(),
  );
  const workspace = useWorkspaceSelection();
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [error, setError] = useState("");
  const [pickerVisible, setPickerVisible] = useState(false);

  const refresh = useCallback(async () => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    try {
      setAgents(await conn.fetchAgents());
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    workspaceStore.restore();
    void refresh();
    return connectionManager.onAgentUpdate((update) => {
      if (update.kind === "remove") {
        setAgents((prev) => prev.filter((a) => a.id !== update.agentId));
        return;
      }
      setAgents((prev) => {
        const next = prev.filter((a) => a.id !== update.agent.id);
        next.unshift(update.agent);
        return next;
      });
    });
  }, [refresh, state.status]);

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const openAgent = (id: string) => {
    Taro.navigateTo({ url: `/pages/agent/index?id=${encodeURIComponent(id)}` });
  };

  const onWorkspaceSelected = (ws: WorkspaceDescriptor) => {
    workspaceStore.select(ws);
  };

  if (state.status === "disconnected" || state.status === "error") {
    return (
      <View className="page">
        <View className="card empty">
          <View className="empty-icon">{state.status === "error" ? "⚠️" : "📡"}</View>
          <View className="empty-title">
            {state.status === "error" ? "连接中断" : "未连接设备"}
          </View>
          <View className="empty-desc">
            {state.status === "error" ? state.message : "先从设备列表选择一台在线设备连接。"}
          </View>
          <Button
            className="btn btn-mini"
            onClick={() => Taro.switchTab({ url: "/pages/devices/index" })}
          >
            去设备页
          </Button>
        </View>
        <PermissionOverlay />
      </View>
    );
  }

  return (
    <View className="page agents-page">
      {error ? <View className="error-inline">{error}</View> : null}
      <View className="ws-bar">
        <View className="ws-bar-main" onClick={() => setPickerVisible(true)}>
          <View className="ws-bar-label">工作区</View>
          <View className="ws-bar-value">{workspace?.label ?? "选择工作区"}</View>
          <View className="ws-bar-arrow">▾</View>
        </View>
        <View
          className="files-entry"
          onClick={() => Taro.navigateTo({ url: "/pages/files/index" })}
        >
          <View className="files-entry-icon">📂</View>
          <View className="files-entry-text">文件</View>
        </View>
        <View
          className="create-entry"
          onClick={() => Taro.navigateTo({ url: "/pages/create/index" })}
        >
          <View className="create-entry-icon">＋</View>
          <View className="create-entry-text">新建</View>
        </View>
      </View>
      {agents.length === 0 ? (
        <View className="card empty">
          <View className="empty-icon">🤖</View>
          <View className="empty-title">暂无 Agent</View>
          <View className="empty-desc">点右上角"新建"在此设备上创建 agent。</View>
        </View>
      ) : (
        agents.map((agent) => (
          <View key={agent.id} className="card agent-card" onClick={() => openAgent(agent.id)}>
            <View className="agent-avatar">{agent.provider.slice(0, 1).toUpperCase()}</View>
            <View className="agent-main">
              <View className="agent-title-row">
                <View className="agent-title">{agent.title ?? agent.id.slice(0, 8)}</View>
                {agent.requiresAttention ? <View className="attention-dot" /> : null}
              </View>
              <View className="muted agent-sub">{agentSubtitle(agent)}</View>
            </View>
            <View className={statusPillClass(agent.status)}>
              {STATUS_LABELS[agent.status] ?? agent.status}
            </View>
          </View>
        ))
      )}
      <WorkspacePicker
        visible={pickerVisible}
        selectedId={workspace?.workspaceId ?? null}
        onClose={() => setPickerVisible(false)}
        onSelect={onWorkspaceSelected}
      />
      <PermissionOverlay />
    </View>
  );
}
