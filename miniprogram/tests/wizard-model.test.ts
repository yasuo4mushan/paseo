/**
 * 创建向导级联状态机测试（t24）：
 * - 换设备清空下游链（文件夹/框架/模型/thinking）
 * - 换文件夹清框架、换框架清模型+thinking、换模型清 thinking
 * - 面包屑回点：可达性判定 + 数据保留 + 不可达原地不动
 * - 初始态自动选中已连接设备
 */

import { describe, expect, it } from "vitest";
import {
  canAdvance,
  goToStep,
  initialWizardState,
  nextStepOf,
  selectDevice,
  selectFolder,
  selectModel,
  selectProvider,
  selectThinking,
  stepReachable,
  stepSummary,
  WIZARD_STEPS,
  type WizardState,
} from "../src/pages/create/wizard-model";

/** 推进到末步的完整链（用于级联重置测试的基线）。 */
function fullSelection(): WizardState {
  let state = initialWizardState("dev-1");
  state = selectDevice(state, "dev-1");
  state = selectFolder(state, { path: "/Users/me/projects/api", name: "api" });
  state = selectProvider(state, "zcode");
  state = selectModel(state, "glm-4.7");
  state = selectThinking(state, "thinking-high");
  return state;
}

describe("initialWizardState", () => {
  it("无连接设备：停在设备步、全空", () => {
    const state = initialWizardState();
    expect(state.step).toBe("device");
    expect(state.deviceId).toBe("");
    expect(state.folder).toBeNull();
  });

  it("已连接设备：自动选中并进入文件夹步", () => {
    const state = initialWizardState("dev-1");
    expect(state.deviceId).toBe("dev-1");
    expect(state.step).toBe("folder");
  });
});

describe("级联重置链", () => {
  it("换设备清空全部下游选择并回到文件夹步", () => {
    const state = selectDevice(fullSelection(), "dev-2");
    expect(state).toEqual({
      step: "folder",
      deviceId: "dev-2",
      folder: null,
      provider: "",
      modelId: "",
      thinkingOptionId: "",
    });
  });

  it("重选同一设备：只前进到文件夹步，数据保留", () => {
    const before = fullSelection();
    const state = selectDevice(before, "dev-1");
    expect(state.step).toBe("folder");
    expect(state.folder).toEqual(before.folder);
    expect(state.provider).toBe("zcode");
  });

  it("换文件夹清空框架/模型/thinking", () => {
    const state = selectFolder(fullSelection(), { path: "/Users/me/web", name: "web" });
    expect(state.step).toBe("framework");
    expect(state.folder).toEqual({ path: "/Users/me/web", name: "web" });
    expect(state.provider).toBe("");
    expect(state.modelId).toBe("");
    expect(state.thinkingOptionId).toBe("");
  });

  it("换框架清空模型与 thinking", () => {
    const state = selectProvider(fullSelection(), "kimi");
    expect(state.step).toBe("model");
    expect(state.provider).toBe("kimi");
    expect(state.modelId).toBe("");
    expect(state.thinkingOptionId).toBe("");
    expect(state.folder).not.toBeNull();
  });

  it("换模型清空 thinking，保留框架", () => {
    const state = selectModel(fullSelection(), "k2");
    expect(state.step).toBe("effort");
    expect(state.provider).toBe("zcode");
    expect(state.modelId).toBe("k2");
    expect(state.thinkingOptionId).toBe("");
  });

  it("thinking 是叶子选择：不清任何数据", () => {
    const state = selectThinking(fullSelection(), "thinking-low");
    expect(state.thinkingOptionId).toBe("thinking-low");
    expect(state.modelId).toBe("glm-4.7");
    expect(state.step).toBe("effort");
  });
});

describe("面包屑回点", () => {
  it("末步可回点任意已完成步骤且数据保留", () => {
    const full = fullSelection();
    for (const step of WIZARD_STEPS) {
      const state = goToStep(full, step);
      expect(state.step).toBe(step);
      // 回点不丢数据
      expect(state.deviceId).toBe("dev-1");
      expect(state.folder?.path).toBe("/Users/me/projects/api");
      expect(state.provider).toBe("zcode");
      expect(state.modelId).toBe("glm-4.7");
      expect(state.thinkingOptionId).toBe("thinking-high");
    }
  });

  it("前置缺失的步骤不可达：回点原地不动", () => {
    // 只选了设备：folder 可达，framework 之后不可达
    let state = initialWizardState("dev-1");
    state = goToStep(state, "framework");
    expect(state.step).toBe("folder");
    state = goToStep(state, "model");
    expect(state.step).toBe("folder");
    // 无连接设备：folder 也不可达
    const fresh = initialWizardState();
    expect(stepReachable(fresh, "folder")).toBe(false);
    expect(goToStep(fresh, "folder").step).toBe("device");
  });

  it("provider 无模型目录（modelId 空）时 effort 仍可达（并入提交步）", () => {
    let state = initialWizardState("dev-1");
    state = selectFolder(state, { path: "/tmp/x", name: "x" });
    state = selectProvider(state, "zcode");
    expect(state.modelId).toBe("");
    expect(stepReachable(state, "effort")).toBe(true);
  });

  it("stepSummary：未选占位 / 已选摘要", () => {
    const state = fullSelection();
    expect(stepSummary(state, "device")).toBe("dev-1");
    expect(stepSummary(state, "folder")).toBe("api");
    expect(stepSummary(state, "framework")).toBe("zcode");
    expect(stepSummary(initialWizardState(), "folder")).toBe("未选择");
  });
});

describe("步骤推进", () => {
  it("canAdvance 按当前步数据判定", () => {
    expect(canAdvance(initialWizardState())).toBe(false);
    let state = selectDevice(initialWizardState(), "dev-1");
    expect(canAdvance(state)).toBe(false); // 未选文件夹
    state = selectFolder(state, { path: "/tmp/a", name: "a" });
    expect(canAdvance(state)).toBe(false); // 未选框架（便利预选前）
    state = { ...state, provider: "zcode" };
    expect(canAdvance(state)).toBe(true);
    expect(canAdvance({ ...state, step: "model" })).toBe(true);
    expect(canAdvance({ ...state, step: "effort" })).toBe(true);
  });

  it("nextStepOf 末步返回 null", () => {
    expect(nextStepOf("device")).toBe("folder");
    expect(nextStepOf("effort")).toBeNull();
  });
});
