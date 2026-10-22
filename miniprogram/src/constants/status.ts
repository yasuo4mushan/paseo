import type { AgentLifecycleStatus } from "@/connection/protocol-types";

/** agent 状态的中文标签（术语以 UI 为准）。 */
export const STATUS_LABELS: Record<AgentLifecycleStatus | string, string> = {
  initializing: "初始化",
  idle: "空闲",
  running: "运行中",
  error: "错误",
  closed: "已关闭",
};

/** agent 状态 → 胶囊样式（pill-* 定义在 app.css tokens 体系里）。 */
export function statusPillClass(status: AgentLifecycleStatus | string): string {
  switch (status) {
    case "running":
      return "pill pill-running";
    case "error":
      return "pill pill-error";
    case "initializing":
      return "pill pill-warn";
    default:
      return "pill";
  }
}
