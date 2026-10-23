/**
 * 定时任务页（t18）：列表 / 创建 / 暂停恢复 / 手动触发 / 执行记录 / 删除。
 *
 * RPC：schedule/list、schedule/create、schedule/pause|resume、schedule/run-once、
 * schedule/logs、schedule/delete（vendor 自 protocol/schedule/rpc-schemas.ts）。
 * 目标两档：已有 agent（picker）或新建 agent（provider + 当前工作区目录）。
 */

import { useCallback, useEffect, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, Input, Textarea, View, Image } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { MODAL_DANGER_COLOR } from "@/constants/colors";
import type {
  AgentSnapshot,
  ProviderAvailability,
  ScheduleRun,
  ScheduleSummary,
} from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { iconUrl } from "@/utils/icons";
import { workspaceStore } from "@/stores/workspace-store";
import {
  CADENCE_PRESETS,
  CUSTOM_CRON_PRESET_ID,
  cadenceLabel,
  promptPreview,
  scheduleRunStatusText,
  scheduleStatusText,
  validateCronExpression,
} from "@/utils/schedule";
import { formatDateTime } from "@/utils/time";
import "./index.css";

type CadenceChoice = string; // preset id 或 custom

interface CreateFormState {
  prompt: string;
  name: string;
  presetId: CadenceChoice;
  customCron: string;
  targetMode: "agent" | "new-agent";
  agentId: string;
  provider: string;
  maxRunsEnabled: boolean;
  runOnCreate: boolean;
}

const INITIAL_FORM: CreateFormState = {
  prompt: "",
  name: "",
  presetId: "daily-9",
  customCron: "",
  targetMode: "agent",
  agentId: "",
  provider: "",
  maxRunsEnabled: false,
  runOnCreate: false,
};

export default function SchedulesPage() {
  const themeClass = useThemeClass();
  const [schedules, setSchedules] = useState<ScheduleSummary[]>([]);
  const [agents, setAgents] = useState<AgentSnapshot[]>([]);
  const [providers, setProviders] = useState<ProviderAvailability[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [formVisible, setFormVisible] = useState(false);
  const [form, setForm] = useState<CreateFormState>(INITIAL_FORM);
  const [creating, setCreating] = useState(false);
  /** 展开执行记录的 scheduleId → runs。 */
  const [runsBySchedule, setRunsBySchedule] = useState<Record<string, ScheduleRun[]>>({});
  const [busyId, setBusyId] = useState("");

  const refresh = useCallback(async () => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    setLoading(true);
    try {
      const [scheduleList, agentList] = await Promise.all([
        conn.listSchedules(),
        conn.fetchAgents(),
      ]);
      setSchedules(scheduleList);
      setAgents(agentList.filter((a) => !a.archivedAt));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const openForm = async () => {
    setForm({ ...INITIAL_FORM, agentId: agents[0]?.id ?? "" });
    setFormVisible(true);
    if (providers.length === 0) {
      try {
        const list = await connectionManager.requireConnection().listAvailableProviders();
        setProviders(list.filter((p) => p.available));
      } catch {
        // provider 目录拉取失败：新建 agent 档不可用，仍可绑定已有 agent
      }
    }
  };

  const submit = async () => {
    if (creating) return;
    const prompt = form.prompt.trim();
    if (!prompt) {
      Taro.showToast({ title: "请填写 prompt", icon: "none" });
      return;
    }
    let cadence;
    if (form.presetId === CUSTOM_CRON_PRESET_ID) {
      const cronError = validateCronExpression(form.customCron);
      if (cronError) {
        Taro.showToast({ title: cronError, icon: "none" });
        return;
      }
      cadence = { type: "cron" as const, expression: form.customCron.trim() };
    } else {
      const preset = CADENCE_PRESETS.find((p) => p.id === form.presetId);
      if (!preset) return;
      cadence = { type: "cron" as const, expression: preset.expression };
    }
    if (form.targetMode === "agent" && !form.agentId) {
      Taro.showToast({ title: "请选择要绑定的 agent", icon: "none" });
      return;
    }
    if (form.targetMode === "new-agent" && !form.provider) {
      Taro.showToast({ title: "请选择 provider", icon: "none" });
      return;
    }
    setCreating(true);
    try {
      const conn = connectionManager.requireConnection();
      const workspace = workspaceStore.getSnapshot();
      await conn.createSchedule({
        prompt,
        cadence,
        ...(form.name.trim() ? { name: form.name.trim() } : {}),
        target:
          form.targetMode === "agent"
            ? { type: "agent", agentId: form.agentId }
            : {
                type: "new-agent",
                config: {
                  provider: form.provider,
                  cwd: workspace?.directory ?? agents[0]?.cwd ?? "",
                },
              },
        ...(form.maxRunsEnabled ? { maxRuns: 1 } : {}),
        ...(form.runOnCreate ? { runOnCreate: true } : {}),
      });
      setFormVisible(false);
      setForm(INITIAL_FORM);
      Taro.showToast({ title: "已创建", icon: "success" });
      await refresh();
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : "创建失败",
        icon: "none",
      });
    } finally {
      setCreating(false);
    }
  };

  const act = async (schedule: ScheduleSummary, action: "pause" | "resume" | "run-once" | "delete") => {
    if (busyId) return;
    if (action === "delete") {
      const { confirm } = await Taro.showModal({
        title: "删除定时任务",
        content: `将删除「${schedule.name ?? promptPreview(schedule.prompt, 20)}」，确定？`,
        confirmText: "删除",
        confirmColor: MODAL_DANGER_COLOR,
      });
      if (!confirm) return;
    }
    setBusyId(schedule.id);
    try {
      const conn = connectionManager.requireConnection();
      if (action === "delete") {
        await conn.deleteSchedule(schedule.id);
        setSchedules((prev) => prev.filter((s) => s.id !== schedule.id));
        Taro.showToast({ title: "已删除", icon: "none" });
        return;
      }
      if (action === "run-once") {
        const updated = await conn.runScheduleOnce(schedule.id);
        setSchedules((prev) =>
          prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)),
        );
        if (updated.runs && updated.runs.length > 0) {
          setRunsBySchedule((prev) => ({ ...prev, [schedule.id]: updated.runs ?? [] }));
        }
        Taro.showToast({ title: "已手动触发", icon: "success" });
        return;
      }
      const updated = await conn.setSchedulePaused(schedule.id, action === "pause");
      setSchedules((prev) => prev.map((s) => (s.id === updated.id ? { ...s, ...updated } : s)));
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : "操作失败",
        icon: "none",
      });
    } finally {
      setBusyId("");
    }
  };

  const toggleRuns = async (schedule: ScheduleSummary) => {
    if (runsBySchedule[schedule.id]) {
      setRunsBySchedule((prev) => {
        const next = { ...prev };
        delete next[schedule.id];
        return next;
      });
      return;
    }
    setBusyId(schedule.id);
    try {
      const runs = await connectionManager.requireConnection().scheduleLogs(schedule.id);
      setRunsBySchedule((prev) => ({ ...prev, [schedule.id]: runs }));
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : "记录读取失败",
        icon: "none",
      });
    } finally {
      setBusyId("");
    }
  };

  const statusPill = (status: ScheduleSummary["status"]) =>
    `sch-pill ${status === "active" ? "sch-pill-active" : status === "paused" ? "sch-pill-paused" : "sch-pill-done"}`;

  return (
    <View className={`page schedules-page ${themeClass}`}>
      {error ? <View className="error-inline">{error}</View> : null}

      {!formVisible ? (
        <Button className="btn btn-block sch-create-btn" onClick={() => void openForm()}>
          新建定时任务
        </Button>
      ) : (
        <View className="card sch-form">
          <View className="sch-form-title">新建定时任务</View>
          <View className="field-label">Prompt（每次执行发给 agent 的指令）</View>
          <Textarea
            className="prompt-input sch-prompt"
            value={form.prompt}
            onInput={(e) => setForm((f) => ({ ...f, prompt: e.detail.value }))}
            placeholder="例如：拉取仓库最新 main，汇总今日提交"
            maxlength={2000}
            autoHeight
          />
          <View className="field-label">名称（可选）</View>
          <Input
            className="field-input"
            value={form.name}
            onInput={(e) => setForm((f) => ({ ...f, name: e.detail.value }))}
            placeholder="例如：每日站会简报"
          />
          <View className="field-label">执行频率</View>
          <View className="chips">
            {[...CADENCE_PRESETS.map((p) => ({ id: p.id, label: p.label })), { id: "custom", label: "自定义" }].map(
              (preset) => (
                <View
                  key={preset.id}
                  className={`chip ${form.presetId === preset.id ? "chip-active" : ""}`}
                  onClick={() => setForm((f) => ({ ...f, presetId: preset.id }))}
                >
                  {preset.label}
                </View>
              ),
            )}
          </View>
          {form.presetId === CUSTOM_CRON_PRESET_ID ? (
            <Input
              className="field-input num sch-cron-input"
              value={form.customCron}
              onInput={(e) => setForm((f) => ({ ...f, customCron: e.detail.value }))}
              placeholder="* * * * *（分 时 日 月 周）"
            />
          ) : null}
          <View className="field-label">执行目标</View>
          <View className="chips">
            <View
              className={`chip ${form.targetMode === "agent" ? "chip-active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, targetMode: "agent" }))}
            >
              已有 Agent
            </View>
            <View
              className={`chip ${form.targetMode === "new-agent" ? "chip-active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, targetMode: "new-agent" }))}
            >
              每次新建 Agent
            </View>
          </View>
          {form.targetMode === "agent" ? (
            agents.length === 0 ? (
              <View className="faint">当前没有可用 agent，先去创建一个。</View>
            ) : (
              <View className="sch-agent-select">
                {agents.slice(0, 8).map((agent) => (
                  <View
                    key={agent.id}
                    className={`sch-agent-row ${form.agentId === agent.id ? "sch-agent-selected" : ""}`}
                    onClick={() => setForm((f) => ({ ...f, agentId: agent.id }))}
                  >
                    <View className="sch-agent-name">{agent.title ?? agent.id.slice(0, 8)}</View>
                    <View className="faint">{agent.provider}</View>
                  </View>
                ))}
              </View>
            )
          ) : (
            <View className="chips">
              {providers.length === 0 ? (
                <View className="faint">无可用 provider</View>
              ) : (
                providers.map((p) => (
                  <View
                    key={p.provider}
                    className={`chip ${form.provider === p.provider ? "chip-active" : ""}`}
                    onClick={() => setForm((f) => ({ ...f, provider: p.provider }))}
                  >
                    {p.provider}
                  </View>
                ))
              )}
            </View>
          )}
          <View className="sch-switches">
            <View className="sch-switch" onClick={() => setForm((f) => ({ ...f, maxRunsEnabled: !f.maxRunsEnabled }))}>
              <View className={`sch-checkbox ${form.maxRunsEnabled ? "sch-checkbox-on" : ""}`}>
                {form.maxRunsEnabled ? <Image className="icon icon-sm" src={iconUrl("check", "-active")} /> : null}
              </View>
              <View>一次性任务（只执行一次）</View>
            </View>
            <View className="sch-switch" onClick={() => setForm((f) => ({ ...f, runOnCreate: !f.runOnCreate }))}>
              <View className={`sch-checkbox ${form.runOnCreate ? "sch-checkbox-on" : ""}`}>
                {form.runOnCreate ? <Image className="icon icon-sm" src={iconUrl("check", "-active")} /> : null}
              </View>
              <View>创建后立即执行一次</View>
            </View>
          </View>
          <View className="sch-form-actions">
            <Button className="btn btn-ghost btn-mini" onClick={() => setFormVisible(false)}>
              取消
            </Button>
            <Button className="btn btn-mini" disabled={creating} onClick={() => void submit()}>
              {creating ? "创建中…" : "创建"}
            </Button>
          </View>
        </View>
      )}

      {schedules.length === 0 && !loading ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("schedule")} />
          <View className="empty-title">暂无定时任务</View>
          <View className="empty-desc">创建后 daemon 会按 cadence 自动触发 agent。</View>
        </View>
      ) : (
        schedules.map((schedule) => (
          <View key={schedule.id} className="card sch-card">
            <View className="sch-head">
              <View className="sch-title">{schedule.name ?? promptPreview(schedule.prompt, 24)}</View>
              <View className={statusPill(schedule.status)}>{scheduleStatusText(schedule.status)}</View>
            </View>
            {schedule.name ? (
              <View className="muted sch-prompt-line">{promptPreview(schedule.prompt)}</View>
            ) : null}
            <View className="sch-meta">
              <View className="faint">{cadenceLabel(schedule.cadence)}</View>
              {schedule.target.type !== "new-agent" ? (
                <View className="faint">绑定 Agent</View>
              ) : (
                <View className="faint">每次新建（{schedule.target.config.provider}）</View>
              )}
              {schedule.nextRunAt ? (
                <View className="faint">下次 {formatDateTime(schedule.nextRunAt)}</View>
              ) : null}
              {schedule.lastRunAt ? (
                <View className="faint">上次 {formatDateTime(schedule.lastRunAt)}</View>
              ) : null}
            </View>
            <View className="sch-actions">
              <Button
                className="btn btn-mini btn-ghost"
                disabled={busyId === schedule.id}
                onClick={() => void act(schedule, "run-once")}
              >
                立即执行
              </Button>
              {schedule.status === "active" ? (
                <Button
                  className="btn btn-mini btn-ghost"
                  disabled={busyId === schedule.id}
                  onClick={() => void act(schedule, "pause")}
                >
                  暂停
                </Button>
              ) : schedule.status === "paused" ? (
                <Button
                  className="btn btn-mini btn-ghost"
                  disabled={busyId === schedule.id}
                  onClick={() => void act(schedule, "resume")}
                >
                  恢复
                </Button>
              ) : null}
              <Button
                className="btn btn-mini btn-ghost"
                disabled={busyId === schedule.id}
                onClick={() => void toggleRuns(schedule)}
              >
                {runsBySchedule[schedule.id] ? "收起记录" : "执行记录"}
              </Button>
              <Button
                className="btn btn-mini btn-danger"
                disabled={busyId === schedule.id}
                onClick={() => void act(schedule, "delete")}
              >
                删除
              </Button>
            </View>
            {runsBySchedule[schedule.id] ? (
              <View className="sch-runs">
                {runsBySchedule[schedule.id].length === 0 ? (
                  <View className="faint">还没有执行记录</View>
                ) : (
                  runsBySchedule[schedule.id]
                    .slice()
                    .reverse()
                    .map((run) => (
                      <View key={run.id} className="sch-run-row">
                        <View className={`sch-run-status sch-run-${run.status}`}>
                          {scheduleRunStatusText(run.status)}
                        </View>
                        <View className="sch-run-main">
                          <View className="sch-run-time num">
                            {formatDateTime(run.startedAt || run.scheduledFor)}
                          </View>
                          {run.error ? <View className="sch-run-error">{run.error}</View> : null}
                        </View>
                      </View>
                    ))
                )}
              </View>
            ) : null}
          </View>
        ))
      )}
      <PermissionOverlay />
    </View>
  );
}
