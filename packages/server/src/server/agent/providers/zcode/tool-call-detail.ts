/**
 * Maps ZCode tool calls (from `model.streaming` tool_input_* deltas and
 * `tool.updated` results) to Paseo ToolCallDetail timeline items.
 *
 * ZCode executes its own tools inside its session; these items are
 * display-only mirrors, like the Codex and Claude providers.
 */
import type { ToolCallDetail, ToolCallTimelineItem } from "../../agent-sdk-types.js";
import type { ZcodeToolResultPayload } from "./protocol.js";

const MAX_RESULT_CHARS = 4000;

const BASH_TOOL_NAMES = new Set(["bash", "shell", "run_command", "execute_command", "terminal"]);
const READ_TOOL_NAMES = new Set(["read", "read_file", "view_file"]);
const EDIT_TOOL_NAMES = new Set(["edit", "edit_file", "apply_patch", "str_replace", "replace"]);
const WRITE_TOOL_NAMES = new Set(["write", "write_file", "create_file", "writefile"]);
const SEARCH_TOOL_NAMES = new Set(["grep", "glob", "search", "find", "list_dir", "ls"]);
const WEB_SEARCH_TOOL_NAMES = new Set(["web_search", "websearch"]);
const FETCH_TOOL_NAMES = new Set(["fetch", "web_fetch", "webfetch", "read_url"]);

export function displayZcodeToolName(toolName: string): string {
  // ZCode namespaces MCP tools as mcp__<server>__<tool>.
  return toolName.startsWith("mcp__") ? toolName.slice("mcp__".length) : toolName;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value != null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (parsed != null && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Partial JSON streamed before finalization; leave as-is.
    }
  }
  return {};
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return undefined;
}

export function mapZcodeToolCallDetail(toolName: string, input: unknown): ToolCallDetail {
  const name = displayZcodeToolName(toolName).toLowerCase();
  const args = asRecord(input);
  const filePath = firstString(args, ["filePath", "file_path", "path", "file", "targetFile"]);
  const detail = mapNamedZcodeTool(name, args, filePath);
  if (detail) return detail;
  const summary = firstString(args, [
    "command",
    "filePath",
    "file_path",
    "path",
    "query",
    "url",
    "prompt",
    "pattern",
  ]);
  if (summary) {
    return { type: "plain_text", label: displayZcodeToolName(toolName), text: summary };
  }
  return { type: "plain_text", label: displayZcodeToolName(toolName) };
}

function mapNamedZcodeTool(
  name: string,
  args: Record<string, unknown>,
  filePath: string | undefined,
): ToolCallDetail | null {
  if (BASH_TOOL_NAMES.has(name)) {
    const command = firstString(args, ["command", "cmd", "script"]);
    return command ? { type: "shell", command } : null;
  }
  if (READ_TOOL_NAMES.has(name) && filePath) {
    const offset = typeof args.offset === "number" ? args.offset : undefined;
    const limit = typeof args.limit === "number" ? args.limit : undefined;
    return offset !== undefined || limit !== undefined
      ? { type: "read", filePath, offset, limit }
      : { type: "read", filePath };
  }
  if (EDIT_TOOL_NAMES.has(name) && filePath) {
    return {
      type: "edit",
      filePath,
      oldString: firstString(args, ["oldString", "old_string", "old_str"]),
      newString: firstString(args, ["newString", "new_string", "new_str"]),
      unifiedDiff: firstString(args, ["diff", "unifiedDiff", "unified_diff"]),
    };
  }
  if (WRITE_TOOL_NAMES.has(name) && filePath) {
    const content = firstString(args, ["content", "text"]);
    return content !== undefined
      ? { type: "write", filePath, content }
      : { type: "write", filePath };
  }
  if (WEB_SEARCH_TOOL_NAMES.has(name)) {
    const query = firstString(args, ["query", "q", "search"]);
    return query ? { type: "search", query, toolName: "web_search" } : null;
  }
  if (SEARCH_TOOL_NAMES.has(name)) {
    const query = firstString(args, ["pattern", "query", "q", "search", "glob"]);
    return query ? { type: "search", query } : null;
  }
  if (FETCH_TOOL_NAMES.has(name)) {
    const url = firstString(args, ["url", "uri", "link"]);
    return url ? { type: "fetch", url } : null;
  }
  return null;
}

/** Flattens a ZCode tool result content payload into a display string. */
export function zcodeToolResultText(
  result: ZcodeToolResultPayload | undefined,
): string | undefined {
  if (!result || result.content === undefined) return undefined;
  const content = result.content;
  let text: string;
  if (typeof content === "string") {
    text = content;
  } else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part != null && typeof part === "object" && !Array.isArray(part)) {
          const record = part as Record<string, unknown>;
          if (typeof record.text === "string") return record.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  } else {
    text = "";
  }
  if (!text) return undefined;
  const truncated = text.length > MAX_RESULT_CHARS;
  return truncated ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (truncated)` : text;
}

/** Enriches a tool-call detail with the execution result from tool.updated. */
export function enrichZcodeToolCallDetail(
  detail: ToolCallDetail,
  result: ZcodeToolResultPayload | undefined,
): ToolCallDetail {
  const text = zcodeToolResultText(result);
  if (text === undefined) return detail;
  switch (detail.type) {
    case "shell":
      return { ...detail, output: text };
    case "read":
      return { ...detail, content: text };
    case "search":
      return { ...detail, content: text };
    case "fetch":
      return { ...detail, result: text };
    case "write":
      return { ...detail };
    default:
      return detail.type === "plain_text"
        ? { ...detail, text: `${detail.text ?? ""}\n${text}`.trim() }
        : detail;
  }
}

export function buildZcodeToolCallItem(params: {
  callId: string;
  toolName: string;
  input: unknown;
  status: "running" | "completed" | "failed" | "canceled";
  result?: ZcodeToolResultPayload;
  error?: unknown;
}): ToolCallTimelineItem {
  const baseDetail = mapZcodeToolCallDetail(params.toolName, params.input);
  const detail =
    params.status === "running" || !params.result
      ? baseDetail
      : enrichZcodeToolCallDetail(baseDetail, params.result);
  if (params.status === "running") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: displayZcodeToolName(params.toolName),
      status: "running",
      error: null,
      detail,
    };
  }
  if (params.status === "failed") {
    return {
      type: "tool_call",
      callId: params.callId,
      name: displayZcodeToolName(params.toolName),
      status: "failed",
      error: params.error ?? { message: "Tool execution failed" },
      detail,
    };
  }
  return {
    type: "tool_call",
    callId: params.callId,
    name: displayZcodeToolName(params.toolName),
    status: params.status === "canceled" ? "canceled" : "completed",
    error: null,
    detail,
  };
}
