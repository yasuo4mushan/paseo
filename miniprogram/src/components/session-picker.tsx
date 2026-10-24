/**
 * 会话选择顶部弹窗（t21，t20 会话抽屉的交互语言迁移）：全部会话列表
 * （筛选：进行中/需注意/归档）、当前会话高亮、新建/导入会话入口（t31 显性化）。
 * 数据/筛选逻辑沿用 session-store（与主页同一份），不再有独立的列表页逻辑。
 *
 * 交互：遮罩/收起按钮关闭；条目点击切换活跃会话；长按弹动作面板
 * （详情管理 / 归档|恢复 / 删除）；底部 [新建会话][导入已有会话] 并排——
 * 新建点按 = 豆包式快捷新对话（清活跃会话回欢迎态），长按 = 高级创建表单
 * （worktree 等）；导入 = 跳创建页导入 tab（provider 历史会话发现，t18）。
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
import { TopSheet } from "@/components/top-sheet";
import { safeNavigateTo } from "@/utils/navigation";
import "./session-picker.css";

export function SessionPickerSheet({
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
  const [filter, setFilter] = useState<AgentListFilter>("active");

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
    <TopSheet
      visible={visible}
      title="全部会话"
      onClose={onClose}
      footer={
        <View className="sp-footer-row">
          <View
            className="sp-new"
            onClick={() => {
              onNewChat();
              onClose();
            }}
            onLongPress={() => {
              onClose();
              void safeNavigateTo("/pages/create/index");
            }}
          >
            <Image className="icon icon-sm" src={iconUrl("plus", "-active")} />
            <View className="sp-new-text">新建会话</View>
          </View>
          <View
            className="sp-import"
            onClick={() => {
              onClose();
              void safeNavigateTo("/pages/create/index?tab=import");
            }}
          >
            <Image className="icon icon-sm" src={iconUrl("import")} />
            <View className="sp-import-text">导入已有会话</View>
          </View>
        </View>
      }
    >
      <View className="sp-filters">
        {(Object.keys(AGENT_FILTER_LABELS) as AgentListFilter[]).map((key) => (
          <View
            key={key}
            className={`sp-chip ${filter === key ? "sp-chip-active" : ""}`}
            onClick={() => setFilter(key)}
          >
            {AGENT_FILTER_LABELS[key]}
            {key === "attention" && attentionCount > 0 ? ` ${attentionCount}` : ""}
          </View>
        ))}
      </View>

      <ScrollView className="sp-list" scrollY enhanced showScrollbar={false}>
        {agents.length === 0 ? (
          <View className="sp-empty">
            <Image className="icon icon-lg" src={iconUrl("chat")} />
            <View className="sp-empty-text">
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
                className={`sp-row ${active ? "sp-row-active" : ""}`}
                onClick={() => {
                  onSelect(agent.id);
                  onClose();
                }}
                onLongPress={() => void rowActions(agent)}
              >
                <Image className="icon" src={providerIconUrl(agent.provider)} />
                <View className="sp-main">
                  <View className="sp-name-row">
                    <View className="sp-name">{agent.title ?? agent.id.slice(0, 8)}</View>
                    {highlighted ? <View className="sp-dot" /> : null}
                  </View>
                  <View className="sp-sub">
                    {agent.provider}
                    {agent.model ? ` · ${agent.model}` : ""}
                  </View>
                  {labels.length > 0 ? (
                    <View className="sp-labels">{labels.slice(0, 2).join(" · ")}</View>
                  ) : null}
                </View>
                <View
                  className={agent.archivedAt ? "pill pill-idle" : statusPillClass(agent.status)}
                >
                  {agent.archivedAt ? "已归档" : (STATUS_LABELS[agent.status] ?? agent.status)}
                </View>
              </View>
            );
          })
        )}
      </ScrollView>
    </TopSheet>
  );
}
