/**
 * 创建 Agent 向导（t24 重构：级联分步向导；t16 原单页表单 + t18 导入 tab）。
 *
 * 步骤链（每步数据依赖前一步，改选上游清空下游——wizard-model 纯函数）：
 *   ① 设备（默认自动选中当前已连接设备，可换）→ ② 项目文件夹（设备文件系统
 *   逐级浏览/新建，folder-picker）→ ③ Agent 框架（该 daemon 的 provider 目录）→
 *   ④ 模型（该 provider 目录）→ ⑤ thinking effort（所选模型 thinkingOptions）。
 * 审批模式不进向导：独立设置，沿用 t20 composer 的 mode pill 会话中切换。
 *
 * 已选步骤顶部为可回点的面包屑（回看/改选；改选触发级联清空）。
 * 第②步选择确认 = 绝对路径 + 名称 → 提交时 open_project 注册为工作区再
 * create_agent（与 t18 new-workspace 页同一路径）。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, Picker, Textarea, View, Image } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type {
  ProviderAvailability,
  ProviderModelDefinition,
  RecentProviderSession,
} from "@/connection/protocol-types";
import { hasSession, hub, hubErrorMessage, isAuthExpired } from "@/hub/hub-client";
import type { HubDevice } from "@/hub/hub-types";
import { workspaceStore, type WorkspaceSelection } from "@/stores/workspace-store";
import { PermissionOverlay } from "@/components/permission-overlay";
import { FolderPicker } from "@/components/folder-picker";
import { useThemeClass } from "@/hooks/use-theme";
import { formatRelativeTime } from "@/utils/time";
import { iconUrl } from "@/utils/icons";
import { safeNavigateTo, safeNavigateBack } from "@/utils/navigation";
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
  stepIndex,
  stepReachable,
  stepSummary,
  STEP_TITLES,
  WIZARD_STEPS,
  type WizardState,
} from "./wizard-model";
import { hasErrors, providerDisabledReason, validateCreateForm } from "./validate";
import "./index.css";

type PageTab = "create" | "import";

/** 订阅工作区选择（不用 useSyncExternalStore：Taro reconciler 下订阅更新不可靠）。 */
function useWorkspaceSelection(): WorkspaceSelection | null {
  const [selection, setSelection] = useState<WorkspaceSelection | null>(() =>
    workspaceStore.getSnapshot(),
  );
  useEffect(() => workspaceStore.subscribe(() => setSelection(workspaceStore.getSnapshot())), []);
  return selection;
}

/** 连接状态（向导设备步与提交按钮依赖）。 */
function useConnectionState() {
  const [state, setState] = useState(() => connectionManager.getState());
  useEffect(() => connectionManager.subscribe(() => setState(connectionManager.getState())), []);
  return state;
}

/** t20 同款：模型默认 thinking 档（defaultThinkingOptionId > isDefault > 首项）。 */
export function defaultThinkingFor(model: ProviderModelDefinition | undefined): string {
  const thinking =
    model?.thinkingOptions?.find((o) => o.id === model.defaultThinkingOptionId) ??
    model?.thinkingOptions?.find((o) => o.isDefault) ??
    model?.thinkingOptions?.[0];
  return thinking?.id ?? "";
}

export default function CreateAgentPage() {
  const themeClass = useThemeClass();
  const workspace = useWorkspaceSelection();
  const connectionState = useConnectionState();
  const activeDevice = connectionManager.getActiveDevice();
  const connected = connectionState.status === "connected";

  const [tab, setTab] = useState<PageTab>("create");

  // ---- 向导状态（级联规则见 wizard-model） ----
  const [wizard, setWizard] = useState<WizardState>(() =>
    initialWizardState(connectionManager.getActiveDevice()?.deviceId),
  );
  // 第②步 folder-picker 浏览位置（回点不重置）
  const [pickerTrail, setPickerTrail] = useState<string[] | undefined>(undefined);
  const [pickerRootLabel, setPickerRootLabel] = useState("/");

  // 设备步数据
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [devicesError, setDevicesError] = useState("");
  const [connectingId, setConnectingId] = useState("");
  const connectingRef = useRef(false);

  // 框架/模型目录
  const [providers, setProviders] = useState<ProviderAvailability[] | null>(null);
  const [models, setModels] = useState<ProviderModelDefinition[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // 提交
  const [prompt, setPrompt] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [fatal, setFatal] = useState("");
  const [errors, setErrors] = useState<{ prompt?: string }>({});
  // t19：worktree 隔离（高级选项，折叠在末步）
  const [worktreeEnabled, setWorktreeEnabled] = useState(false);
  const [worktreeBranch, setWorktreeBranch] = useState("");

  // t18 导入 tab 状态
  const [sessions, setSessions] = useState<RecentProviderSession[] | null>(null);
  const [importingId, setImportingId] = useState("");
  const [importError, setImportError] = useState("");

  // ---- 初始化：恢复工作区 + 拉设备列表 ----
  useEffect(() => {
    workspaceStore.restore();
    if (!hasSession()) {
      setDevicesError("未登录，无法列出设备");
      return;
    }
    let disposed = false;
    void (async () => {
      try {
        const list = await hub.devices();
        if (!disposed) {
          setDevices(list);
          setDevicesError("");
        }
      } catch (err) {
        if (disposed) return;
        if (isAuthExpired(err)) {
          setDevicesError("登录已过期，请重新登录");
          return;
        }
        setDevicesError(hubErrorMessage(err));
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  // ---- 已连接 daemon → 拉 provider 目录（换设备后重拉） ----
  useEffect(() => {
    if (!connected || tab !== "create") return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    void (async () => {
      try {
        const list = await conn.listAvailableProviders();
        if (disposed) return;
        setProviders(list);
        // 便利预选：首个可用 provider（不移动步骤，用户仍可改）
        setWizard((prev) => {
          if (prev.provider) {
            const still = list.find((p) => p.provider === prev.provider && p.available);
            return still ? prev : { ...prev, provider: "", modelId: "", thinkingOptionId: "" };
          }
          const first = list.find((p) => p.available);
          return first ? { ...prev, provider: first.provider } : prev;
        });
      } catch (err) {
        if (!disposed) setFatal(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [connected, tab]);

  // ---- provider + 文件夹 → 模型目录（级联：换任一即重拉） ----
  const catalogKey = `${wizard.provider}\u0000${wizard.folder?.path ?? ""}`;
  useEffect(() => {
    const provider = wizard.provider;
    const folderPath = wizard.folder?.path;
    if (!provider || !folderPath) return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    setCatalogLoading(true);
    setModels([]);
    void (async () => {
      try {
        const modelList = await conn.listProviderModels(provider, folderPath).catch(() => []);
        if (disposed) return;
        setModels(modelList);
        // 便利预选：默认模型 + 其默认 thinking 档（不移动步骤）
        setWizard((prev) => {
          if (prev.provider !== provider || prev.folder?.path !== folderPath) {
            return prev;
          }
          const fallbackIndex = modelList.findIndex((m) => m.isDefault);
          const index = fallbackIndex >= 0 ? fallbackIndex : 0;
          const model = modelList[index];
          return {
            ...prev,
            modelId: model?.id ?? "",
            thinkingOptionId: defaultThinkingFor(model),
          };
        });
      } finally {
        if (!disposed) setCatalogLoading(false);
      }
    })();
    return () => {
      disposed = true;
    };
    // catalogKey 拆开依赖会重复触发；字符串键精确对齐"provider+文件夹"组合
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogKey]);

  // ---- t18 导入 tab：拉 provider 侧历史会话 ----
  useEffect(() => {
    if (tab !== "import") return;
    const conn = connectionManager.getConnection();
    if (!conn) return;
    let disposed = false;
    void (async () => {
      try {
        const result = await conn.fetchRecentProviderSessions({ limit: 50 });
        if (!disposed) {
          setSessions(result.entries);
          setImportError(
            result.providerErrors.length > 0
              ? `部分 provider 读取失败：${result.providerErrors.map((e) => e.provider).join("、")}`
              : "",
          );
        }
      } catch (err) {
        if (!disposed) {
          setSessions([]);
          setImportError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      disposed = true;
    };
  }, [tab]);

  // ---- 设备步：选择/切换设备（切换 = 真实连接该设备，成功后级联清空下游） ----
  const chooseDevice = async (device: HubDevice) => {
    if (connectingRef.current) return;
    const isActive = connected && activeDevice?.deviceId === device.deviceId;
    if (isActive) {
      setWizard((prev) => selectDevice(prev, device.deviceId));
      return;
    }
    if (!device.online || !device.offer) {
      Taro.showToast({ title: "设备离线，无法选择", icon: "none" });
      return;
    }
    connectingRef.current = true;
    setConnectingId(device.deviceId);
    try {
      await connectionManager.connectOffer(device.offer, {
        deviceId: device.deviceId,
        name: device.name,
      });
      setProviders(null);
      setModels([]);
      setWizard((prev) => selectDevice(prev, device.deviceId));
    } catch (err) {
      Taro.showToast({ title: hubErrorMessage(err), icon: "none" });
    } finally {
      connectingRef.current = false;
      setConnectingId("");
    }
  };

  const refreshDevices = async () => {
    if (!hasSession()) return;
    try {
      const list = await hub.devices();
      setDevices(list);
      setDevicesError("");
    } catch (err) {
      setDevicesError(hubErrorMessage(err));
    }
  };

  // ---- 第②步：文件夹选择（folder-picker 确认 / 当前工作区快捷） ----
  const onFolderSelected = useCallback((folder: { path: string; name: string }) => {
    setWizard((prev) => selectFolder(prev, folder));
  }, []);

  const useCurrentWorkspace = () => {
    if (!workspace) return;
    onFolderSelected({ path: workspace.directory, name: workspace.label });
  };

  // ---- 第⑤步之后的提交 ----
  const selectedModel = models.find((m) => m.id === wizard.modelId);
  const thinkingOptions = selectedModel?.thinkingOptions ?? [];

  const submit = async () => {
    if (submitting) return;
    if (!connected) {
      setFatal("未连接设备，请返回第①步重选");
      return;
    }
    if (!wizard.folder || !wizard.provider) {
      setFatal("请先完成设备/文件夹/框架的选择");
      return;
    }
    const nextErrors = validateCreateForm({
      workspace: {
        workspaceId: "",
        label: wizard.folder.name,
        directory: wizard.folder.path,
      },
      provider: wizard.provider,
      prompt,
    });
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    if (worktreeEnabled && !worktreeBranch.trim()) {
      setFatal("开启 worktree 隔离需要填写新分支名");
      return;
    }
    setSubmitting(true);
    setFatal("");
    try {
      const conn = connectionManager.requireConnection();
      // 文件夹注册为项目工作区（t18 open_project；幂等——已注册目录直接复用）
      const ws = await conn.openProject(wizard.folder.path);
      workspaceStore.select(ws);
      const agent = await conn.createAgent({
        provider: wizard.provider,
        cwd: wizard.folder.path,
        ...(wizard.modelId ? { model: wizard.modelId } : {}),
        ...(wizard.thinkingOptionId ? { thinkingOptionId: wizard.thinkingOptionId } : {}),
        workspaceId: ws.id,
        initialPrompt: prompt.trim(),
        ...(worktreeEnabled
          ? { worktree: { mode: "branch-off" as const, newBranch: worktreeBranch.trim() } }
          : {}),
      });
      Taro.redirectTo({ url: `/pages/agent/index?id=${encodeURIComponent(agent.id)}` });
    } catch (err) {
      setFatal(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const importSession = async (entry: RecentProviderSession) => {
    if (importingId) return;
    setImportingId(entry.providerHandleId);
    setImportError("");
    try {
      const agent = await connectionManager.requireConnection().importAgent({
        provider: entry.providerId,
        providerHandleId: entry.providerHandleId,
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
        ...(workspace ? { workspaceId: workspace.workspaceId } : {}),
      });
      Taro.redirectTo({ url: `/pages/agent/index?id=${encodeURIComponent(agent.id)}` });
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err));
      setImportingId("");
    }
  };

  if (fatal && tab === "create" && !wizard.folder) {
    // 向导早期的致命错误（未连接/未登录）整页提示；提交错误就地展示不整页
    return (
      <View className={`page ${themeClass}`}>
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("warning")} />
          <View className="empty-title">无法创建</View>
          <View className="empty-desc">{fatal}</View>
          <Button className="btn btn-mini btn-ghost" onClick={() => void safeNavigateBack()}>
            返回
          </Button>
        </View>
        <PermissionOverlay />
      </View>
    );
  }

  const nextStep = nextStepOf(wizard.step);

  // 设备步面包屑摘要显示设备名（模型层只存 deviceId；名字从目录/连接态取）
  const deviceLabel =
    devices?.find((d) => d.deviceId === wizard.deviceId)?.name ??
    activeDevice?.name ??
    wizard.deviceId;
  const summaryOf = (step: (typeof WIZARD_STEPS)[number]) =>
    step === "device" ? deviceLabel : stepSummary(wizard, step);

  return (
    <View className={`page create-page ${themeClass}`}>
      <View className="tab-bar">
        <View
          className={`tab-item ${tab === "create" ? "tab-item-active" : ""}`}
          onClick={() => setTab("create")}
        >
          新建会话
        </View>
        <View
          className={`tab-item ${tab === "import" ? "tab-item-active" : ""}`}
          onClick={() => setTab("import")}
        >
          导入已有会话
        </View>
      </View>

      {tab === "create" ? (
        <View>
          {/* 面包屑：已选步骤可回点 */}
          <View className="wiz-crumbs">
            {WIZARD_STEPS.map((step, index) => {
              const reachable = stepReachable(wizard, step);
              const current = wizard.step === step;
              return (
                <View key={step} className="wiz-crumb-item">
                  {index > 0 ? <View className="wiz-crumb-sep">›</View> : null}
                  <View
                    className={`wiz-crumb ${current ? "wiz-crumb-current" : ""} ${
                      reachable ? "" : "wiz-crumb-muted"
                    }`}
                    onClick={() => {
                      if (reachable && !current) setWizard((prev) => goToStep(prev, step));
                    }}
                  >
                    <View className="wiz-crumb-title">{STEP_TITLES[step]}</View>
                    <View className="wiz-crumb-value">{summaryOf(step)}</View>
                  </View>
                </View>
              );
            })}
          </View>

          {/* ① 设备 */}
          {wizard.step === "device" ? (
            <View className="card">
              <View className="field-label">选择设备</View>
              <View className="faint wiz-step-hint">
                默认使用当前已连接设备；换设备会清空后续选择并重新连接。
              </View>
              {devicesError ? (
                <View>
                  <View className="field-error">{devicesError}</View>
                  <Button className="btn btn-mini btn-ghost" onClick={() => void refreshDevices()}>
                    重试
                  </Button>
                </View>
              ) : devices === null ? (
                <View className="loading-tip">读取设备列表…</View>
              ) : devices.length === 0 ? (
                <View className="muted">没有设备。先在设备页添加并连接你的开发机。</View>
              ) : (
                <View className="wiz-device-list">
                  {devices.map((device) => {
                    const isActive = connected && activeDevice?.deviceId === device.deviceId;
                    const busy = connectingId === device.deviceId;
                    return (
                      <View
                        key={device.deviceId}
                        className={`wiz-device ${isActive ? "wiz-device-active" : ""} ${
                          device.online ? "" : "wiz-device-offline"
                        }`}
                        onClick={() => void chooseDevice(device)}
                      >
                        <Image className="icon icon-sm" src={iconUrl("devices")} />
                        <View className="wiz-device-main">
                          <View className="wiz-device-name">{device.name}</View>
                          <View className="faint wiz-device-sub">
                            最后心跳 {formatRelativeTime(device.lastSeenAt)}
                          </View>
                        </View>
                        {busy ? (
                          <View className="pill pill-running">连接中…</View>
                        ) : isActive ? (
                          <View className="pill pill-online">
                            <View className="pill-dot" />
                            已连接
                          </View>
                        ) : (
                          <View className="pill">
                            <View className="pill-dot" />
                            {device.online ? "在线" : "离线"}
                          </View>
                        )}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          {/* ② 项目文件夹 */}
          {wizard.step === "folder" ? (
            <View className="card">
              <View className="field-label">项目文件夹</View>
              {workspace ? (
                <View className="wiz-ws-shortcut" onClick={useCurrentWorkspace}>
                  <Image className="icon icon-sm" src={iconUrl("project")} />
                  <View className="wiz-ws-shortcut-main">
                    <View className="wiz-ws-shortcut-name">使用当前工作区：{workspace.label}</View>
                    <View className="faint num wiz-ws-shortcut-path">{workspace.directory}</View>
                  </View>
                </View>
              ) : null}
              <FolderPicker
                initialTrail={pickerTrail}
                initialRootLabel={pickerRootLabel}
                onSelect={onFolderSelected}
                onTrailChange={(trail, label) => {
                  setPickerTrail(trail);
                  setPickerRootLabel(label);
                }}
              />
            </View>
          ) : null}

          {/* ③ Agent 框架 */}
          {wizard.step === "framework" ? (
            <View className="card">
              <View className="field-label">
                Agent 框架（{activeDevice?.name ?? "设备"} 可用目录）
              </View>
              {providers === null ? (
                <View className="loading-tip">读取可用 provider…</View>
              ) : (
                <View className="chip-row">
                  {providers.map((item) => {
                    const disabled = providerDisabledReason(item);
                    return (
                      <View
                        key={item.provider}
                        className={`chip ${wizard.provider === item.provider ? "chip-active" : ""} ${
                          disabled ? "chip-disabled" : ""
                        }`}
                        onClick={() => {
                          if (!disabled) setWizard((prev) => selectProvider(prev, item.provider));
                        }}
                      >
                        {item.provider}
                      </View>
                    );
                  })}
                </View>
              )}
            </View>
          ) : null}

          {/* ④ 模型 */}
          {wizard.step === "model" ? (
            <View className="card">
              <View className="field-label">模型</View>
              {catalogLoading ? (
                <View className="loading-tip">读取模型目录…</View>
              ) : models.length > 0 ? (
                <Picker
                  mode="selector"
                  range={models.map((m) => m.label || m.id)}
                  value={Math.max(
                    0,
                    models.findIndex((m) => m.id === wizard.modelId),
                  )}
                  onChange={(e) => {
                    const next = Number(e.detail.value);
                    const model = models[next];
                    setWizard((prev) => selectModel(prev, model.id));
                  }}
                >
                  <View className="picker-value">
                    <View className="picker-text">
                      {selectedModel?.label || selectedModel?.id || "默认模型"}
                    </View>
                    <Image className="icon icon-sm ws-bar-arrow" src={iconUrl("chevron-down")} />
                  </View>
                </Picker>
              ) : (
                <View className="muted">该 provider 无模型目录，将使用默认模型</View>
              )}
              {wizard.folder ? (
                <View
                  className="wiz-open-files"
                  onClick={() =>
                    void safeNavigateTo(
                      `/pages/files/index?cwd=${encodeURIComponent(wizard.folder!.path)}`,
                    )
                  }
                >
                  <Image className="icon icon-sm" src={iconUrl("file")} />
                  <View>在文件浏览器中查看此文件夹</View>
                </View>
              ) : null}
            </View>
          ) : null}

          {/* ⑤ thinking + 任务指令 + 提交 */}
          {wizard.step === "effort" ? (
            <View>
              <View className="card">
                <View className="field-label">Thinking effort</View>
                {thinkingOptions.length > 0 ? (
                  <View className="chip-row">
                    {thinkingOptions.map((option) => (
                      <View
                        key={option.id}
                        className={`chip ${
                          wizard.thinkingOptionId === option.id ? "chip-active" : ""
                        }`}
                        onClick={() => setWizard((prev) => selectThinking(prev, option.id))}
                      >
                        {option.label}
                      </View>
                    ))}
                  </View>
                ) : (
                  <View className="muted">所选模型无 thinking 档位，使用 provider 默认</View>
                )}
                <View className="faint wiz-mode-hint">
                  审批模式不在此设置：进入会话后可在输入框上方的模式 pill 切换。
                </View>
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

              {/* t19：worktree 隔离（高级选项） */}
              <View className="card">
                <View className="wt-row" onClick={() => setWorktreeEnabled((v) => !v)}>
                  <View className="wt-main">
                    <View className="field-label">worktree 隔离</View>
                    <View className="muted">
                      在独立 worktree 的新分支上运行，不影响当前工作区（需要 git 仓库）。
                    </View>
                  </View>
                  <View className={`wt-switch ${worktreeEnabled ? "wt-switch-on" : ""}`}>
                    <View className={`wt-knob ${worktreeEnabled ? "wt-knob-on" : ""}`} />
                  </View>
                </View>
                {worktreeEnabled ? (
                  <View className="wt-branch-row">
                    <Input
                      className="wt-branch-input"
                      value={worktreeBranch}
                      onInput={(e) => setWorktreeBranch(e.detail.value)}
                      placeholder="新分支名（如 fix-login-timeout）"
                      placeholderClass="prompt-placeholder"
                      disabled={submitting}
                    />
                  </View>
                ) : null}
              </View>

              {fatal && wizard.folder ? <View className="field-error">{fatal}</View> : null}
              <Button
                className="btn btn-block"
                disabled={submitting}
                loading={submitting}
                onClick={() => void submit()}
              >
                {submitting ? "创建中…" : "创建并进入会话"}
              </Button>
              <View className="footer-note">
                创建会真实启动一个 agent 并消耗模型配额；文件夹 {wizard.folder?.name}{" "}
                将注册为项目工作区
              </View>
            </View>
          ) : null}

          {/* 步骤导航（末步由提交按钮接管） */}
          {wizard.step !== "effort" ? (
            <View className="wiz-nav">
              {stepIndex(wizard.step) > 0 ? (
                <Button
                  className="btn btn-ghost wiz-nav-side"
                  onClick={() =>
                    setWizard((prev) =>
                      goToStep(prev, WIZARD_STEPS[Math.max(0, stepIndex(prev.step) - 1)]),
                    )
                  }
                >
                  上一步
                </Button>
              ) : null}
              <Button
                className="btn wiz-nav-main"
                disabled={!canAdvance(wizard)}
                onClick={() => {
                  const next = nextStepOf(wizard.step);
                  if (next && canAdvance(wizard)) setWizard((prev) => goToStep(prev, next));
                }}
              >
                {nextStep ? `下一步：${STEP_TITLES[nextStep]}` : "完成"}
              </Button>
            </View>
          ) : (
            <View className="wiz-nav">
              <Button
                className="btn btn-ghost wiz-nav-side"
                onClick={() => setWizard((prev) => goToStep(prev, "model"))}
              >
                上一步
              </Button>
            </View>
          )}
        </View>
      ) : (
        <View>
          <View className="card import-hint-card">
            <View className="field-label">Provider 侧历史会话（全部目录）</View>
            {importError ? <View className="field-error">{importError}</View> : null}
            {sessions === null ? (
              <View className="loading-tip">读取 provider 会话目录…</View>
            ) : sessions.length === 0 ? (
              <View className="muted">
                没有可导入的会话。provider 在设备上产生历史会话后，这里会列出。
              </View>
            ) : (
              sessions.map((entry) => (
                <View key={`${entry.providerId}:${entry.providerHandleId}`} className="import-row">
                  <View className="import-provider">{entry.providerLabel}</View>
                  <View className="import-main">
                    <View className="import-title">
                      {entry.title ??
                        entry.lastPromptPreview ??
                        entry.providerHandleId.slice(0, 12)}
                    </View>
                    <View className="faint import-cwd num">{entry.cwd}</View>
                    <View className="faint">{formatRelativeTime(entry.lastActivityAt)}</View>
                  </View>
                  <Button
                    className="btn btn-mini import-btn"
                    disabled={importingId !== ""}
                    onClick={() => void importSession(entry)}
                  >
                    {importingId === entry.providerHandleId ? "导入中…" : "导入"}
                  </Button>
                </View>
              ))
            )}
          </View>
          <View className="footer-note">
            导入即把 provider 本地历史会话接入 aaswitch 管理（import_agent_request）
          </View>
        </View>
      )}

      <PermissionOverlay />
    </View>
  );
}
