/**
 * agent 目录列表纯函数（t18）：筛选（进行中/全部/需注意/归档）与标签展示。
 *
 * 归档判定：snapshot.archivedAt 非空（fetch_agents 带 filter.includeArchived 时返回）。
 * 标签展示：paseo.* 前缀是内部标签（agent-labels.ts 的 PARENT_AGENT_ID_LABEL 等），不展示。
 */

import type { AgentSnapshot } from "@/connection/protocol-types";

export type AgentListFilter = "active" | "all" | "attention" | "archived";

export const AGENT_FILTER_LABELS: Record<AgentListFilter, string> = {
  active: "进行中",
  all: "全部",
  attention: "需注意",
  archived: "归档",
};

export function filterAgents(agents: AgentSnapshot[], filter: AgentListFilter): AgentSnapshot[] {
  switch (filter) {
    case "archived":
      return agents.filter((a) => a.archivedAt != null);
    case "attention":
      return agents.filter((a) => !a.archivedAt && a.requiresAttention);
    case "all":
      return agents;
    case "active":
    default:
      return agents.filter((a) => !a.archivedAt);
  }
}

/** 排序：需注意 > 运行中 > 其他 > 归档；组内按 updatedAt 降序。 */
const STATUS_ORDER: Record<string, number> = {
  running: 0,
  initializing: 1,
  idle: 2,
  error: 3,
  closed: 4,
};

export function sortAgents(agents: AgentSnapshot[]): AgentSnapshot[] {
  return [...agents].sort((a, b) => {
    const aArchived = a.archivedAt != null ? 1 : 0;
    const bArchived = b.archivedAt != null ? 1 : 0;
    if (aArchived !== bArchived) return aArchived - bArchived;
    const aAttention = a.requiresAttention ? 0 : 1;
    const bAttention = b.requiresAttention ? 0 : 1;
    if (aAttention !== bAttention) return aAttention - bAttention;
    const rankDiff = (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9);
    if (rankDiff !== 0) return rankDiff;
    return b.updatedAt.localeCompare(a.updatedAt);
  });
}

/** 展示标签：内部 paseo.* 键不展示，其余按键名展示（app/CLI 同款 key=value 记录）。 */
export function displayLabels(labels?: Record<string, string>): string[] {
  if (!labels) return [];
  return Object.keys(labels)
    .filter((key) => !key.startsWith("paseo.") && key.length > 0)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * 标签写回：保留内部 paseo.* 键原值；展示标签以 { [label]: "true" } 记录
 * （app open-agent-tab 同款形状，CLI key=value 亦兼容）。
 */
export function setDisplayLabels(
  labels: Record<string, string> | undefined,
  display: string[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(labels ?? {})) {
    if (key.startsWith("paseo.")) next[key] = value;
  }
  for (const label of display) {
    const trimmed = label.trim();
    if (trimmed) next[trimmed] = "true";
  }
  return next;
}
