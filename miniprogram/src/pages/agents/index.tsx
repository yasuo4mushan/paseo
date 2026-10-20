import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { AgentSnapshot } from "@/connection/protocol-types";
import { STATUS_LABELS } from "@/constants/status";
import "./index.css";

function agentSubtitle(agent: AgentSnapshot): string {
  const parts = [agent.provider, agent.model ?? ""].filter(Boolean);
  const updated = agent.updatedAt ? agent.updatedAt.slice(5, 16).replace("T", " ") : "";
  return updated ? `${parts.join(" · ")} · ${updated}` : parts.join(" · ");
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
          <View className="empty-title">
            {state.status === "error" ? `连接失败：${state.message}` : "未连接"}
          </View>
          <Button
            className="button"
            onClick={() =>
              connectionManager
                .connect()
                .catch(() => Taro.showToast({ title: "重连失败", icon: "none" }))
            }
          >
            重新连接
          </Button>
          <Button
            className="button button-secondary retry-btn"
            onClick={() => Taro.navigateTo({ url: "/pages/pair/index" })}
          >
            重新配对
          </Button>
        </View>
      </View>
    );
  }

  return (
    <View className="page">
      {error ? <View className="card error-card">{error}</View> : null}
      {agents.length === 0 ? (
        <View className="card empty">
          <View className="empty-title">暂无 Agent</View>
          <View className="muted">在你的开发机上创建 agent 后，下拉刷新即可看到。</View>
        </View>
      ) : (
        agents.map((agent) => (
          <View key={agent.id} className="card agent-row" onClick={() => openAgent(agent.id)}>
            <View className="agent-main">
              <View className="agent-title">{agent.title ?? agent.id.slice(0, 8)}</View>
              <View className="muted agent-sub">{agentSubtitle(agent)}</View>
            </View>
            <View className={`badge badge-${agent.status}`}>
              {STATUS_LABELS[agent.status] ?? agent.status}
            </View>
          </View>
        ))
      )}
    </View>
  );
}
