/**
 * 权限请求的展示摘要（纯函数，t16 单测覆盖）。
 *
 * daemon 推送的 input 是工具原始参数（Record<string, unknown>），直接
 * JSON.stringify 太吵：优先取常见字段（命令/路径/URL/描述），否则截断序列化。
 * 参照 app 端 permission sheet 的信息层级（标题 + 工具名 + 参数摘要）。
 */

import type { PermissionRequest } from "@/connection/protocol-types";

const PREFERRED_KEYS = [
  "command",
  "cmd",
  "description",
  "file_path",
  "filePath",
  "path",
  "pattern",
  "url",
  "script",
  "query",
] as const;

const MAX_VALUE_LENGTH = 160;
const MAX_FALLBACK_LENGTH = 240;

const KIND_LABELS: Record<PermissionRequest["kind"], string> = {
  tool: "工具授权",
  plan: "计划确认",
  question: "问题确认",
  mode: "模式切换",
  other: "权限请求",
};

export function permissionKindLabel(kind: PermissionRequest["kind"]): string {
  return KIND_LABELS[kind] ?? KIND_LABELS.other;
}

export function permissionTitle(request: PermissionRequest): string {
  if (request.title) return request.title;
  if (request.name) return request.name;
  return permissionKindLabel(request.kind);
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

export function summarizePermissionInput(input: Record<string, unknown> | undefined): string {
  if (!input) return "";
  for (const key of PREFERRED_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return truncate(value, MAX_VALUE_LENGTH);
    if (Array.isArray(value) && value.length > 0) {
      const joined = value.map((v) => (typeof v === "string" ? v : JSON.stringify(v))).join(" ");
      if (joined.trim()) return truncate(joined, MAX_VALUE_LENGTH);
    }
  }
  const keys = Object.keys(input);
  if (keys.length === 0) return "";
  try {
    return truncate(JSON.stringify(input), MAX_FALLBACK_LENGTH);
  } catch {
    return "";
  }
}
