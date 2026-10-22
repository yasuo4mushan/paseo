import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import Taro, { usePullDownRefresh } from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { hasSession, hub, hubErrorMessage, isAuthExpired } from "@/hub/hub-client";
import type { HubDevice } from "@/hub/hub-types";
import { PermissionOverlay } from "@/components/permission-overlay";
import { formatRelativeTime } from "@/utils/time";
import "./index.css";

const OS_META: Record<string, { label: string; icon: string }> = {
  darwin: { label: "macOS", icon: "🍎" },
  macos: { label: "macOS", icon: "🍎" },
  win32: { label: "Windows", icon: "🪟" },
  windows: { label: "Windows", icon: "🪟" },
  linux: { label: "Linux", icon: "🐧" },
};

function osMeta(os: string): { label: string; icon: string } {
  return OS_META[os.toLowerCase()] ?? { label: os || "未知系统", icon: "🖥" };
}

export default function DevicesPage() {
  const connectionState = useSyncExternalStore(
    (cb) => connectionManager.subscribe(cb),
    () => connectionManager.getState(),
  );
  const [authed, setAuthed] = useState(() => hasSession());
  const [devices, setDevices] = useState<HubDevice[] | null>(null);
  const [error, setError] = useState("");
  const [connectingId, setConnectingId] = useState("");

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
      Taro.reLaunch({ url: "/pages/login/index" });
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
    if (connectingId) return;
    if (!device.online || !device.offer) {
      Taro.showToast({ title: "设备离线，无法连接", icon: "none" });
      return;
    }
    setConnectingId(device.deviceId);
    try {
      await connectionManager.connectOffer(device.offer, {
        deviceId: device.deviceId,
        name: device.name,
      });
      Taro.navigateTo({ url: "/pages/agents/index" });
    } catch (err) {
      Taro.showToast({ title: hubErrorMessage(err), icon: "none" });
    } finally {
      setConnectingId("");
    }
  };

  if (!authed) return <View />;

  return (
    <View className="page devices-page">
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
          <View className="empty-icon">🖥</View>
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
                <View className="device-icon">{meta.icon}</View>
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
