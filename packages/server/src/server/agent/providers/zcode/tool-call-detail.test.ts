import { describe, expect, it } from "vitest";
import {
  buildZcodeToolCallItem,
  displayZcodeToolName,
  enrichZcodeToolCallDetail,
  mapZcodeToolCallDetail,
  zcodeToolResultText,
} from "./tool-call-detail.js";

describe("displayZcodeToolName", () => {
  it("strips the mcp__ namespace prefix", () => {
    expect(displayZcodeToolName("mcp__codegraph__explore")).toBe("codegraph__explore");
    expect(displayZcodeToolName("bash")).toBe("bash");
  });
});

describe("mapZcodeToolCallDetail", () => {
  it("maps bash commands to shell details", () => {
    expect(mapZcodeToolCallDetail("Bash", { command: "npm test" })).toEqual({
      type: "shell",
      command: "npm test",
    });
  });

  it("maps read tools to read details with ranges", () => {
    expect(mapZcodeToolCallDetail("read", { file_path: "/a/b.ts", offset: 10, limit: 5 })).toEqual({
      type: "read",
      filePath: "/a/b.ts",
      offset: 10,
      limit: 5,
    });
  });

  it("maps edit and write tools by file path", () => {
    expect(mapZcodeToolCallDetail("edit_file", { filePath: "/a.ts" }).type).toBe("edit");
    expect(mapZcodeToolCallDetail("write_file", { path: "/a.ts" }).type).toBe("write");
  });

  it("maps search-like tools to search details", () => {
    expect(mapZcodeToolCallDetail("grep", { pattern: "TODO" })).toEqual({
      type: "search",
      query: "TODO",
    });
    expect(mapZcodeToolCallDetail("web_search", { query: "paseo" })).toEqual({
      type: "search",
      query: "paseo",
      toolName: "web_search",
    });
    expect(mapZcodeToolCallDetail("fetch", { url: "https://example.com" })).toEqual({
      type: "fetch",
      url: "https://example.com",
    });
  });

  it("falls back to plain_text with a one-line summary", () => {
    const detail = mapZcodeToolCallDetail("todo_write", { todos: "[]" });
    expect(detail).toEqual({ type: "plain_text", label: "todo_write" });
    expect(mapZcodeToolCallDetail("custom_tool", { prompt: "do things" })).toEqual({
      type: "plain_text",
      label: "custom_tool",
      text: "do things",
    });
  });

  it("parses string JSON input", () => {
    expect(mapZcodeToolCallDetail("bash", '{"command":"ls"}')).toEqual({
      type: "shell",
      command: "ls",
    });
  });
});

describe("zcodeToolResultText", () => {
  it("joins structured content parts", () => {
    expect(
      zcodeToolResultText({
        success: true,
        content: [
          { type: "text", text: "line1" },
          { type: "text", text: "line2" },
        ],
      }),
    ).toBe("line1\nline2");
  });

  it("truncates long output", () => {
    const text = zcodeToolResultText({ success: true, content: "x".repeat(5000) });
    expect(text?.length).toBeLessThan(5000);
    expect(text?.endsWith("(truncated)")).toBe(true);
  });

  it("returns undefined for empty content", () => {
    expect(zcodeToolResultText(undefined)).toBeUndefined();
    expect(zcodeToolResultText({ success: true, content: [] })).toBeUndefined();
  });
});

describe("enrichZcodeToolCallDetail", () => {
  it("attaches output to shell details", () => {
    expect(
      enrichZcodeToolCallDetail(
        { type: "shell", command: "ls" },
        { success: true, content: "a\nb" },
      ),
    ).toEqual({ type: "shell", command: "ls", output: "a\nb" });
  });

  it("leaves details unchanged without result text", () => {
    const detail = { type: "shell", command: "ls" } as const;
    expect(enrichZcodeToolCallDetail(detail, undefined)).toBe(detail);
  });
});

describe("buildZcodeToolCallItem", () => {
  it("builds a running item and a completed item with the result merged", () => {
    const running = buildZcodeToolCallItem({
      callId: "tc1",
      toolName: "bash",
      input: { command: "echo hi" },
      status: "running",
    });
    expect(running).toMatchObject({
      type: "tool_call",
      callId: "tc1",
      name: "bash",
      status: "running",
      detail: { type: "shell", command: "echo hi" },
    });

    const completed = buildZcodeToolCallItem({
      callId: "tc1",
      toolName: "bash",
      input: { command: "echo hi" },
      status: "completed",
      result: { success: true, content: "hi" },
    });
    expect(completed).toMatchObject({
      status: "completed",
      detail: { type: "shell", command: "echo hi", output: "hi" },
    });
  });

  it("marks failed results", () => {
    const failed = buildZcodeToolCallItem({
      callId: "tc2",
      toolName: "bash",
      input: { command: "boom" },
      status: "failed",
      result: { success: false, content: "exit 1" },
    });
    expect(failed.status).toBe("failed");
    expect(failed.error).toBeDefined();
  });
});
