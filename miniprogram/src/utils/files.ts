/**
 * 文件类型 / 展示工具（t17 文件浏览器与附件卡片共用）。
 * 平台无关纯 TS；wx API 调用留在页面层。
 */

const TEXT_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "json",
  "yaml",
  "yml",
  "toml",
  "ini",
  "cfg",
  "conf",
  "js",
  "jsx",
  "ts",
  "tsx",
  "mjs",
  "cjs",
  "css",
  "scss",
  "less",
  "html",
  "htm",
  "xml",
  "svg",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "c",
  "h",
  "cpp",
  "hpp",
  "cs",
  "php",
  "sh",
  "bash",
  "zsh",
  "fish",
  "sql",
  "graphql",
  "gql",
  "env",
  "gitignore",
  "dockerignore",
  "editorconfig",
  "lock",
  "log",
  "diff",
  "patch",
  "csv",
  "tsv",
  "tf",
  "hcl",
  "lua",
  "vim",
  "nix",
]);

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "ico"]);

const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx"]);

export type FileCategory = "text" | "image" | "document" | "archive" | "binary";

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 按扩展名粗分（预览方式选择；真实 mime 以 daemon 返回为准）。 */
export function fileCategory(name: string): FileCategory {
  const ext = fileExtension(name);
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (DOCUMENT_EXTENSIONS.has(ext)) return "document";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) return "archive";
  if (TEXT_EXTENSIONS.has(ext)) return "text";
  return "binary";
}

/** wx.openDocument 支持的 fileType。 */
export function documentFileType(name: string): string {
  return fileExtension(name);
}

const SIZE_UNITS = ["B", "KB", "MB", "GB"];

export function formatFileSize(size: number): string {
  if (!Number.isFinite(size) || size < 0) return "0 B";
  let value = size;
  let unit = 0;
  while (value >= 1024 && unit < SIZE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0
    ? `${value} B`
    : `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${SIZE_UNITS[unit]}`;
}

/**
 * 目录/文件列表的线条图标名（t20 去 emoji）：调用方用 iconUrl() 渲染 PNG。
 * 生成器见 scripts/gen-icons.mjs（file/project/image/archive）。
 */
export type FileIconName = "file" | "project" | "image" | "archive";

export function fileIcon(kind: "file" | "directory", name: string): FileIconName {
  if (kind === "directory") return "project";
  switch (fileCategory(name)) {
    case "image":
      return "image";
    case "archive":
      return "archive";
    default:
      return "file";
  }
}

/** 下载/预览安全文件名：去掉路径分隔符，控制长度。 */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/:*?"<>|]/gu, "_").trim();
  const safe = cleaned.length > 0 ? cleaned : "file";
  return safe.length > 120 ? safe.slice(safe.length - 120) : safe;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 按扩展名估 mime（上传元数据用；未知回退 octet-stream）。 */
export function mimeForFile(name: string): string {
  return MIME_BY_EXTENSION[fileExtension(name)] ?? "application/octet-stream";
}
