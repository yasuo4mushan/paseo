/**
 * 工作区脚本页（t18，P2）：package.json scripts 目录 + 启停触发。
 *
 * RPC：workspace.script.list/start/stop.request（vendor 自 messages.ts）。
 * 脚本输出走终端流（terminalId → TerminalStream 二进制帧），小程序端渲染面
 * 属 t19 范围：这里只做"触发运行 + 生命周期/健康状态"，输出查看标注未接。
 */

import { useCallback, useEffect, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { WorkspaceScriptInfo } from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { workspaceStore } from "@/stores/workspace-store";
import "./index.css";

function proxyHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export default function ScriptsPage() {
  const themeClass = useThemeClass();
  const [scripts, setScripts] = useState<WorkspaceScriptInfo[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [hasWorkspace, setHasWorkspace] = useState(true);

  const refresh = useCallback(async () => {
    const conn = connectionManager.getConnection();
    if (!conn) return;
    const workspace = workspaceStore.getSnapshot();
    if (!workspace) {
      setHasWorkspace(false);
      return;
    }
    setHasWorkspace(true);
    try {
      setScripts(await conn.listWorkspaceScripts(workspace.workspaceId));
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    workspaceStore.restore();
    void refresh();
  }, [refresh]);

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const act = async (script: WorkspaceScriptInfo, action: "start" | "stop") => {
    if (busy) return;
    setBusy(script.scriptName);
    try {
      const workspace = workspaceStore.getSnapshot();
      if (!workspace) return;
      const updated = await connectionManager
        .requireConnection()
        .workspaceScriptAction(action, workspace.workspaceId, script.scriptName);
      if (updated) {
        setScripts((prev) =>
          prev.map((s) => (s.scriptName === updated.scriptName ? { ...s, ...updated } : s)),
        );
      } else {
        await refresh();
      }
      Taro.showToast({ title: action === "start" ? "已触发" : "已停止", icon: "none" });
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : "操作失败",
        icon: "none",
      });
    } finally {
      setBusy("");
    }
  };

  return (
    <View className={`page scripts-page ${themeClass}`}>
      {error ? <View className="error-inline">{error}</View> : null}
      {!hasWorkspace ? (
        <View className="card empty">
          <View className="empty-icon">📦</View>
          <View className="empty-title">未选择工作区</View>
          <View className="empty-desc">先在会话页顶部选择一个工作区。</View>
        </View>
      ) : scripts.length === 0 ? (
        <View className="card empty">
          <View className="empty-icon">🧰</View>
          <View className="empty-title">无工作区脚本</View>
          <View className="empty-desc">
            该工作区 package.json 未定义 scripts（service 脚本由 daemon 目录发现）。
          </View>
        </View>
      ) : (
        scripts.map((script) => (
          <View key={script.scriptName} className="card script-card">
            <View className="script-head">
              <View className="script-name num">{script.scriptName}</View>
              <View
                className={`script-pill ${
                  script.lifecycle === "running"
                    ? script.health === "unhealthy"
                      ? "script-pill-bad"
                      : "script-pill-ok"
                    : ""
                }`}
              >
                {script.lifecycle === "running"
                  ? script.health === "unhealthy"
                    ? "运行中·异常"
                    : "运行中"
                  : "已停止"}
              </View>
            </View>
            <View className="script-meta">
              {script.publicProxyUrl ? (
                <View className="faint num">公网 {proxyHost(script.publicProxyUrl)}</View>
              ) : script.proxyUrl ? (
                <View className="faint num">本地 {proxyHost(script.proxyUrl)}</View>
              ) : null}
              {script.exitCode !== null && script.lifecycle === "stopped" ? (
                <View className="faint num">退出码 {script.exitCode}</View>
              ) : null}
            </View>
            <View className="script-actions">
              {script.lifecycle === "running" ? (
                <Button
                  className="btn btn-mini btn-ghost"
                  disabled={busy === script.scriptName}
                  onClick={() => void act(script, "stop")}
                >
                  停止
                </Button>
              ) : (
                <Button
                  className="btn btn-mini"
                  disabled={busy === script.scriptName}
                  onClick={() => void act(script, "start")}
                >
                  运行
                </Button>
              )}
            </View>
          </View>
        ))
      )}
      <View className="faint script-note">
        脚本输出经终端流二进制帧下发，小程序渲染面待 t18 后续批次（当前仅状态）。
      </View>
      <PermissionOverlay />
    </View>
  );
}
