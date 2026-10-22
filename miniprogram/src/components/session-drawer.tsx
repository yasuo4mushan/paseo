/**
 * 会话展开栏（t20）：对话主页右侧抽屉——全部会话列表（筛选：进行中/需注意/归档）、
 * 当前会话高亮、新建会话入口。Paseo session rail 的移动版；数据源是
 * session-store（与主页同一份），不再有独立的列表页逻辑。
 *
 * 交互：遮罩/收起按钮关闭；条目点击切换活跃会话；长按弹动作面板
 * （详情管理 / 归档|恢复 / 删除）。
 */

import { useState } from "react";
import Taro from "@tarojs/taro";
import { Image, ScrollView, View } from "@tarojs/components";
import { sessionStore } from "@/stores/session-store";
import { attentionStore } from "@/stores/attention-store";
import { AGENT_FILTER_LABELS, displayLabels, type AgentListFilter } from "@/utils/agent-directory";
import { STATUS_LABELS, statusPillClass } from "@/constants/status";
import { iconUrl, providerIconUrl } from "@/utils/icons";
import type { AgentSnapshot } from "@/connection/protocol-types";
import { useThemeClass } from "@/hooks/use-theme";
import { safeNavigateTo } from "@/utils/navigation";
import "./session-drawer.css";

export function SessionDrawer({
  visible,
  onClose,
  onSelect,
  onArchive,
  onDelete,
  onNewChat,
}: {
  visible: boolean;
  onClose: () => void;
  onSelect: (agentId: string) => void;
  /** 长按动作：归档/恢复（isArchived 语义由页面处理确认弹窗与 RPC）。 */
  onArchive: (agentId: string, currentlyArchived: boolean) => void;
  /** 长按动作：删除（页面处理确认弹窗与 RPC）。 */
  onDelete: (agentId: string) => void;
  /** 新建会话：点按 = 豆包式快捷新对话（清活跃会话回欢迎态，composer 四 pill
   *  选好后发送即创建）；长按 = 高级创建表单（导入已有会话/worktree）。 */
  onNewChat: () => void;
}) {
  const themeClass = useThemeClass();
  const [filter, setFilter] = useState<AgentListFilter>("active");

  if (!visible) return null;
  const state = sessionStore.getSnapshot();
  const agents = sessionStore.directory(filter);
  const attentionCount = state.agents.filter(
    (a) => !a.archivedAt && (a.requiresAttention || attentionStore.has(a.id)),
  ).length;

  const rowActions = async (agent: AgentSnapshot) => {
    const actions = [agent.archivedAt ? "恢复会话" : "归档会话", "详情管理", "删除会话"];
    try {
      const { tapIndex } = await Taro.showActionSheet({ itemList: actions });
      if (tapIndex === 2) {
        onDelete(agent.id);
        return;
      }
      if (tapIndex === 0) {
        onArchive(agent.id, Boolean(agent.archivedAt));
        return;
      }
      void safeNavigateTo(`/pages/agent/index?id=${encodeURIComponent(agent.id)}`);
    } catch {
      // 用户取消
    }
  };

  return (
    <View className={`sd-mask ${themeClass}`} onClick={onClose} catchMove>
      <View className="sd-panel" onClick={(e) => e.stopPropagation()}>
        <View className="sd-head">
          <View className="sd-title">全部会话</View>
          <View className="sd-close" onClick={onClose}>
            <Image className="icon" src={iconUrl("close")} />
          </View>
        </View>

        <View
          className="sd-new"
          onClick={() => {
            onNewChat();
            onClose();
          }}
          onLongPress={() => void safeNavigateTo("/pages/create/index")}
        >
          <Image className="icon" src={iconUrl("plus", "-active")} />
          <View className="sd-main-col">
            <View className="sd-new-text">新建会话</View>
            <View className="sd-new-sub">点按快捷新对话 · 长按高级表单（导入/worktree）</View>
          </View>
        </View>

        <View className="sd-filters">
          {(Object.keys(AGENT_FILTER_LABELS) as AgentListFilter[]).map((key) => (
            <View
              key={key}
              className={`sd-chip ${filter === key ? "sd-chip-active" : ""}`}
              onClick={() => setFilter(key)}
            >
              {AGENT_FILTER_LABELS[key]}
              {key === "attention" && attentionCount > 0 ? ` ${attentionCount}` : ""}
            </View>
          ))}
        </View>

        <ScrollView className="sd-list" scrollY enhanced showScrollbar={false}>
          {agents.length === 0 ? (
            <View className="sd-empty">
              <Image className="icon icon-lg" src={iconUrl("chat")} />
              <View className="sd-empty-text">
                {filter === "archived" ? "没有归档的会话" : "还没有会话，新建一个开始对话"}
              </View>
            </View>
          ) : (
            agents.map((agent) => {
              const active = agent.id === state.activeId;
              const labels = displayLabels(agent.labels);
              const highlighted = attentionStore.has(agent.id) || agent.requiresAttention;
              return (
                <View
                  key={agent.id}
                  className={`sd-row ${active ? "sd-row-active" : ""}`}
                  onClick={() => {
                    onSelect(agent.id);
                    onClose();
                  }}
                  onLongPress={() => void rowActions(agent)}
                >
                  <Image className="icon" src={providerIconUrl(agent.provider)} />
                  <View className="sd-main">
                    <View className="sd-name-row">
                      <View className="sd-name">{agent.title ?? agent.id.slice(0, 8)}</View>
                      {highlighted ? <View className="sd-dot" /> : null}
                    </View>
                    <View className="sd-sub">
                      {agent.provider}
                      {agent.model ? ` · ${agent.model}` : ""}
                    </View>
                    {labels.length > 0 ? (
                      <View className="sd-labels">{labels.slice(0, 2).join(" · ")}</View>
                    ) : null}
                  </View>
                  <View className={agent.archivedAt ? "pill pill-idle" : statusPillClass(agent.status)}>
                    {agent.archivedAt ? "已归档" : (STATUS_LABELS[agent.status] ?? agent.status)}
                  </View>
                </View>
              );
            })
          )}
        </ScrollView>
      </View>
    </View>
  );
}
