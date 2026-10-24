/**
 * 新建工作区页纯函数（t31-b，单测覆盖）：
 * - repo 输入归一（t18 原页内函数，提取为纯模块便于测试）。
 * - 点选 + 高级手输 → 生效目录（手输优先）；目录路径校验与展示名。
 */

export interface DirectoryPick {
  path: string;
  name: string;
}

/** repo 输入归一：owner/name 或 https://github.com/owner/name.git → owner/name。 */
export function normalizeRepoInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed;
  const urlMatch = trimmed.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

/**
 * 点选结果 + 高级手输 → 实际生效目录。展开高级且有输入时以手输为准，
 * 否则用点选结果；两者皆空返回空串（= 尚未选择）。
 */
export function effectiveDirectoryPath(pick: DirectoryPick | null, manual: string): string {
  const typed = manual.trim();
  if (typed) return typed;
  return pick?.path ?? "";
}

/** 注册/clone 目标目录校验：绝对路径（POSIX "/" 或 daemon 可展开的 "~" 前缀）。 */
export function directoryPathError(path: string, emptyMessage: string): string | null {
  if (!path) return emptyMessage;
  if (!(path.startsWith("/") || path.startsWith("~"))) {
    return "路径应为设备上的绝对路径（以 / 或 ~ 开头）";
  }
  return null;
}

/** 选中目录展示名（名称缺失时兜底取路径末段；根路径原样返回）。 */
export function directoryDisplayName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return path;
  const last = trimmed.split("/").filter(Boolean).pop();
  return last ?? trimmed;
}
