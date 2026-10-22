/**
 * t19 diff 协议解析单测：checkout.commits.list / file_diff 响应容错解析。
 */

import { describe, expect, it } from "vitest";
import {
  parseCommitsListResponse,
  parseCommitFileDiffResponse,
} from "../src/connection/protocol-types";

const commitsPayload = {
  cwd: "/repo",
  baseRef: "main",
  error: null,
  requestId: "r1",
  commits: [
    {
      sha: "9f8e7d6c5b4a3f2e1d0c9b8a7f6e5d4c3b2a1f0e",
      shortSha: "9f8e7d6",
      subject: "feat: add editor",
      authorName: "dev",
      authorDate: "2026-10-20T10:00:00.000Z",
      isOnRemote: false,
      files: [
        { path: "src/a.ts", additions: 12, deletions: 0, status: "added" },
        { path: "src/b.ts", additions: 3, deletions: 5, status: "modified" },
      ],
    },
    {
      // 坏条目（无 sha）应被剔除而不是整批失败
      sha: "",
      shortSha: "bad",
    },
  ],
};

describe("parseCommitsListResponse", () => {
  it("解析 commit 与文件统计", () => {
    const parsed = parseCommitsListResponse(commitsPayload);
    expect(parsed).not.toBeNull();
    expect(parsed?.baseRef).toBe("main");
    expect(parsed?.commits).toHaveLength(1);
    const commit = parsed?.commits[0];
    expect(commit?.shortSha).toBe("9f8e7d6");
    expect(commit?.isOnRemote).toBe(false);
    expect(commit?.files).toEqual([
      { path: "src/a.ts", additions: 12, deletions: 0, status: "added" },
      { path: "src/b.ts", additions: 3, deletions: 5, status: "modified" },
    ]);
  });

  it("error 非空时透出", () => {
    const parsed = parseCommitsListResponse({ ...commitsPayload, error: "not a git repo" });
    expect(parsed?.error).toBe("not a git repo");
  });

  it("非对象 payload 返回 null", () => {
    expect(parseCommitsListResponse("x")).toBeNull();
  });
});

const diffPayload = {
  cwd: "/repo",
  sha: "9f8e7d6c",
  path: "src/a.ts",
  error: null,
  requestId: "r2",
  file: {
    path: "src/a.ts",
    isNew: true,
    isDeleted: false,
    additions: 2,
    deletions: 1,
    hunks: [
      {
        oldStart: 1,
        oldCount: 1,
        newStart: 1,
        newCount: 2,
        lines: [
          { type: "header", content: "// header" },
          { type: "remove", content: "old line" },
          { type: "add", content: "new line 1" },
          { type: "add", content: "new line 2" },
          { type: "context", content: "keep" },
          { type: "bogus", content: "应被剔除" },
        ],
      },
    ],
    status: "ok",
  },
};

describe("parseCommitFileDiffResponse", () => {
  it("解析 hunk 行（add/remove/context/header；未知类型剔除）", () => {
    const parsed = parseCommitFileDiffResponse(diffPayload);
    expect(parsed?.error).toBeNull();
    const file = parsed?.file;
    expect(file?.additions).toBe(2);
    expect(file?.hunks[0].lines.map((l) => l.type)).toEqual([
      "header",
      "remove",
      "add",
      "add",
      "context",
    ]);
    expect(file?.hunks[0].lines[2].content).toBe("new line 1");
  });

  it("file 为 null（二进制/不在 commit）透传", () => {
    const parsed = parseCommitFileDiffResponse({ ...diffPayload, file: null });
    expect(parsed?.file).toBeNull();
  });

  it("lines 非数组时 hunk 保留、行清空", () => {
    const parsed = parseCommitFileDiffResponse({
      ...diffPayload,
      file: { ...diffPayload.file, hunks: [{ oldStart: 0, lines: "bad", extra: 1 }] },
    });
    const hunks = parsed?.file?.hunks ?? [];
    expect(hunks).toHaveLength(1);
    expect(hunks[0].lines).toEqual([]);
  });
});
