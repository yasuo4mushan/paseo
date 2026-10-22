/**
 * 文件编辑会话状态机（t19）：读 → 编辑 → 写回（fs.file.write）→ 冲突处理。
 *
 * 冲突协议（messages.ts FileWriteResultSchema）：
 * - 写回带 expectedModifiedAt/revision（读时版本）；
 * - daemon 侧文件已被修改 → status:"conflict" + 当前 version；
 * - 用户三选：重新加载（丢弃本地）/ 覆盖远端（用 conflict version 的新版本号再写一次）/
 *   留在编辑器（保留本地内容继续编辑）。
 *
 * 纯状态机（无 IO），页面负责调连接层 RPC 并把结果作为事件送回。
 */

export type FileEditStatus =
  | "loading"
  | "clean" // 已加载未修改
  | "dirty" // 本地已修改未保存
  | "saving"
  | "conflict" // 保存撞上远端修改，等用户决策
  | "saved" // 刚保存成功（回到 clean 前的瞬时态）
  | "error";

export interface FileEditVersion {
  modifiedAt: string;
  revision?: string;
}

export interface FileEditState {
  status: FileEditStatus;
  /** 服务端版本（加载时 / 冲突时刷新）。 */
  base: FileEditVersion | null;
  /** 冲突时 daemon 报告的远端当前版本。 */
  remote: FileEditVersion | null;
  error: string | null;
}

export type FileEditEvent =
  | { type: "loaded"; version: FileEditVersion }
  | { type: "load_failed"; error: string }
  | { type: "change" }
  | { type: "save_started" }
  | { type: "save_written"; version: FileEditVersion }
  | { type: "save_conflict"; remote: FileEditVersion }
  | { type: "save_failed"; error: string }
  | { type: "conflict_reload" } // 用户选"重新加载"：回 clean 等待页面重读内容
  | { type: "conflict_overwrite_started" } // 用户选"覆盖"：用 remote 版本号重写
  | { type: "conflict_dismiss" } // 用户选"继续编辑"：保留 dirty 内容
  | { type: "acknowledge" }; // saved/error 瞬时态归位

export const initialFileEditState: FileEditState = {
  status: "loading",
  base: null,
  remote: null,
  error: null,
};

export function nextFileEditState(state: FileEditState, event: FileEditEvent): FileEditState {
  switch (event.type) {
    case "loaded":
      return { status: "clean", base: event.version, remote: null, error: null };
    case "load_failed":
      return { ...state, status: "error", error: event.error };
    case "change":
      if (state.status === "clean") return { ...state, status: "dirty" };
      if (state.status === "conflict") {
        // 冲突对话框里继续编辑 = 选择保留本地（同 conflict_dismiss 后再 change）
        return { ...state, status: "dirty", remote: null };
      }
      return state;
    case "save_started":
      if (state.status !== "dirty") return state;
      return { ...state, status: "saving", error: null };
    case "save_written":
      if (state.status !== "saving") return state;
      return { status: "saved", base: event.version, remote: null, error: null };
    case "save_conflict":
      if (state.status !== "saving") return state;
      return { status: "conflict", base: state.base, remote: event.remote, error: null };
    case "save_failed":
      if (state.status !== "saving") return state;
      return { ...state, status: "dirty", error: event.error };
    case "conflict_reload":
      if (state.status !== "conflict") return state;
      // 回到 clean 基线（页面随后重读内容触发 loaded 覆写文本域）
      return { status: "clean", base: remoteOrBase(state), remote: null, error: null };
    case "conflict_overwrite_started":
      if (state.status !== "conflict") return state;
      // 以远端版本号作为新 expected 再写：saving 且 base 已推进
      return { status: "saving", base: remoteOrBase(state), remote: null, error: null };
    case "conflict_dismiss":
      if (state.status !== "conflict") return state;
      return { ...state, status: "dirty", remote: null };
    case "acknowledge":
      if (state.status === "saved") return { ...state, status: "clean" };
      if (state.status === "error")
        return { ...initialFileEditState, status: "clean", base: state.base };
      return state;
    default:
      return state;
  }
}

function remoteOrBase(state: FileEditState): FileEditVersion | null {
  return state.remote ?? state.base;
}

/** 从 fs 写回结果提取版本（written/conflict.ready）；missing/error 归 null。 */
export function versionFromWriteResult(
  result:
    | { status: "written"; modifiedAt: string; revision?: string }
    | { status: "conflict"; version: { status: string; modifiedAt?: unknown; revision?: unknown } },
): FileEditVersion | null {
  if (result.status === "written") {
    return {
      modifiedAt: result.modifiedAt,
      ...(result.revision ? { revision: result.revision } : {}),
    };
  }
  const version = result.version;
  if (version.status === "ready" && typeof version.modifiedAt === "string") {
    return {
      modifiedAt: version.modifiedAt,
      ...(typeof version.revision === "string" ? { revision: version.revision } : {}),
    };
  }
  return null;
}
