/**
 * 新建工作区页纯函数测试（t31-b）：
 * - repo 输入归一（t18 遗留能力回归）
 * - 点选 + 高级手输 → 生效目录（手输优先，t31-b 核心规则）
 * - 目录路径校验（空 / 非绝对路径 / "~" 前缀合法）
 * - 展示名兜底（路径末段）
 */

import { describe, expect, it } from "vitest";
import {
  directoryDisplayName,
  directoryPathError,
  effectiveDirectoryPath,
  normalizeRepoInput,
} from "../src/pages/new-workspace/paths";

describe("normalizeRepoInput（t18 回归）", () => {
  it("owner/name 与 GitHub URL（.git 后缀 / ssh 形态）→ owner/name", () => {
    expect(normalizeRepoInput("octocat/hello-world")).toBe("octocat/hello-world");
    expect(normalizeRepoInput("https://github.com/octocat/hello-world")).toBe(
      "octocat/hello-world",
    );
    expect(normalizeRepoInput("https://github.com/octocat/hello-world.git")).toBe(
      "octocat/hello-world",
    );
    expect(normalizeRepoInput("git@github.com:octocat/hello-world.git")).toBe(
      "octocat/hello-world",
    );
  });

  it("空白 / 非法格式 → null", () => {
    expect(normalizeRepoInput("")).toBeNull();
    expect(normalizeRepoInput("   ")).toBeNull();
    expect(normalizeRepoInput("just-a-name")).toBeNull();
    expect(normalizeRepoInput("a/b/c")).toBeNull();
  });
});

describe("effectiveDirectoryPath（点选 + 高级手输）", () => {
  const pick = { path: "/Users/me/projects/api", name: "api" };

  it("未手输 → 点选结果生效", () => {
    expect(effectiveDirectoryPath(pick, "")).toBe("/Users/me/projects/api");
    expect(effectiveDirectoryPath(pick, "   ")).toBe("/Users/me/projects/api");
  });

  it("手输非空 → 手输优先（高级展开时的语义）", () => {
    expect(effectiveDirectoryPath(pick, "/srv/code")).toBe("/srv/code");
    expect(effectiveDirectoryPath(pick, " /srv/code ")).toBe("/srv/code");
  });

  it("两者皆空 → 空串（尚未选择）", () => {
    expect(effectiveDirectoryPath(null, "")).toBe("");
  });
});

describe("directoryPathError", () => {
  it("空路径 → 引导点选/手输的空态文案", () => {
    expect(directoryPathError("", "请先点选项目目录")).toBe("请先点选项目目录");
  });

  it("相对路径拒绝，/ 与 ~ 前缀放行（daemon 展开语义）", () => {
    expect(directoryPathError("Users/me/app", "x")).toContain("绝对路径");
    expect(directoryPathError("/Users/me/app", "x")).toBeNull();
    expect(directoryPathError("~/projects/app", "x")).toBeNull();
  });
});

describe("directoryDisplayName", () => {
  it("取路径末段；尾斜杠与空段容错；根路径原样", () => {
    expect(directoryDisplayName("/Users/me/projects/api")).toBe("api");
    expect(directoryDisplayName("/Users/me/projects/api/")).toBe("api");
    expect(directoryDisplayName("/")).toBe("/");
    expect(directoryDisplayName("~")).toBe("~");
  });
});
