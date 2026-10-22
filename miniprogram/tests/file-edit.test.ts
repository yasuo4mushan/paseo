/**
 * t19 文件编辑状态机单测：写回冲突协议的三条出路（重载/覆盖/继续编辑）。
 */

import { describe, expect, it } from "vitest";
import {
  initialFileEditState,
  nextFileEditState,
  versionFromWriteResult,
} from "../src/utils/file-edit";

const V1 = { modifiedAt: "2026-10-01T00:00:00.000Z" };
const V1R = { modifiedAt: "2026-10-01T00:00:00.000Z", revision: "r1" };
const V2 = { modifiedAt: "2026-10-02T00:00:00.000Z", revision: "r2" };

function drive(...events: Parameters<typeof nextFileEditState>[1][]) {
  return events.reduce(nextFileEditState, initialFileEditState);
}

describe("file-edit 状态机", () => {
  it("读 → 改 → 存 → 成功", () => {
    const state = drive(
      { type: "loaded", version: V1 },
      { type: "change" },
      { type: "save_started" },
      { type: "save_written", version: V2 },
      { type: "acknowledge" },
    );
    expect(state.status).toBe("clean");
    expect(state.base).toEqual(V2);
  });

  it("冲突 → 重新加载：回到 clean，base 推进到远端版本", () => {
    const state = drive(
      { type: "loaded", version: V1 },
      { type: "change" },
      { type: "save_started" },
      { type: "save_conflict", remote: V2 },
      { type: "conflict_reload" },
    );
    expect(state.status).toBe("clean");
    expect(state.base).toEqual(V2);
    expect(state.remote).toBeNull();
  });

  it("冲突 → 覆盖远端：以远端版本号再写（saving 且 base=remote）", () => {
    const state = drive(
      { type: "loaded", version: V1 },
      { type: "change" },
      { type: "save_started" },
      { type: "save_conflict", remote: V2 },
      { type: "conflict_overwrite_started" },
    );
    expect(state.status).toBe("saving");
    expect(state.base).toEqual(V2);
  });

  it("冲突 → 继续编辑：保留 dirty 内容", () => {
    const state = drive(
      { type: "loaded", version: V1 },
      { type: "change" },
      { type: "save_started" },
      { type: "save_conflict", remote: V2 },
      { type: "conflict_dismiss" },
    );
    expect(state.status).toBe("dirty");
    expect(state.base).toEqual(V1);
  });

  it("未 dirty 不允许 save_started；非 saving 不接受写回结果", () => {
    const clean = drive({ type: "loaded", version: V1 });
    expect(nextFileEditState(clean, { type: "save_started" }).status).toBe("clean");
    expect(nextFileEditState(clean, { type: "save_written", version: V2 }).status).toBe("clean");
    expect(nextFileEditState(clean, { type: "save_conflict", remote: V2 }).status).toBe("clean");
  });

  it("保存失败回 dirty 带错误信息", () => {
    const state = drive(
      { type: "loaded", version: V1 },
      { type: "change" },
      { type: "save_started" },
      { type: "save_failed", error: "连接断开" },
    );
    expect(state.status).toBe("dirty");
    expect(state.error).toBe("连接断开");
  });
});

describe("versionFromWriteResult", () => {
  it("written 提取版本（含可选 revision）", () => {
    expect(versionFromWriteResult({ status: "written", modifiedAt: V1.modifiedAt })).toEqual(V1);
    expect(
      versionFromWriteResult({ status: "written", modifiedAt: V1R.modifiedAt, revision: "r1" }),
    ).toEqual(V1R);
  });

  it("conflict.ready 提取远端版本；missing/error 归 null", () => {
    expect(
      versionFromWriteResult({
        status: "conflict",
        version: { status: "ready", modifiedAt: V2.modifiedAt, revision: "r2" },
      }),
    ).toEqual(V2);
    expect(
      versionFromWriteResult({ status: "conflict", version: { status: "missing" } }),
    ).toBeNull();
    expect(versionFromWriteResult({ status: "conflict", version: { status: "error" } })).toBeNull();
  });
});
