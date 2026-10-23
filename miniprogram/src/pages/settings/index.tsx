import { useEffect, useState } from "react";
import Taro, { useDidShow } from "@tarojs/taro";
import { Button, Input, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { DaemonStatus } from "@/connection/protocol-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { attentionStore } from "@/stores/attention-store";
import { THEME_LABELS, themeStore, type ThemePreference } from "@/stores/theme-store";
import {
  DEFAULT_HUB_BASE,
  getAccount,
  getHubBase,
  hasSession,
  hub,
  resetHubBase,
  setHubBase,
} from "@/hub/hub-client";
import "./index.css";

const STATUS_TEXT: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中…",
  connected: "已连接",
  error: "连接失败",
};

const VIBRATE_KEY = "aaswitch_attention_vibrate";

function endpointLabel(): string {
  const stored = connectionManager.getStored() ?? connectionManager.loadStored();
  if (!stored) return "未配置";
  if (stored.kind === "relay") {
    return `${stored.offer.useTls ? "wss" : "ws"}://${stored.offer.endpoint}`;
  }
  return stored.url;
}

/** manager 状态订阅（t18 起弃用 useSyncExternalStore，统一 useState+useEffect）。 */
function useConnectionState() {
  const [state, setState] = useState(() => connectionManager.getState());
  useEffect(() => connectionManager.subscribe(() => setState(connectionManager.getState())), []);
  return state;
}

export default function SettingsPage() {
  const themeClass = useThemeClass();
  const state = useConnectionState();
  const [authed, setAuthed] = useState(() => hasSession());
  const [username, setUsername] = useState(() => getAccount()?.username ?? "");
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);
  const [hubBase, setHubBaseState] = useState(() => getHubBase());
  const [hubDraft, setHubDraft] = useState("");
  const [hubEditing, setHubEditing] = useState(false);
  // t18：外观三档 + attention 振动
  const [themePref, setThemePref] = useState<ThemePreference>(() => themeStore.getPreference());
  const [vibrate, setVibrate] = useState(() => attentionStore.isVibrationEnabled());

  useEffect(() => themeStore.subscribe(() => setThemePref(themeStore.getPreference())), []);

  useDidShow(() => {
    setAuthed(hasSession());
    setUsername(getAccount()?.username ?? "");
    setHubBaseState(getHubBase());
  });

  useEffect(() => {
    if (!authed) {
      connectionManager.disconnect();
      Taro.reLaunch({ url: "/pages/login/index" });
    }
  }, [authed]);

  useEffect(() => {
    if (state.status === "connected") {
      connectionManager
        .fetchDaemonStatus()
        .then(setDaemonStatus)
        .catch(() => setDaemonStatus(null));
    }
  }, [state.status]);

  if (!authed) return <View />;

  const activeDevice = connectionManager.getActiveDevice();
  const info = state.status === "connected" ? state.info : null;

  const setTheme = (pref: ThemePreference) => {
    themeStore.setPreference(pref);
    setThemePref(pref);
    Taro.showToast({ title: THEME_LABELS[pref], icon: "none" });
  };

  const toggleVibrate = () => {
    const next = !vibrate;
    setVibrate(next);
    attentionStore.setVibrationEnabled(next);
    Taro.setStorageSync(VIBRATE_KEY, next);
  };

  const logout = () => {
    Taro.showModal({
      title: "退出登录",
      content: "将清除本机账号会话并断开设备连接，确定继续？",
      confirmText: "退出",
      confirmColor: "#FA5151",
      success: (res) => {
        if (!res.confirm) return;
        connectionManager.disconnect();
        void hub.logout().finally(() => {
          Taro.reLaunch({ url: "/pages/login/index" });
        });
      },
    });
  };

  const reconnect = () => {
    connectionManager
      .connect()
      .then(() => Taro.showToast({ title: "已连接", icon: "success" }))
      .catch((err: unknown) =>
        Taro.showToast({
          title: err instanceof Error ? err.message : "重连失败",
          icon: "none",
        }),
      );
  };

  const saveHubBase = () => {
    try {
      const saved = setHubBase(hubDraft);
      setHubBaseState(saved);
      setHubEditing(false);
      Taro.showToast({ title: "已保存", icon: "success" });
    } catch (err) {
      Taro.showToast({ title: err instanceof Error ? err.message : "地址无效", icon: "none" });
    }
  };

  return (
    <View className={`page settings-page ${themeClass}`}>
      <View className="section-title">账号</View>
      <View className="cell-group">
        <View className="cell">
          <View className="cell-grow cell-label">用户名</View>
          <View className="cell-value">{username || "未登录"}</View>
        </View>
        <View className="cell cell-tappable" onClick={logout}>
          <View className="cell-grow cell-label cell-danger">退出登录</View>
        </View>
      </View>

      <View className="section-title">设备连接</View>
      <View className="cell-group">
        <View className="cell">
          <View className="cell-grow cell-label">连接状态</View>
          <View
            className={`cell-value ${
              state.status === "connected"
                ? "value-ok"
                : state.status === "error"
                  ? "value-bad"
                  : ""
            }`}
          >
            {STATUS_TEXT[state.status] ?? state.status}
            {state.status === "error" ? `：${state.message}` : ""}
          </View>
        </View>
        <View className="cell">
          <View className="cell-grow cell-label">当前设备</View>
          <View className="cell-value">{activeDevice ? activeDevice.name : endpointLabel()}</View>
        </View>
        {info ? (
          <View className="cell">
            <View className="cell-grow cell-label">daemon 版本</View>
            <View className="cell-value num">{info.version ?? "未知"}</View>
          </View>
        ) : null}
        {daemonStatus?.listen ? (
          <View className="cell">
            <View className="cell-grow cell-label">监听地址</View>
            <View className="cell-value num">{daemonStatus.listen}</View>
          </View>
        ) : null}
      </View>
      {state.status !== "connected" ? (
        <Button className="btn btn-block settings-action" onClick={reconnect}>
          重连上次设备
        </Button>
      ) : (
        <Button
          className="btn btn-ghost btn-block settings-action"
          onClick={() => {
            connectionManager.disconnect();
            Taro.showToast({ title: "已断开", icon: "none" });
          }}
        >
          断开连接
        </Button>
      )}
      <View
        className="cell cell-tappable settings-switch-device"
        onClick={() => Taro.switchTab({ url: "/pages/devices/index" })}
      >
        <View className="cell-grow">
          <View className="cell-label">管理设备</View>
          <View className="faint">设备列表/连接/手动配对；日常切换在对话页顶栏</View>
        </View>
        <View className="cell-arrow">›</View>
      </View>

      <View className="section-title">外观与提醒</View>
      <View className="cell-group">
        <View className="cell">
          <View className="cell-grow cell-label">主题</View>
          <View className="theme-options">
            {(["auto", "light", "dark"] as ThemePreference[]).map((pref) => (
              <View
                key={pref}
                className={`theme-option ${themePref === pref ? "theme-option-active" : ""}`}
                onClick={() => setTheme(pref)}
              >
                {THEME_LABELS[pref]}
              </View>
            ))}
          </View>
        </View>
        <View className="cell cell-tappable" onClick={toggleVibrate}>
          <View className="cell-grow">
            <View className="cell-label">Agent 提醒振动</View>
            <View className="faint">agent 完成或需要授权时振动一次</View>
          </View>
          <View className={`switch ${vibrate ? "switch-on" : ""}`}>
            <View className="switch-knob" />
          </View>
        </View>
      </View>

      <View className="section-title">Hub 服务器</View>
      <View className="cell-group">
        {hubEditing ? (
          <View className="hub-editor">
            <Input
              className="field-input hub-input"
              value={hubDraft}
              onInput={(e) => setHubDraft(e.detail.value)}
              placeholder="https://example.com/api"
              placeholderClass="input-placeholder"
            />
            <View className="hub-editor-actions">
              <Button className="btn btn-ghost btn-mini" onClick={() => setHubEditing(false)}>
                取消
              </Button>
              <Button className="btn btn-mini" onClick={saveHubBase}>
                保存
              </Button>
            </View>
          </View>
        ) : (
          <View
            className="cell cell-tappable"
            onClick={() => {
              setHubDraft(hubBase);
              setHubEditing(true);
            }}
          >
            <View className="cell-grow cell-label">API 地址</View>
            <View className="cell-value num">{hubBase}</View>
            <View className="cell-arrow">修改</View>
          </View>
        )}
      </View>
      {hubBase !== DEFAULT_HUB_BASE ? (
        <View
          className="faint settings-note"
          onClick={() => {
            resetHubBase();
            setHubBaseState(DEFAULT_HUB_BASE);
            Taro.showToast({ title: "已恢复默认", icon: "none" });
          }}
        >
          当前使用自定义地址，点此恢复默认 {DEFAULT_HUB_BASE}
        </View>
      ) : (
        <View className="faint settings-note">正式发布前需切换为 https 域名（见 README）</View>
      )}

      <View className="section-title">高级</View>
      <View className="cell-group">
        <View
          className="cell cell-tappable"
          onClick={() => Taro.navigateTo({ url: "/pages/pair/index" })}
        >
          <View className="cell-grow">
            <View className="cell-label">手动配对</View>
            <View className="faint">粘贴 relay:// 链接或扫码直连（原配对入口）</View>
          </View>
          <View className="cell-arrow">›</View>
        </View>
        <View
          className="cell cell-tappable"
          onClick={() =>
            Taro.showModal({
              title: "清除已保存连接",
              content: "将删除本机保存的配对信息（等同密码），确定继续？",
              confirmText: "清除",
              confirmColor: "#FA5151",
              success: (res) => {
                if (res.confirm) {
                  connectionManager.forget();
                  Taro.showToast({ title: "已清除", icon: "none" });
                }
              },
            })
          }
        >
          <View className="cell-grow cell-label">清除已保存连接</View>
          <View className="cell-arrow">›</View>
        </View>
      </View>

      <View className="section-title">关于</View>
      <View className="cell-group">
        <View className="cell">
          <View className="cell-grow cell-label">版本</View>
          <View className="cell-value num">0.2.0</View>
        </View>
        <View className="cell">
          <View className="cell-grow cell-label">安全</View>
          <View className="cell-value">relay 端到端加密</View>
        </View>
      </View>

      <View className="footer-note">aaswitch · based on Paseo</View>
      <PermissionOverlay />
    </View>
  );
}
