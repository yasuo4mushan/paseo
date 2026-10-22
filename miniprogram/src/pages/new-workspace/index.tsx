/**
 * 新建工作区页（t18，P1 最小可用）：
 * - 注册本机目录（open_project_request）：daemon 所在机器上已存在的项目目录
 *   → 返回工作区并自动选中（app new-workspace 的"本地目录"路径）。
 * - GitHub clone（project.github.clone.request）：owner/name 或完整 URL →
 *   clone 到目标目录 → openProject(checkoutPath) 建工作区。
 *
 * worktree/fork 隔离与 setup 终端反馈仍是桌面端能力（见 parity-matrix t19 注记）。
 */

import { useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Input, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { WorkspaceDescriptor } from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { workspaceStore } from "@/stores/workspace-store";
import "./index.css";

type Mode = "directory" | "github";

/** repo 输入归一：owner/name 或 https://github.com/owner/name.git → owner/name。 */
export function normalizeRepoInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(trimmed)) return trimmed;
  const urlMatch = trimmed.match(/github\.com[/:]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i);
  if (urlMatch) return urlMatch[1];
  return null;
}

export default function NewWorkspacePage() {
  const themeClass = useThemeClass();
  const [mode, setMode] = useState<Mode>("directory");
  const [cwd, setCwd] = useState("");
  const [repo, setRepo] = useState("");
  const [targetDir, setTargetDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const finish = (workspace: WorkspaceDescriptor) => {
    workspaceStore.select(workspace);
    Taro.showToast({ title: "工作区已就绪", icon: "success" });
    setTimeout(() => Taro.navigateBack(), 600);
  };

  const registerDirectory = async () => {
    const path = cwd.trim();
    if (!path.startsWith("/")) {
      setError("请输入设备上的绝对路径（以 / 开头）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const workspace = await connectionManager.requireConnection().openProject(path);
      finish(workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const cloneGithub = async () => {
    const normalized = normalizeRepoInput(repo);
    if (!normalized) {
      setError("仓库格式应为 owner/name 或 GitHub URL");
      return;
    }
    const target = targetDir.trim();
    if (!target.startsWith("/")) {
      setError("请输入 clone 目标父目录（绝对路径）");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const conn = connectionManager.requireConnection();
      Taro.showToast({ title: "clone 进行中…", icon: "none", duration: 60_000 });
      const { checkoutPath } = await conn.cloneGithubProject({
        repo: normalized,
        targetDirectory: target,
        cloneProtocol: "https",
      });
      const workspace = await conn.openProject(checkoutPath);
      finish(workspace);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View className={`page new-ws-page ${themeClass}`}>
      <View className="chips">
        <View
          className={`chip ${mode === "directory" ? "chip-active" : ""}`}
          onClick={() => setMode("directory")}
        >
          注册本机目录
        </View>
        <View
          className={`chip ${mode === "github" ? "chip-active" : ""}`}
          onClick={() => setMode("github")}
        >
          GitHub 克隆
        </View>
      </View>

      {mode === "directory" ? (
        <View className="card">
          <View className="field-label">项目目录（设备上的绝对路径）</View>
          <Input
            className="field-input num"
            value={cwd}
            onInput={(e) => setCwd(e.detail.value)}
            placeholder="/Users/you/projects/my-app"
          />
          <View className="faint ws-note">
            目录必须已存在于 daemon 所在设备；注册后即成为可选中工作区（与 app
            的本地目录路径一致）。
          </View>
          <Button className="btn btn-block" disabled={busy} onClick={() => void registerDirectory()}>
            {busy ? "注册中…" : "注册为工作区"}
          </Button>
        </View>
      ) : (
        <View className="card">
          <View className="field-label">GitHub 仓库</View>
          <Input
            className="field-input num"
            value={repo}
            onInput={(e) => setRepo(e.detail.value)}
            placeholder="owner/name 或 https://github.com/owner/name"
          />
          <View className="field-label">目标父目录（设备上的绝对路径）</View>
          <Input
            className="field-input num"
            value={targetDir}
            onInput={(e) => setTargetDir(e.detail.value)}
            placeholder="/Users/you/projects"
          />
          <View className="faint ws-note">
            私有仓库需设备上已配置 GitHub 凭据；clone 在设备侧执行，大仓库可能耗时数分钟。
          </View>
          <Button className="btn btn-block" disabled={busy} onClick={() => void cloneGithub()}>
            {busy ? "克隆中…" : "克隆并注册"}
          </Button>
        </View>
      )}

      {error ? <View className="error-inline">{error}</View> : null}
      <PermissionOverlay />
    </View>
  );
}
