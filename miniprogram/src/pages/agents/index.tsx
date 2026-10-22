import { useCallback, useEffect, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Button, Image, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentSnapshot, WorkspaceDescriptor } from "@/connection/protocol-types";
import { attentionStore } from "@/stores/attention-store";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { PermissionOverlay } from "@/components/permission-overlay";
import { WorkspacePicker } from "@/components/workspace-picker";
import { useThemeClass } from "@/hooks/use-theme";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { iconUrl, providerIconUrl } from "@/utils/icons";
import { safeNavigateTo, safeSwitchTab } from "@/utils/navigation";
import {
  AGENT_FILTER_LABELS,
  displayLabels,
  filterAgents,
  sortAgents,
  type AgentListFilter,
} from "@/utils/agent-directory";
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

/** manager 状态订阅（t18 起弃用 useSyncExternalStore，统一 useState+useEffect）。 */
function useConnectionState() {
  const [state, setState] = useState(() => connectionManager.getState());
  useEffect(() => connectionManager.subscribe(() => setState(connectionManager.getState())), []);
  return state;
}

/** attention 红点集合订阅（t18：推送到达 → 列表高亮）。 */
function useAttentionIds(): Set<string> {
  const [ids, setIds] = useState<Set<string>>(
    () => new Set(attentionStore.getSnapshot().map((e) => e.agentId)),
  );
  useEffect(
    () =>
      attentionStore.subscribe(() => {
        setIds(new Set(attentionStore.getSnapshot().map((e) => e.agentId)));
      }),
    [],
  );
  return ids;
}

export default function AgentsPage() {
  const themeClass = useThemeClass();
  const state = useConnectionState();
  const workspace = useWorkspaceSelection();
  const attentionIds = useAttentionIds();
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [filter, setFilter] = useState<AgentListFilter>("active");
  const [error, setError] = useState("");
  const [pickerVisible, setPickerVisible] = useState(false);

  const refresh = useCallback(async () => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    try {
      // t18：一次拉全（含归档），筛选在端上做（进行中/全部/需注意/归档）。
      setAgents(await conn.fetchAgents({ includeArchived: true }));
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

  // t18：从详情页返回时重拉（归档/标签/attention 改动兜底；推送订阅为主、拉取为辅）。
  useDidShow(() => {
    if (connectionManager.getState().status === "connected") void refresh();
  });

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const openAgent = (id: string) => {
    // 打开详情即视为已关注：本地清红点 + fire-and-forget RPC（官方 clear_agent_attention）。
    attentionStore.clear([id]);
    connectionManager
      .getConnection()
      ?.clearAgentAttention([id])
      .catch(() => {});
    void safeNavigateTo(`/pages/agent/index?id=${encodeURIComponent(id)}`);
  };

  const onWorkspaceSelected = (ws: WorkspaceDescriptor) => {
    workspaceStore.select(ws);
  };

  const visibleAgents = sortAgents(filterAgents(agents, filter));
  const attentionCount = agents.filter(
    (a) => !a.archivedAt && (a.requiresAttention || attentionIds.has(a.id)),
  ).length;

  if (state.status === "disconnected" || state.status === "error") {
    return (
      <View className={`page ${themeClass}`}>
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl(state.status === "error" ? "warning" : "devices")} />
          <View className="empty-title">
            {state.status === "error" ? "连接中断" : "未连接设备"}
          </View>
          <View className="empty-desc">
            {state.status === "error" ? state.message : "先从设备列表选择一台在线设备连接。"}
          </View>
          <Button
            className="btn btn-mini"
            onClick={() => void safeSwitchTab("/pages/devices/index")}
          >
            去设备页
          </Button>
        </View>
        <PermissionOverlay />
      </View>
    );
  }

  return (
    <View className={`page agents-page ${themeClass}`}>
      {error ? <View className="error-inline">{error}</View> : null}
      <View className="ws-bar">
        <View className="ws-bar-main" onClick={() => setPickerVisible(true)}>
          <View className="ws-bar-label">工作区</View>
          <View className="ws-bar-value">{workspace?.label ?? "选择工作区"}</View>
          <Image className="icon icon-sm" src={iconUrl("chevron-down")} />
        </View>
        <View className="tool-entry" onClick={() => void safeNavigateTo("/pages/files/index")}>
          <Image className="icon" src={iconUrl("file")} />
          <View className="tool-entry-text">文件</View>
        </View>
        <View
          className="tool-entry"
          onClick={() => void safeNavigateTo("/pages/changes/index")}
        >
          <Image className="icon" src={iconUrl("diff")} />
          <View className="tool-entry-text">改动</View>
        </View>
        <View
          className="tool-entry"
          onClick={() => void safeNavigateTo("/pages/schedules/index")}
        >
          <Image className="icon" src={iconUrl("schedule")} />
          <View className="tool-entry-text">定时</View>
        </View>
        <View
          className="tool-entry"
          onClick={() => void safeNavigateTo("/pages/scripts/index")}
        >
          <Image className="icon" src={iconUrl("terminal")} />
          <View className="tool-entry-text">脚本</View>
        </View>
        <View
          className="create-entry"
          onClick={() => void safeNavigateTo("/pages/create/index")}
        >
          <Image className="icon" src={iconUrl("plus", "-active")} />
          <View className="create-entry-text">新建</View>
        </View>
      </View>

      <View className="filter-bar">
        {(Object.keys(AGENT_FILTER_LABELS) as AgentListFilter[]).map((key) => (
          <View
            key={key}
            className={`filter-chip ${filter === key ? "filter-chip-active" : ""}`}
            onClick={() => setFilter(key)}
          >
            {AGENT_FILTER_LABELS[key]}
            {key === "attention" && attentionCount > 0 ? (
              <View className="filter-badge">{attentionCount > 99 ? "99+" : attentionCount}</View>
            ) : null}
          </View>
        ))}
      </View>

      {visibleAgents.length === 0 ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("bot")} />
          <View className="empty-title">
            {filter === "archived" ? "没有归档的 Agent" : "暂无 Agent"}
          </View>
          <View className="empty-desc">
            {filter === "archived"
              ? "在会话详情里归档的 agent 会出现在这里。"
              : '点右上角"新建"在此设备上创建 agent。'}
          </View>
        </View>
      ) : (
        visibleAgents.map((agent) => {
          const labels = displayLabels(agent.labels);
          const highlighted = attentionIds.has(agent.id) || agent.requiresAttention;
          return (
            <View
              key={agent.id}
              className={`card agent-card ${highlighted ? "agent-card-attention" : ""}`}
              onClick={() => openAgent(agent.id)}
            >
              <Image className="agent-avatar" src={providerIconUrl(agent.provider)} />
              <View className="agent-main">
                <View className="agent-title-row">
                  <View className="agent-title">{agent.title ?? agent.id.slice(0, 8)}</View>
                  {highlighted ? <View className="attention-dot" /> : null}
                </View>
                <View className="muted agent-sub">{agentSubtitle(agent)}</View>
                {labels.length > 0 ? (
                  <View className="agent-labels">
                    {labels.slice(0, 3).map((label) => (
                      <View key={label} className="agent-label-chip">
                        {label}
                      </View>
                    ))}
                    {labels.length > 3 ? (
                      <View className="agent-label-chip">+{labels.length - 3}</View>
                    ) : null}
                  </View>
                ) : null}
              </View>
              <View className={agent.archivedAt ? "pill pill-idle" : statusPillClass(agent.status)}>
                {agent.archivedAt ? "已归档" : (STATUS_LABELS[agent.status] ?? agent.status)}
              </View>
            </View>
          );
        })
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
