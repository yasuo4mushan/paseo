/**
 * 创建向导级联状态机（t24，纯函数，单测覆盖）。
 *
 * 步骤链（每步依赖前一步；审批模式不进向导——t20 composer 会话中切换）：
 *   ① device 设备 → ② folder 项目文件夹 → ③ framework agent 框架 →
 *   ④ model 模型 → ⑤ effort thinking 档位。
 *
 * 级联规则：改选上游步骤会清空所有下游选择（换设备清文件夹/框架/模型/thinking；
 * 换文件夹清框架；换框架清模型与 thinking；换模型清 thinking）。
 * 面包屑回点（goToStep）只移动当前步，不清数据——用户回看已选项；
 * 真正改选时由 select* 函数按上表清空依赖链。
 */

export type WizardStep = "device" | "folder" | "framework" | "model" | "effort";

export const WIZARD_STEPS: WizardStep[] = ["device", "folder", "framework", "model", "effort"];

export const STEP_TITLES: Record<WizardStep, string> = {
  device: "设备",
  folder: "项目文件夹",
  framework: "Agent 框架",
  model: "模型",
  effort: "Thinking",
};

export interface WizardFolder {
  /** 设备侧绝对路径（POSIX，daemon cwd 用）。 */
  path: string;
  /** 文件夹名（项目名展示用）。 */
  name: string;
}

export interface WizardState {
  step: WizardStep;
  /** 已选设备 id（连接管理器的 deviceId；"" = 未选）。 */
  deviceId: string;
  folder: WizardFolder | null;
  provider: string;
  /** 模型 id（"" = 该 provider 无目录、用默认模型）。 */
  modelId: string;
  thinkingOptionId: string;
}

/** 初始态：自动选中当前已连接设备（无连接则停在设备步）。 */
export function initialWizardState(connectedDeviceId?: string): WizardState {
  return {
    step: connectedDeviceId ? "folder" : "device",
    deviceId: connectedDeviceId ?? "",
    folder: null,
    provider: "",
    modelId: "",
    thinkingOptionId: "",
  };
}

export function stepIndex(step: WizardStep): number {
  return WIZARD_STEPS.indexOf(step);
}

/**
 * 跳到任意"前置已选齐"的步骤（面包屑回点回看/改选，或"下一步"前进）。
 * 数据保留——改选时的级联清空由 select* 负责。前置不满足（不可达）则原地不动。
 */
export function goToStep(state: WizardState, step: WizardStep): WizardState {
  if (!stepReachable(state, step) || step === state.step) return state;
  return { ...state, step };
}

/** 选设备：换设备 → 清空全部下游选择，进入文件夹步。 */
export function selectDevice(state: WizardState, deviceId: string): WizardState {
  if (deviceId === state.deviceId) return { ...state, step: "folder" };
  return {
    step: "folder",
    deviceId,
    folder: null,
    provider: "",
    modelId: "",
    thinkingOptionId: "",
  };
}

/** 选文件夹：换文件夹 → 清空框架/模型/thinking，进入框架步。 */
export function selectFolder(state: WizardState, folder: WizardFolder): WizardState {
  if (state.folder && folder.path === state.folder.path) {
    return { ...state, step: "framework" };
  }
  return {
    ...state,
    step: "framework",
    folder,
    provider: "",
    modelId: "",
    thinkingOptionId: "",
  };
}

/** 选框架：换 provider → 清空模型与 thinking，进入模型步。 */
export function selectProvider(state: WizardState, provider: string): WizardState {
  if (provider === state.provider) return { ...state, step: "model" };
  return { ...state, step: "model", provider, modelId: "", thinkingOptionId: "" };
}

/** 选模型：换模型 → 清空 thinking（页面侧按新模型目录补默认档），进入 effort 步。 */
export function selectModel(state: WizardState, modelId: string): WizardState {
  if (modelId === state.modelId) return { ...state, step: "effort" };
  return { ...state, step: "effort", modelId, thinkingOptionId: "" };
}

/** 选 thinking 档位：叶子选择，不清任何数据。 */
export function selectThinking(state: WizardState, thinkingOptionId: string): WizardState {
  return { ...state, thinkingOptionId };
}

/** 某步是否已达可交互条件（面包屑可回点 = 该步前置已选齐）。 */
export function stepReachable(state: WizardState, step: WizardStep): boolean {
  switch (step) {
    case "device":
      return true;
    case "folder":
      return state.deviceId !== "";
    case "framework":
      return state.folder !== null;
    case "model":
      return state.provider !== "";
    case "effort":
      // provider 无模型目录时（modelId ""），effort 步并入模型步之后直接提交
      return state.provider !== "";
  }
}

/** 当前步的"下一步"是否可用（末步 effort 由提交按钮接管）。 */
export function canAdvance(state: WizardState): boolean {
  switch (state.step) {
    case "device":
      return state.deviceId !== "";
    case "folder":
      return state.folder !== null;
    case "framework":
      return state.provider !== "";
    case "model":
    case "effort":
      return true;
  }
}

/** 下一步（末步返回 null）。 */
export function nextStepOf(step: WizardStep): WizardStep | null {
  const index = stepIndex(step);
  return index < WIZARD_STEPS.length - 1 ? WIZARD_STEPS[index + 1] : null;
}

/** 面包屑展示标签：已选项摘要（未选显示占位）。 */
export function stepSummary(state: WizardState, step: WizardStep): string {
  switch (step) {
    case "device":
      return state.deviceId || "未选择";
    case "folder":
      return state.folder?.name ?? "未选择";
    case "framework":
      return state.provider || "未选择";
    case "model":
      return state.modelId || "默认";
    case "effort":
      return state.thinkingOptionId || "默认";
  }
}
