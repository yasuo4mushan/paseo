/**
 * 设备侧文件夹路径工具（t24，纯函数，单测覆盖）。
 *
 * folder-picker 的导航模型：daemon 侧 file_explorer_request 以任意绝对路径为
 * root（服务器 expandUserPath 支持 "~"），path 只能在 root 内。这里固定
 * root="/"，用 trail（相对 "/" 的段数组）描述当前位置：
 *   - 初始 browse("/", "~") → daemon 返回归一化 path（如 "Users/xxx"），
 *     trailFromDaemonPath 还原出段数组 → 面包屑 / Users / xxx。
 *   - 进入子目录 push 段；返回 pop 段；面包屑回点截断到该段。
 *   - 确认选择时 absolutePath(trail) 拼回绝对路径（open_project / agent cwd 用）。
 */

/** daemon 归一化路径（相对 "/"，"."=根）→ trail 段数组。 */
export function trailFromDaemonPath(normalized: string): string[] {
  const trimmed = normalized.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return [];
  return trimmed.split("/").filter((segment) => segment.length > 0);
}

/** trail 段数组 → 相对 "/" 的路径（file_explorer path 参数用；空 = "."）。 */
export function relativeTrailPath(trail: string[]): string {
  const joined = trail.join("/");
  return joined || ".";
}

/** trail 段数组 → 绝对路径（确认选择 / open_project 用；空 trail = 根）。 */
export function absoluteTrailPath(trail: string[], rootLabel = "/"): string {
  const base = rootLabel === "~" ? "~" : "/";
  return trail.length === 0 ? base : `${base}/${trail.join("/")}`.replace(/^\/\//, "/");
}

/** 面包屑展示段：根固定（"/" 或 "~"），其余按段。 */
export function breadcrumbSegments(
  trail: string[],
  rootLabel = "/",
): Array<{ label: string; depth: number }> {
  return [
    { label: rootLabel, depth: 0 },
    ...trail.map((segment, index) => ({ label: segment, depth: index + 1 })),
  ];
}

/** 返回上一级（根不不能再上）。 */
export function parentTrail(trail: string[]): string[] {
  return trail.slice(0, -1);
}

/** 进入子目录。 */
export function childTrail(trail: string[], name: string): string[] {
  return [...trail, name];
}

/** 面包屑回点到第 depth 层（0 = 根）。 */
export function trailToDepth(trail: string[], depth: number): string[] {
  if (depth < 0) return [];
  return trail.slice(0, Math.min(depth, trail.length));
}

/** 当前文件夹名（根 = 根标签）。 */
export function trailName(trail: string[], rootLabel = "/"): string {
  return trail[trail.length - 1] ?? rootLabel;
}

/**
 * 新建文件夹名校验（daemon 侧 fs.entry.create 也会校验 invalid_name；
 * 这里先拦常见非法输入，给即时反馈）。
 */
export function validateFolderName(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return "文件夹名不能为空";
  if (trimmed.includes("/")) return "名称不能包含 /";
  if (trimmed === "." || trimmed === "..") return "名称不能是 . 或 ..";
  if (trimmed.length > 60) return "名称过长（≤60 字符）";
  return null;
}

/**
 * 相对路径 → 目录栈（t31 文件面板/files 页共用）。
 * daemon file_explorer 的子目录 path 是相对 cwd 的归一化路径（"src/lib"）；
 * 目录栈每层存"到该层的累计路径"（["src", "src/lib"]），面包屑/返回上级直接
 * pop 一步即回上层，不必重算累计前缀。根（""/"."/"/"）→ 空栈。
 */
export function dirStackFromPath(path: string): string[] {
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  const stack: string[] = [];
  for (const segment of segments) {
    stack.push(stack.length > 0 ? `${stack[stack.length - 1]}/${segment}` : segment);
  }
  return stack;
}

/** 相对路径的父目录（根 → "."）：文件条目跳预览时定位其所在目录用。 */
export function parentDirPath(path: string): string {
  const segments = path.split("/").filter((segment) => segment.length > 0 && segment !== ".");
  if (segments.length <= 1) return ".";
  return segments.slice(0, -1).join("/");
}
