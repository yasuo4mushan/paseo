import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, Image, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { hasSession, hub, hubErrorMessage, isAuthExpired } from "@/hub/hub-client";
import type { HubDevice } from "@/hub/hub-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useThemeClass } from "@/hooks/use-theme";
import { formatRelativeTime } from "@/utils/time";
import { iconUrl } from "@/utils/icons";
import { safeNavigateTo, safeReLaunch, safeSwitchTab } from "@/utils/navigation";
import "./index.css";

const OS_META: Record<string, string> = {
  darwin: "macOS",
  macos: "macOS",
  win32: "Windows",
  windows: "Windows",
  linux: "Linux",
};

function osMeta(os: string): { label: string } {
  return { label: OS_META[os.toLowerCase()] ?? (os || "未知系统") };
}

export default function DevicesPage() {
  const themeClass = useThemeClass();
  const [connectionState, setConnectionState] = useState(() => connectionManager.getState());
  useEffect(
    () => connectionManager.subscribe(() => setConnectionState(connectionManager.getState())),
    [],
  );
  const [authed, setAuthed] = useState(() => hasSession());
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [error, setError] = useState("");
  const [connectingId, setConnectingId] = useState("");
  // P0-0：连接中的同步互斥（state 异步生效，双击会在 setConnectingId 前都通过守卫）
  const connectingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasSession()) {
      setAuthed(false);
      return;
    }
    try {
      const list = await hub.devices();
      setDevices(list);
      setError("");
    } catch (err) {
      if (isAuthExpired(err) || !hasSession()) {
        setAuthed(false);
        return;
      }
      setError(hubErrorMessage(err));
    }
  }, []);

  // 未登录 → 登录页（异步 refresh 里发现的会话失效也走这里）
  useEffect(() => {
    if (!authed) {
      connectionManager.disconnect();
      void safeReLaunch("/pages/login/index");
    }
  }, [authed]);

  useEffect(() => {
    if (authed) void refresh();
  }, [authed, refresh]);

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const activeDevice = connectionManager.getActiveDevice();
  const connected = connectionState.status === "connected";

  const connectDevice = async (device: HubDevice) => {
    if (connectingRef.current) return;
    if (!device.online || !device.offer) {
      Taro.showToast({ title: "设备离线，无法连接", icon: "none" });
      return;
    }
    connectingRef.current = true;
    setConnectingId(device.deviceId);
    try {
      await connectionManager.connectOffer(device.offer, {
        deviceId: device.deviceId,
        name: device.name,
      });
      // t20：连上即达对话主页（switchTab 不入页面栈——修复旧版 navigateTo:fail
      // timeout 的结构性根因：await 长握手后与用户连点/其他转场并发导航）。
      await safeSwitchTab("/pages/chat/index");
    } catch (err) {
      Taro.showToast({ title: hubErrorMessage(err), icon: "none" });
    } finally {
      connectingRef.current = false;
      setConnectingId("");
    }
  };

  if (!authed) return <View />;

  return (
    <View className={`page devices-page ${themeClass}`}>
      {error ? (
        <View className="error-inline">{error}</View>
      ) : devices === null ? (
        <>
          <View className="skeleton">
            <View className="skeleton-bar" />
            <View className="skeleton-bar skeleton-bar-short" />
          </View>
          <View className="skeleton">
            <View className="skeleton-bar" />
            <View className="skeleton-bar skeleton-bar-short" />
          </View>
        </>
      ) : devices.length === 0 ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("devices")} />
          <View className="empty-title">还没有设备</View>
          <View className="empty-desc">
            在你的开发机上安装 aaswitch daemon 并登录同一账号，设备会自动出现在这里。
          </View>
        </View>
      ) : (
        <>
          {devices.map((device) => {
            const meta = osMeta(device.os);
            const busy = connectingId === device.deviceId;
            const isActive = connected && activeDevice?.deviceId === device.deviceId;
            return (
              <View
                key={device.deviceId}
                className={`card device-card ${device.online ? "device-online" : "device-offline"}`}
                onClick={() => void connectDevice(device)}
              >
                <View className="device-icon">
                  <Image className="icon icon-lg" src={iconUrl("devices")} />
                </View>
                <View className="device-main">
                  <View className="device-name">{device.name}</View>
                  <View className="muted device-sub">
                    {meta.label} · 最后心跳 {formatRelativeTime(device.lastSeenAt)}
                  </View>
                </View>
                {busy ? (
                  <View className="pill pill-running">连接中…</View>
                ) : isActive ? (
                  <View className="pill pill-online">
                    <View className="pill-dot" />
                    已连接
                  </View>
                ) : device.online ? (
                  <View className="pill pill-online">
                    <View className="pill-dot" />
                    在线
                  </View>
                ) : (
                  <View className="pill">
                    <View className="pill-dot" />
                    离线
                  </View>
                )}
                {/* t24：已连接设备的快捷入口（文件浏览/新建项目向导）。
                    事件必须 catchtap 阻断卡片 onClick（连接）。 */}
                {isActive ? (
                  <View className="device-quick">
                    <Button
                      className="btn btn-mini btn-ghost device-quick-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void safeNavigateTo("/pages/files/index");
                      }}
                    >
                      <Image className="icon icon-sm" src={iconUrl("file")} />
                      文件
                    </Button>
                    <Button
                      className="btn btn-mini btn-ghost device-quick-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        void safeNavigateTo("/pages/create/index");
                      }}
                    >
                      <Image className="icon icon-sm" src={iconUrl("plus")} />
                      新建项目
                    </Button>
                  </View>
                ) : null}
              </View>
            );
          })}
          <View className="loading-tip">点击在线设备连接 · 下拉刷新列表</View>
        </>
      )}
      {error ? (
        <Button className="btn btn-ghost btn-block" onClick={() => void refresh()}>
          重试
        </Button>
      ) : null}
      <PermissionOverlay />
    </View>
  );
}
