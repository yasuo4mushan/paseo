/**
 * folder-picker 路径栈纯函数测试（t24）：
 * - daemon 归一化路径 → trail 段数组（初始 "~" 浏览还原 home 路径）
 * - trail 的进出/回点/面包屑/绝对路径拼接（POSIX 根与 "~" 根两档）
 * - 新建文件夹名校验
 * - t31 相对路径目录栈（文件面板/files 页共用）
 */

import { describe, expect, it } from "vitest";
import {
  absoluteTrailPath,
  breadcrumbSegments,
  childTrail,
  dirStackFromPath,
  parentDirPath,
  parentTrail,
  relativeTrailPath,
  trailFromDaemonPath,
  trailName,
  trailToDepth,
  validateFolderName,
} from "../src/utils/folder-path";

describe("trailFromDaemonPath（初始定位 home）", () => {
  it("browse('/','~') 的归一化结果还原 home trail", () => {
    expect(trailFromDaemonPath("Users/xiangdebin")).toEqual(["Users", "xiangdebin"]);
  });

  it("根（'.'）与空串 → 空 trail", () => {
    expect(trailFromDaemonPath(".")).toEqual([]);
    expect(trailFromDaemonPath("")).toEqual([]);
    expect(trailFromDaemonPath("/")).toEqual([]);
  });

  it("容错：首尾斜杠与空段", () => {
    expect(trailFromDaemonPath("/Users/xiangdebin/projects/")).toEqual([
      "Users",
      "xiangdebin",
      "projects",
    ]);
  });
});

describe("路径栈进出", () => {
  it("进入子目录 push、返回上一级 pop", () => {
    const trail = ["Users", "xiangdebin"];
    expect(childTrail(trail, "projects")).toEqual(["Users", "xiangdebin", "projects"]);
    expect(parentTrail(["Users", "xiangdebin", "projects"])).toEqual(["Users", "xiangdebin"]);
    expect(parentTrail(["Users"])).toEqual([]);
  });

  it("面包屑回点截断到指定层（0=根）", () => {
    const trail = ["Users", "xiangdebin", "projects", "api"];
    expect(trailToDepth(trail, 0)).toEqual([]);
    expect(trailToDepth(trail, 2)).toEqual(["Users", "xiangdebin"]);
    expect(trailToDepth(trail, 99)).toEqual(trail);
  });
});

describe("路径拼接（两档根）", () => {
  it("POSIX 根：relativeTrailPath / absoluteTrailPath", () => {
    expect(relativeTrailPath(["Users", "me", "p"])).toBe("Users/me/p");
    expect(relativeTrailPath([])).toBe(".");
    expect(absoluteTrailPath(["Users", "me", "p"])).toBe("/Users/me/p");
    expect(absoluteTrailPath([])).toBe("/");
  });

  it("home 根（Windows daemon 回落）：显示与 daemon 路径都用 ~ 前缀", () => {
    expect(absoluteTrailPath(["dev", "app"], "~")).toBe("~/dev/app");
    expect(absoluteTrailPath([], "~")).toBe("~");
  });

  it("面包屑：根标签 + 段，带 depth", () => {
    expect(breadcrumbSegments(["Users", "me"])).toEqual([
      { label: "/", depth: 0 },
      { label: "Users", depth: 1 },
      { label: "me", depth: 2 },
    ]);
    expect(breadcrumbSegments([], "~")[0]).toEqual({ label: "~", depth: 0 });
  });

  it("trailName：末段为名，根用根标签", () => {
    expect(trailName(["Users", "me", "api"])).toBe("api");
    expect(trailName([])).toBe("/");
    expect(trailName([], "~")).toBe("~");
  });
});

describe("validateFolderName", () => {
  it("空名 / 含斜杠 / 点名 / 超长拒绝", () => {
    expect(validateFolderName("  ")).toContain("不能为空");
    expect(validateFolderName("a/b")).toContain("/");
    expect(validateFolderName(".")).toContain(".");
    expect(validateFolderName("..")).toContain(".");
    expect(validateFolderName("x".repeat(61))).toContain("过长");
  });

  it("正常名通过（中文、空格、点后缀）", () => {
    expect(validateFolderName("my-api")).toBeNull();
    expect(validateFolderName("我的项目")).toBeNull();
    expect(validateFolderName("web app")).toBeNull();
    expect(validateFolderName("app.v2")).toBeNull();
  });
});

describe("t31 dirStackFromPath（文件面板/files 页初始定位）", () => {
  it("相对路径 → 每层累计路径的目录栈", () => {
    expect(dirStackFromPath("src/lib/deep")).toEqual(["src", "src/lib", "src/lib/deep"]);
  });

  it("根（''/'.'/'/'）→ 空栈；容错空段", () => {
    expect(dirStackFromPath("")).toEqual([]);
    expect(dirStackFromPath(".")).toEqual([]);
    expect(dirStackFromPath("/")).toEqual([]);
    expect(dirStackFromPath("src//lib")).toEqual(["src", "src/lib"]);
  });
});

describe("t31 parentDirPath（文件所在目录）", () => {
  it("多级取父；一级/根回 '.'", () => {
    expect(parentDirPath("src/lib/a.ts")).toBe("src/lib");
    expect(parentDirPath("README.md")).toBe(".");
    expect(parentDirPath("")).toBe(".");
    expect(parentDirPath("./src/a.ts")).toBe("src");
  });
});
