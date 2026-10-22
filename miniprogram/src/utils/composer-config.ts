/**
 * composer 四选择器（pill）状态机（t20，纯函数，packages/app composer
 * agent-controls 的移动简化版）：
 *   Agent 框架（provider）→ 模型（model）→ thinking effort → 审批模式（mode）。
 *
 * 两个形态（协议依据见各函数注释）：
 *  - 草稿态（无活跃会话）：选择仅写本地 draft，发送时一次性用于
 *    create_agent_request.config（provider/cwd/model/modeId/thinkingOptionId）。
 *  - 会话态（活跃会话）：provider 固定（协议无 per-agent provider 切换 RPC）；
 *    model/modeId/thinkingOptionId 的改动走 set_agent_model / set_agent_mode /
 *    set_agent_thinking（AgentActionResponsePayload accepted/error）。
 *
 * 数据源：
 *  - provider 目录：list_available_providers（available=true 过滤）。
 *  - 模型目录：list_provider_models（含 thinkingOptions + defaultThinkingOptionId）。
 *  - 模式目录：list_provider_modes。
 *  - 会话当前值：AgentSnapshot.model / thinkingOptionId(effectiveThinkingOptionId
 *    优先) / currentModeId。
 */

import type {
  AgentSelectOption,
  AgentSnapshot,
  ProviderAvailability,
  ProviderMode,
} from "@/connection/protocol-types";
import type { ProviderModelDefinition } from "@/connection/protocol-types";

export interface ComposerCatalog {
  providers: ProviderAvailability[];
  models: ProviderModelDefinition[];
  modes: ProviderMode[];
}

export interface ComposerDraft {
  provider: string;
  /** 模型 id（空串 = provider 默认）。 */
  modelId: string;
  /** thinking 档位 id（空串 = 模型默认/无档位概念）。 */
  thinkingOptionId: string;
  /** 审批模式 id（空串 = provider 默认）。 */
  modeId: string;
}

export type ComposerPill = "provider" | "model" | "thinking" | "mode";

/** thinking 目录 = 当前所选模型的 thinkingOptions；无模型/无档位 → 空。 */
export function thinkingOptionsFor(
  models: ProviderModelDefinition[],
  modelId: string,
): AgentSelectOption[] {
  const model = models.find((m) => m.id === modelId);
  return model?.thinkingOptions ?? [];
}

/**
 * 会话态下 pill 的当前显示值与可选目录：
 *  - model：snapshot.model（快照可能为 null → "默认"）；
 *  - thinking：effectiveThinkingOptionId ?? thinkingOptionId（provider 实际生效值优先）；
 *  - mode：snapshot.currentModeId；目录优先用快照 availableModes（daemon 推送即有），
 *    拉不到时退 list_provider_modes 的目录（app mode-control 同款兜底）。
 */
export function sessionPillState(
  snapshot: AgentSnapshot,
  catalog: ComposerCatalog,
): {
  provider: string;
  modelId: string;
  thinkingOptionId: string;
  modeId: string;
  modes: ProviderMode[];
  thinkingOptions: AgentSelectOption[];
} {
  const modelId = snapshot.model ?? "";
  const modes =
    snapshot.availableModes && snapshot.availableModes.length > 0
      ? snapshot.availableModes
      : catalog.modes;
  return {
    provider: snapshot.provider,
    modelId,
    thinkingOptionId: snapshot.effectiveThinkingOptionId ?? snapshot.thinkingOptionId ?? "",
    modeId: snapshot.currentModeId ?? "",
    modes,
    thinkingOptions: thinkingOptionsFor(catalog.models, modelId),
  };
}

/**
 * 草稿态选择转移：换 provider 时清空下游三选择（目录失效）；换模型时清 thinking。
 * （catalog 保留在签名里：调用方已持有目录，将来选择转移需要目录校验时不破坏调用点。）
 */
export function applyDraftSelection(
  draft: ComposerDraft,
  pill: ComposerPill,
  value: string,
  _catalog?: ComposerCatalog,
): ComposerDraft {
  if (pill === "provider") {
    if (value === draft.provider) return draft;
    return { provider: value, modelId: "", thinkingOptionId: "", modeId: "" };
  }
  if (pill === "model") {
    if (value === draft.modelId) return draft;
    // 换模型后 thinking 目录随模型变化，清空回"该模型默认"。
    return { ...draft, modelId: value, thinkingOptionId: "" };
  }
  if (pill === "thinking") return { ...draft, thinkingOptionId: value };
  return { ...draft, modeId: value };
}

/** 草稿的默认值装配：provider 目录可用项 → 默认模型（isDefault）/默认档位/默认模式。 */
export function seedDraft(
  catalog: ComposerCatalog,
  preferredProvider?: string,
): ComposerDraft {
  const available = catalog.providers.filter((p) => p.available);
  const provider =
    (preferredProvider && available.some((p) => p.provider === preferredProvider)
      ? preferredProvider
      : undefined) ??
    available[0]?.provider ??
    "";
  const defaultModel = catalog.models.find((m) => m.isDefault) ?? catalog.models[0];
  const modelId = defaultModel?.id ?? "";
  const thinking =
    defaultModel?.thinkingOptions?.find((o) => o.id === defaultModel.defaultThinkingOptionId) ??
    defaultModel?.thinkingOptions?.find((o) => o.isDefault) ??
    defaultModel?.thinkingOptions?.[0];
  return {
    provider,
    modelId,
    thinkingOptionId: thinking?.id ?? "",
    modeId: catalog.modes[0]?.id ?? "",
  };
}

/** 每个选择器对外展示与待选列表（pill 渲染层）。 */
export interface PillView {
  key: ComposerPill;
  /** 展示文案（空目录 → "默认"，UI 再降级隐藏）。 */
  label: string;
  /** 可选项（provider 为 availability 列表）。 */
  options: Array<{ id: string; label: string; description?: string }>;
  /** 当前选中 id（未选 = 空串）。 */
  selectedId: string;
  /** provider 固定（会话态）时不可打开。 */
  locked: boolean;
  /** 目录为空时整个 pill 隐藏（如无 thinking 档位的模型）。 */
  hidden: boolean;
}

export function draftPillViews(draft: ComposerDraft, catalog: ComposerCatalog): PillView[] {
  const providerOptions = catalog.providers
    .filter((p) => p.available)
    .map((p) => ({ id: p.provider, label: p.provider }));
  const modelOptions = catalog.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    description: m.description,
  }));
  const thinking = thinkingOptionsFor(catalog.models, draft.modelId);
  const modeOptions = catalog.modes.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    description: m.description,
  }));
  const modelLabel = modelOptions.find((o) => o.id === draft.modelId)?.label ?? "默认模型";
  const thinkingLabel = thinking.find((o) => o.id === draft.thinkingOptionId)?.label ?? "默认";
  const modeLabel = modeOptions.find((o) => o.id === draft.modeId)?.label ?? "默认模式";
  return [
    {
      key: "provider",
      label: draft.provider || "选择 Agent",
      options: providerOptions,
      selectedId: draft.provider,
      locked: false,
      hidden: false,
    },
    {
      key: "model",
      label: modelLabel,
      options: modelOptions,
      selectedId: draft.modelId,
      locked: false,
      hidden: false,
    },
    {
      key: "thinking",
      label: thinkingLabel,
      options: thinking.map((o) => ({ id: o.id, label: o.label, description: o.description })),
      selectedId: draft.thinkingOptionId,
      locked: false,
      hidden: thinking.length === 0,
    },
    {
      key: "mode",
      label: modeLabel,
      options: modeOptions,
      selectedId: draft.modeId,
      locked: false,
      hidden: false,
    },
  ];
}

/** 会话态 pill 视图（provider 锁定；model/thinking/mode 修改即发 set_* RPC）。 */
export function sessionPillViews(
  snapshot: AgentSnapshot,
  catalog: ComposerCatalog,
): PillView[] {
  const s = sessionPillState(snapshot, catalog);
  const modelOptions = catalog.models.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    description: m.description,
  }));
  const modeOptions = s.modes.map((m) => ({
    id: m.id,
    label: m.label || m.id,
    description: m.description,
  }));
  return [
    {
      key: "provider",
      label: s.provider,
      options: [],
      selectedId: s.provider,
      locked: true,
      hidden: false,
    },
    {
      key: "model",
      label: modelOptions.find((o) => o.id === s.modelId)?.label ?? (s.modelId || "默认模型"),
      options: modelOptions,
      selectedId: s.modelId,
      locked: false,
      hidden: false,
    },
    {
      key: "thinking",
      label:
        s.thinkingOptions.find((o) => o.id === s.thinkingOptionId)?.label ??
        (s.thinkingOptionId || "默认"),
      options: s.thinkingOptions.map((o) => ({
        id: o.id,
        label: o.label,
        description: o.description,
      })),
      selectedId: s.thinkingOptionId,
      locked: false,
      hidden: s.thinkingOptions.length === 0,
    },
    {
      key: "mode",
      label: modeOptions.find((o) => o.id === s.modeId)?.label ?? (s.modeId || "默认模式"),
      options: modeOptions,
      selectedId: s.modeId,
      locked: false,
      hidden: false,
    },
  ];
}

/** 会话态选择 → 需要发送的 set_* 动作（provider 不可改；同值选择返回 null）。 */
export function sessionSelectionAction(
  snapshot: AgentSnapshot,
  catalog: ComposerCatalog,
  pill: ComposerPill,
  value: string,
):
  | { kind: "mode"; modeId: string }
  | { kind: "model"; modelId: string | null }
  | { kind: "thinking"; thinkingOptionId: string | null }
  | null {
  if (pill === "provider") return null;
  const s = sessionPillState(snapshot, catalog);
  if (pill === "mode") {
    if (!value || value === s.modeId) return null;
    return { kind: "mode", modeId: value };
  }
  if (pill === "model") {
    if (value === s.modelId) return null;
    return { kind: "model", modelId: value || null };
  }
  if (value === s.thinkingOptionId) return null;
  return { kind: "thinking", thinkingOptionId: value || null };
}

/**
 * 草稿 → create_agent config 装配（空值省略：协议字段全 optional，
 * 省略 = provider/daemon 默认，与 app resolve-agent-form 一致）。
 */
export function draftToCreateConfig(draft: ComposerDraft, cwd: string, workspaceId?: string) {
  return {
    provider: draft.provider,
    cwd,
    ...(draft.modelId ? { model: draft.modelId } : {}),
    ...(draft.modeId ? { modeId: draft.modeId } : {}),
    ...(draft.thinkingOptionId ? { thinkingOptionId: draft.thinkingOptionId } : {}),
    ...(workspaceId ? { workspaceId } : {}),
  };
}
