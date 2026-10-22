/**
 * 创建 Agent 表单校验（纯函数，t16 单测覆盖）。
 */

import type { ProviderAvailability } from "@/connection/protocol-types";
import type { WorkspaceSelection } from "@/stores/workspace-store";

export interface CreateFormValues {
  workspace: WorkspaceSelection | null;
  provider: string;
  prompt: string;
}

export interface CreateFormErrors {
  workspace?: string;
  provider?: string;
  prompt?: string;
}

export function validateCreateForm(values: CreateFormValues): CreateFormErrors {
  const errors: CreateFormErrors = {};
  if (!values.workspace) {
    errors.workspace = "先选择一个项目/工作区";
  }
  if (!values.provider) {
    errors.provider = "选择一个可用的 agent provider";
  }
  const prompt = values.prompt.trim();
  if (!prompt) {
    errors.prompt = "给 agent 下达第一条任务指令";
  } else if (prompt.length > 4000) {
    errors.prompt = "任务描述过长（≤4000 字）";
  }
  return errors;
}

export function hasErrors(errors: CreateFormErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** provider 是否可选：目录不可用时禁用并提示原因。 */
export function providerDisabledReason(availability: ProviderAvailability): string | null {
  if (availability.available) return null;
  return availability.error ? `不可用：${availability.error}` : "不可用";
}
