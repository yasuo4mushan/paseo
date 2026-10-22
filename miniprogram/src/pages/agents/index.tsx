import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentSnapshot } from "@/connection/protocol-types";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import "./index.css";

function agentSubtitle(agent: AgentSnapshot): string {
  const parts = [agent.provider, agent.model ?? ""].filter(Boolean);
  return parts.join(" · ");
}

export default function AgentsPage() {
  const state = useSyncExternalStore(
    (cb) => connectionManager.subscribe(cb),
    () => connectionManager.getState(),
  );
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [error, setError] = useState("");

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
      </View>
    );
  }

  return (
    <View className="page agents-page">
      {error ? <View className="error-inline">{error}</View> : null}
      {agents.length === 0 ? (
        <View className="card empty">
          <View className="empty-icon">🤖</View>
          <View className="empty-title">暂无 Agent</View>
          <View className="empty-desc">在你的开发机上创建 agent 后，下拉刷新即可看到。</View>
        </View>
      ) : (
        agents.map((agent) => (
          <View
            key={agent.id}
            className="card agent-card"
            onClick={() => openAgent(agent.id)}
          >
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
    </View>
  );
}
