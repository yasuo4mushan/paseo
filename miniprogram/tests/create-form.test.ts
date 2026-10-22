/**
 * 创建表单校验与权限摘要纯函数测试（t16）。
 */
import { describe, expect, it } from "vitest";
import {
  hasErrors,
  providerDisabledReason,
  validateCreateForm,
} from "../src/pages/create/validate";
import {
  permissionKindLabel,
  permissionTitle,
  summarizePermissionInput,
} from "../src/permission/summarize";
import type { PermissionRequest } from "../src/connection/protocol-types";

const WORKSPACE = { workspaceId: "ws-1", label: "main", directory: "/tmp/paseo" };

describe("validateCreateForm", () => {
  it("全部为空时给出三处错误", () => {
    const errors = validateCreateForm({ workspace: null, provider: "", prompt: "  " });
    expect(errors.workspace).toBeTruthy();
    expect(errors.provider).toBeTruthy();
    expect(errors.prompt).toBeTruthy();
    expect(hasErrors(errors)).toBe(true);
  });

  it("完整输入无错误", () => {
    const errors = validateCreateForm({
      workspace: WORKSPACE,
      provider: "zcode",
      prompt: "只回复 ok",
    });
    expect(hasErrors(errors)).toBe(false);
  });

  it("prompt 超长报错", () => {
    const errors = validateCreateForm({
      workspace: WORKSPACE,
      provider: "zcode",
      prompt: "a".repeat(4001),
    });
    expect(errors.prompt).toContain("过长");
  });

  it("providerDisabledReason", () => {
    expect(providerDisabledReason({ provider: "zcode", available: true })).toBeNull();
    expect(providerDisabledReason({ provider: "kimi", available: false })).toBe("不可用");
    expect(
      providerDisabledReason({ provider: "kimi", available: false, error: "not installed" }),
    ).toBe("不可用：not installed");
  });
});

const BASE_REQUEST: PermissionRequest = {
  id: "p1",
  provider: "claude",
  name: "Bash",
  kind: "tool",
  title: undefined,
  description: undefined,
  input: {},
  actions: [],
};

describe("permission summarize", () => {
  it("kind 标签与标题回退", () => {
    expect(permissionKindLabel("plan")).toBe("计划确认");
    expect(permissionKindLabel("tool")).toBe("工具授权");
    expect(permissionTitle({ ...BASE_REQUEST, title: "运行命令" })).toBe("运行命令");
    expect(permissionTitle({ ...BASE_REQUEST, title: undefined })).toBe("Bash");
    expect(
      permissionTitle({ ...BASE_REQUEST, title: undefined, name: "", kind: "other" }),
    ).toBe("权限请求");
  });

  it("优先展示常见字段（command）", () => {
    expect(summarizePermissionInput({ command: "rm -rf /tmp", cwd: "/tmp", mode: 1 })).toBe(
      "rm -rf /tmp",
    );
  });

  it("file_path/path/url 次序覆盖", () => {
    expect(summarizePermissionInput({ file_path: "/a/b.ts" })).toBe("/a/b.ts");
    expect(summarizePermissionInput({ url: "https://x" })).toBe("https://x");
  });

  it("数组参数拼接", () => {
    expect(summarizePermissionInput({ command: ["npm", "run", "test"] })).toBe("npm run test");
  });

  it("无常见字段时截断序列化；空输入返回空串", () => {
    const summary = summarizePermissionInput({ weird: { nested: [1, 2, 3] } });
    expect(summary).toContain("weird");
    expect(summarizePermissionInput(undefined)).toBe("");
    expect(summarizePermissionInput({})).toBe("");
  });

  it("超长值截断", () => {
    const summary = summarizePermissionInput({ command: "x".repeat(500) });
    expect(summary.length).toBeLessThanOrEqual(161);
    expect(summary.endsWith("…")).toBe(true);
  });
});
