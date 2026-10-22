/**
 * 创建 Agent 会话（t16）：
 * 选择项目/工作区 → provider（daemon 可用目录）→ model（目录 RPC，可无）→
 * mode（provider modes，可无）→ 任务输入 → create_agent_request → 进详情页。
 */

import { useCallback, useEffect, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Picker, Textarea, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type {
  ProviderAvailability,
  ProviderMode,
  WorkspaceDescriptor,
} from "@/connection/protocol-types";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { PermissionOverlay } from "@/components/permission-overlay";
import { WorkspacePicker } from "@/components/workspace-picker";
import {
  hasErrors,
  providerDisabledReason,
  validateCreateForm,
  type CreateFormErrors,
} from "./validate";
import "./index.css";

/** 订阅工作区选择（不用 useSyncExternalStore：Taro reconciler 下订阅更新不可靠）。 */
function useWorkspaceSelection(): WorkspaceSelection | null {
  const [selection, setSelection] = useState<WorkspaceSelection | null>(() =>
    workspaceStore.getSnapshot(),
  );
  useEffect(() => workspaceStore.subscribe(() => setSelection(workspaceStore.getSnapshot())), []);
  return selection;
}

export default function CreateAgentPage() {
  const workspace = useWorkspaceSelection();
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null);
  const [provider, setProvider] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [modelIndex, setModelIndex] = useState(0);
  const [modes, setModes] = useState<ProviderMode[]>([]);
  const [modeId, setModeId] = useState("");
  const [prompt, setPrompt] = useState("");
  const [pickerVisible, setPickerVisible] = useState(false);
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<CreateFormErrors>({});
  const [fatal, setFatal] = useState("");

  // 进入页面即恢复已选工作区并拉取可用 provider
  useEffect(() => {
    workspaceStore.restore();
    const conn = connectionManager.getConnection();
    if (!conn) {
      setFatal("未连接设备，请返回重连");
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const list = await conn.listAvailableProviders();
        if (disposed) return;
        const available = list.filter((p) => p.available);
        setProviders(list);
        if (available.length > 0) setProvider((prev) => prev || available[0].provider);
      } catch (err) {
        if (!disposed) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // provider 变化 → 拉模型目录与模式
  useEffect(() => {
    if (!provider) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    setLoadingCatalog(true);
    setModels([]);
    setModelIndex(0);
    setModes([]);
    setModeId("");
    void (async () => {
      try {
        const [modelList, modeList] = await Promise.all([
          conn.listProviderModels(provider, workspace?.directory).catch(() => []),
          conn.listProviderModes(provider, workspace?.directory).catch(() => []),
        ]);
        if (disposed) return;
        const labels = modelList.map((m) => m.label || m.id);
        setModels(labels);
        const defaultIndex = modelList.findIndex((m) => m.isDefault);
        setModelIndex(defaultIndex >= 0 ? defaultIndex : 0);
        setModes(modeList);
        if (modeList.length > 0) setModeId(modeList[0].id);
      } finally {
        if (!disposed) setLoadingCatalog(false);
      }
    })();
    return () => {
      disposed = true;
    };
  }, [provider, workspace?.directory]);

  const onWorkspaceSelected = useCallback((ws: WorkspaceDescriptor) => {
    workspaceStore.select(ws);
  }, []);

  const submit = async () => {
    if (submitting || !workspace) return;
    const nextErrors = validateCreateForm({ workspace, provider, prompt });
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    setSubmitting(true);
    try {
      const conn = connectionManager.requireConnection();
      const agent = await conn.createAgent({
        provider,
        cwd: workspace.directory,
        ...(models.length > 0 ? { model: models[modelIndex] } : {}),
        ...(modeId ? { modeId } : {}),
        workspaceId: workspace.workspaceId,
        initialPrompt: prompt.trim(),
      });
      Taro.redirectTo({ url: `/pages/agent/index?id=${encodeURIComponent(agent.id)}` });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  if (fatal) {
    return (
      <View className="page">
        <View className="card empty">
          <View className="empty-icon">⚠️</View>
          <View className="empty-title">无法创建</View>
          <View className="empty-desc">{fatal}</View>
          <Button className="btn btn-mini btn-ghost" onClick={() => Taro.navigateBack()}>
            返回
          </Button>
        </View>
        <PermissionOverlay />
      </View>
    );
  }

  return (
    <View className="page create-page">
      <View className="card">
        <View className="field-label">项目 / 工作区</View>
        <View className="ws-select" onClick={() => setPickerVisible(true)}>
          <View className={`ws-select-text ${workspace ? "" : "ws-select-placeholder"}`}>
            {workspace?.label ?? "选择目标工作区"}
          </View>
          <View className="ws-bar-arrow">▾</View>
        </View>
        {errors.workspace ? <View className="field-error">{errors.workspace}</View> : null}
      </View>

      <View className="card">
        <View className="field-label">Agent 类型（provider）</View>
        {providers === null ? (
          <View className="loading-tip">读取可用 provider…</View>
        ) : (
          <View className="chip-row">
            {providers.map((item) => {
              const disabled = providerDisabledReason(item);
              return (
                <View
                  key={item.provider}
                  className={`chip ${provider === item.provider ? "chip-active" : ""} ${
                    disabled ? "chip-disabled" : ""
                  }`}
                  onClick={() => {
                    if (!disabled) setProvider(item.provider);
                  }}
                >
                  {item.provider}
                </View>
              );
            })}
          </View>
        )}
        {errors.provider ? <View className="field-error">{errors.provider}</View> : null}
      </View>

      <View className="card">
        <View className="field-label">模型</View>
        {loadingCatalog ? (
          <View className="loading-tip">读取模型目录…</View>
        ) : models.length > 0 ? (
          <Picker
            mode="selector"
            range={models}
            value={modelIndex}
            onChange={(e) => setModelIndex(Number(e.detail.value))}
          >
            <View className="picker-value">
              <View className="picker-text">{models[modelIndex]}</View>
              <View className="ws-bar-arrow">▾</View>
            </View>
          </Picker>
        ) : (
          <View className="muted">使用 provider 默认模型</View>
        )}

        {modes.length > 0 ? (
          <View>
            <View className="field-label mode-label">模式</View>
            <View className="chip-row">
              {modes.map((mode) => (
                <View
                  key={mode.id}
                  className={`chip ${modeId === mode.id ? "chip-active" : ""}`}
                  onClick={() => setModeId(mode.id)}
                >
                  {mode.label}
                </View>
              ))}
            </View>
          </View>
        ) : null}
      </View>

      <View className="card">
        <View className="field-label">任务指令</View>
        <Textarea
          className="prompt-input"
          value={prompt}
          onInput={(e) => setPrompt(e.detail.value)}
          placeholder="例如：帮我在这个仓库里定位登录超时的原因并给出修复方案"
          placeholderClass="prompt-placeholder"
          maxlength={4000}
          autoHeight
          disabled={submitting}
        />
        {errors.prompt ? <View className="field-error">{errors.prompt}</View> : null}
      </View>

      <Button
        className="btn btn-block"
        disabled={submitting}
        loading={submitting}
        onClick={() => void submit()}
      >
        {submitting ? "创建中…" : "创建并进入会话"}
      </Button>
      <View className="footer-note">创建会真实启动一个 agent 并消耗模型配额</View>

      <WorkspacePicker
        visible={pickerVisible}
        selectedId={workspace?.workspaceId ?? null}
        onClose={() => setPickerVisible(false)}
        onSelect={onWorkspaceSelected}
      />
      <PermissionOverlay />
    </View>
  );
}
