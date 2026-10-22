/**
 * 定时任务表单工具（t18）：cadence 预设 / cron 校验 / 展示文案。
 *
 * cron 语法 vendor 自 packages/protocol/src/schedule/cron-expression.ts（5 字段子集：
 * 分 时 日 月 周；支持 * / -, 数字）。客户端提前校验，daemon 侧同规则兜底。
 */

import type { ScheduleCadence, ScheduleRun, ScheduleSummary } from "@/connection/protocol-types";

export interface CadencePreset {
  id: string;
  label: string;
  expression: string;
}

export const CUSTOM_CRON_PRESET_ID = "custom";

/** 与 app schedule-cadence-options.ts 同款预设（labels 中文化）。 */
export const CADENCE_PRESETS: CadencePreset[] = [
  { id: "every-minute", label: "每分钟", expression: "* * * * *" },
  { id: "every-hour", label: "每小时", expression: "0 * * * *" },
  { id: "daily-9", label: "每天 9:00", expression: "0 9 * * *" },
  { id: "weekdays-9", label: "工作日 9:00", expression: "0 9 * * 1-5" },
  { id: "mondays-9", label: "每周一 9:00", expression: "0 9 * * 1" },
];

interface CronFieldBounds {
  min: number;
  max: number;
  name: string;
}

const CRON_FIELD_BOUNDS: CronFieldBounds[] = [
  { min: 0, max: 59, name: "分钟" },
  { min: 0, max: 23, name: "小时" },
  { min: 1, max: 31, name: "日" },
  { min: 1, max: 12, name: "月" },
  { min: 0, max: 6, name: "星期" },
];

function parseCronField(source: string, bounds: CronFieldBounds): string | null {
  const trimmed = source.trim();
  if (!trimmed) return `${bounds.name}字段为空`;

  const allowed = new Set<number>();
  for (const rawPart of trimmed.split(",")) {
    const part = rawPart.trim();
    if (!part) return `${bounds.name}字段含空片段`;

    // 步长 step
    const stepParts = part.split("/");
    if (stepParts.length > 2) return `${bounds.name}步长格式错误`;
    const [base, stepSource] = stepParts;
    const step = stepSource === undefined ? 1 : Number.parseInt(stepSource, 10);
    if (!Number.isInteger(step) || step <= 0 || (stepSource !== undefined && String(step) !== stepSource.trim())) {
      return `${bounds.name}步长格式错误`;
    }

    if (base === "*") {
      for (let v = bounds.min; v <= bounds.max; v += step) allowed.add(v);
      continue;
    }
    const rangeMatch = base.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start > end || start < bounds.min || end > bounds.max) {
        return `${bounds.name}范围越界`;
      }
      for (let v = start; v <= end; v += step) allowed.add(v);
      continue;
    }
    if (!/^\d+$/.test(base)) return `${bounds.name}字段含非法字符`;
    const value = Number.parseInt(base, 10);
    if (value < bounds.min || value > bounds.max) return `${bounds.name}数值越界`;
    allowed.add(value);
  }
  return null;
}

/** 5 字段 cron 校验；合法返回 null，非法返回中文错误。 */
export function validateCronExpression(expression: string): string | null {
  const parts = expression.trim().split(/\s+/);
  if (parts.length !== 5) return "cron 表达式需为 5 字段（分 时 日 月 周）";
  for (let i = 0; i < 5; i += 1) {
    const error = parseCronField(parts[i], CRON_FIELD_BOUNDS[i]);
    if (error) return error;
  }
  return null;
}

/** cadence 展示文案：预设名 / 自定义 cron / every 间隔。 */
export function cadenceLabel(cadence: ScheduleCadence): string {
  if (cadence.type === "every") {
    const minutes = Math.round(cadence.everyMs / 60000);
    if (minutes >= 60) {
      const hours = Math.round(minutes / 60);
      return `每 ${hours} 小时`;
    }
    return minutes <= 1 ? "每分钟" : `每 ${minutes} 分钟`;
  }
  const preset = CADENCE_PRESETS.find(
    (option) => option.expression === cadence.expression.trim(),
  );
  return preset ? preset.label : `cron ${cadence.expression}`;
}

export function scheduleStatusText(status: ScheduleSummary["status"]): string {
  if (status === "active") return "运行中";
  if (status === "paused") return "已暂停";
  return "已完成";
}

export function scheduleRunStatusText(status: ScheduleRun["status"]): string {
  if (status === "running") return "执行中";
  if (status === "failed") return "失败";
  return "成功";
}

/** prompt 单行预览（列表卡片用）。 */
export function promptPreview(prompt: string, max = 60): string {
  const single = prompt.replace(/\s+/g, " ").trim();
  return single.length > max ? `${single.slice(0, max)}…` : single;
}
