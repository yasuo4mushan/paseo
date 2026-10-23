/**
 * 新建工作区页（t18 建立；t31-b 目录输入改为逐级点选）：
 * - 注册本机目录（open_project_request）：folder-picker 在设备文件系统上
 *   逐级浏览/返回/面包屑回点，确认后显示完整路径并注册。手输绝对路径保留为
 *   「高级」折叠项（长路径 / 目录不可浏览时兜底，能力不删）。
 * - GitHub clone（project.github.clone.request）：owner/name 或完整 URL →
 *   目标父目录同样走 folder-picker 点选 → clone → openProject(checkoutPath)。
 *
 * worktree/fork 隔离与 setup 终端反馈仍是桌面端能力（见 parity-matrix t19 注记）。
 */

import { useState } from "react";
import Taro from "@tarojs/taro";
import { Button, Image, Input, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { WorkspaceDescriptor } from "@/connection/protocol-types";
import { FolderPicker, type FolderSelection } from "@/components/folder-picker";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { iconUrl } from "@/utils/icons";
import { workspaceStore } from "@/stores/workspace-store";
import {
  directoryDisplayName,
  directoryPathError,
  effectiveDirectoryPath,
  normalizeRepoInput,
} from "./paths";
import "./index.css";

type Mode = "directory" | "github";

export default function NewWorkspacePage() {
  const themeClass = useThemeClass();
  const [mode, setMode] = useState<Mode>("directory");
  const [repo, setRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // ---- 目录状态（两模式各自一份点选 + 高级手输；浏览位置共享，切模式不重置） ----
  const [dirPick, setDirPick] = useState<FolderSelection | null>(null);
  const [dirManual, setDirManual] = useState("");
  const [dirAdvanced, setDirAdvanced] = useState(false);
  const [targetPick, setTargetPick] = useState<FolderSelection | null>(null);
  const [targetManual, setTargetManual] = useState("");
  const [targetAdvanced, setTargetAdvanced] = useState(false);
  // folder-picker 浏览位置（t24 同款：折叠/切模式重挂载后从上次位置继续）
  const [pickerTrail, setPickerTrail] = useState<string[] | undefined>(undefined);
  const [pickerRootLabel, setPickerRootLabel] = useState("/");

  const dirPath = effectiveDirectoryPath(dirPick, dirAdvanced ? dirManual : "");
  const targetPath = effectiveDirectoryPath(targetPick, targetAdvanced ? targetManual : "");

  const finish = (workspace: WorkspaceDescriptor) => {
    workspaceStore.select(workspace);
    Taro.showToast({ title: "工作区已就绪", icon: "success" });
    setTimeout(() => Taro.navigateBack(), 600);
  };

  const registerDirectory = async () => {
    const invalid = directoryPathError(dirPath, "请先点选项目目录，或展开「高级」手动输入");
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const workspace = await connectionManager.requireConnection().openProject(dirPath);
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
    const invalid = directoryPathError(
      targetPath,
      "请先点选 clone 目标父目录，或展开「高级」手动输入",
    );
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const conn = connectionManager.requireConnection();
      Taro.showToast({ title: "clone 进行中…", icon: "none", duration: 60_000 });
      const { checkoutPath } = await conn.cloneGithubProject({
        repo: normalized,
        targetDirectory: targetPath,
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

  /** 目录输入区（点选面板 / 已选摘要 / 高级手输，互斥展示）。 */
  const renderDirectoryField = (config: {
    pick: FolderSelection | null;
    manual: string;
    advanced: boolean;
    placeholder: string;
    emptyHint: string;
    onPick: (folder: FolderSelection | null) => void;
    onManual: (value: string) => void;
    onAdvanced: (open: boolean) => void;
  }) => {
    const path = effectiveDirectoryPath(config.pick, config.advanced ? config.manual : "");
    return (
      <View>
        {config.advanced ? (
          <View>
            <View className="field-label">目录（设备上的绝对路径）</View>
            <Input
              className="field-input num"
              value={config.manual}
              onInput={(e) => config.onManual(e.detail.value)}
              placeholder={config.placeholder}
            />
            <View className="faint ws-note">
              目录必须已存在于 daemon 所在设备；适用于路径较长或点选不便的场景。
            </View>
          </View>
        ) : config.pick ? (
          <View className="nws-picked">
            <View className="nws-picked-row">
              <Image className="icon icon-sm nws-picked-icon" src={iconUrl("project")} />
              <View className="nws-picked-main">
                <View className="nws-picked-name">
                  {config.pick.name || directoryDisplayName(config.pick.path)}
                </View>
                <View className="faint num nws-picked-path">{config.pick.path}</View>
              </View>
            </View>
            <Button
              className="btn btn-mini btn-ghost nws-picked-change"
              disabled={busy}
              onClick={() => config.onPick(null)}
            >
              重新选择
            </Button>
          </View>
        ) : (
          <FolderPicker
            initialTrail={pickerTrail}
            initialRootLabel={pickerRootLabel}
            onSelect={config.onPick}
            onTrailChange={(trail, label) => {
              setPickerTrail(trail);
              setPickerRootLabel(label);
            }}
          />
        )}

        <View className="nws-adv" onClick={() => config.onAdvanced(!config.advanced)}>
          <View className="nws-adv-label">高级：手动输入路径</View>
          <Image
            className={`icon icon-sm nws-adv-arrow ${config.advanced ? "nws-adv-arrow-open" : ""}`}
            src={iconUrl("chevron-down")}
          />
        </View>
        {config.advanced ? null : <View className="faint nws-adv-hint">{config.emptyHint}</View>}
        {path ? <View className="faint num nws-effective">将使用目录：{path}</View> : null}
      </View>
    );
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
          <View className="field-label">项目目录</View>
          {renderDirectoryField({
            pick: dirPick,
            manual: dirManual,
            advanced: dirAdvanced,
            placeholder: "/Users/you/projects/my-app",
            emptyHint: "在设备目录中逐级点选（可返回上级、点面包屑跳转），然后点「选择此文件夹」。",
            onPick: (folder) => {
              setDirPick(folder);
              setError("");
            },
            onManual: (value) => {
              setDirManual(value);
              setError("");
            },
            onAdvanced: (open) => {
              setDirAdvanced(open);
              setError("");
            },
          })}
          <View className="faint ws-note">
            注册后该目录即成为可选中工作区（与 app 的本地目录路径一致）。
          </View>
          <Button
            className="btn btn-block"
            disabled={busy}
            loading={busy}
            onClick={() => void registerDirectory()}
          >
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
          <View className="field-label nws-target-label">目标父目录</View>
          {renderDirectoryField({
            pick: targetPick,
            manual: targetManual,
            advanced: targetAdvanced,
            placeholder: "/Users/you/projects",
            emptyHint: "点选设备上存放代码的父目录，clone 会在这里创建仓库文件夹。",
            onPick: (folder) => {
              setTargetPick(folder);
              setError("");
            },
            onManual: (value) => {
              setTargetManual(value);
              setError("");
            },
            onAdvanced: (open) => {
              setTargetAdvanced(open);
              setError("");
            },
          })}
          <View className="faint ws-note">
            私有仓库需设备上已配置 GitHub 凭据；clone 在设备侧执行，大仓库可能耗时数分钟。
          </View>
          <Button
            className="btn btn-block"
            disabled={busy}
            loading={busy}
            onClick={() => void cloneGithub()}
          >
            {busy ? "克隆中…" : "克隆并注册"}
          </Button>
        </View>
      )}

      {error ? <View className="error-inline">{error}</View> : null}
      <PermissionOverlay />
    </View>
  );
}
