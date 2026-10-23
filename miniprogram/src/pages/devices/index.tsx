import { useCallback, useEffect, useRef, useState } from "react";
import Taro, { useDidShow, usePullDownRefresh } from "@tarojs/taro";
import { Button, Image, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import { deviceStatusStore, type DeviceStatusEntry } from "@/connection/device-status-store";
import { hasSession } from "@/hub/hub-client";
import { PermissionOverlay } from "@/components/permission-overlay";
import { useDeviceStatuses } from "@/hooks/use-device-statuses";
import { useThemeClass } from "@/hooks/use-theme";
import { formatRelativeTime } from "@/utils/time";
import { iconUrl } from "@/utils/icons";
import { safeReLaunch, safeSwitchTab } from "@/utils/navigation";
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

/**
 * t23：综合三态 → 胶囊（connected 绿实心"已连接"/未上表加注；online 蓝点；offline 灰点）。
 * 设备页与设置页共用 deviceStatusStore，同一数据源同一语义。
 */
function statusPill(entry: DeviceStatusEntry): { cls: string; text: string } {
  if (entry.status === "connected") {
    return {
      cls: "pill pill-solid",
      text: entry.unreported ? "已连接（未上表）" : "已连接",
    };
  }
  if (entry.status === "online") return { cls: "pill pill-info", text: "在线" };
  return { cls: "pill", text: "离线" };
}

export default function DevicesPage() {
  const themeClass = useThemeClass();
  const snapshot = useDeviceStatuses();
  const [authed, setAuthed] = useState(() => hasSession());
  const [connectingId, setConnectingId] = useState("");
  // P0-0：连接中的同步互斥（state 异步生效，双击会在 setConnectingId 前都通过守卫）
  const connectingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!hasSession()) {
      setAuthed(false);
      return;
    }
    await deviceStatusStore.refreshNow();
  }, []);

  // store 报告会话失效（hub 401/token 过期）→ 登录页
  useEffect(() => {
    if (snapshot.authExpired || !hasSession()) setAuthed(false);
  }, [snapshot.authExpired]);

  // 未登录 → 登录页
  useEffect(() => {
    if (!authed) {
      connectionManager.disconnect();
      void safeReLaunch("/pages/login/index");
    }
  }, [authed]);

  useEffect(() => {
    if (authed) void deviceStatusStore.refreshNow();
  }, [authed]);

  // t23：页面 onShow 强刷（设备列表缓存不超一个轮询周期）
  useDidShow(() => {
    void deviceStatusStore.refreshNow();
  });

  usePullDownRefresh(async () => {
    await refresh();
    Taro.stopPullDownRefresh();
  });

  const connectDevice = async (entry: DeviceStatusEntry) => {
    if (connectingRef.current) return;
    if (entry.status === "connected") {
      // t23：本地连接已在（含"未上表"设备）——直达对话，不拆连接重握手
      await safeSwitchTab("/pages/chat/index");
      return;
    }
    if (entry.status !== "online" || !entry.offer) {
      Taro.showToast({ title: "设备离线，无法连接", icon: "none" });
      return;
    }
    connectingRef.current = true;
    setConnectingId(entry.deviceId);
    try {
      await connectionManager.connectOffer(entry.offer, {
        deviceId: entry.deviceId,
        name: entry.name,
      });
      // t20：连上即达对话主页（switchTab 不入页面栈——修复旧版 navigateTo:fail
      // timeout 的结构性根因：await 长握手后与用户连点/其他转场并发导航）。
      await safeSwitchTab("/pages/chat/index");
    } catch (err) {
      Taro.showToast({
        title: err instanceof Error ? err.message : String(err),
        icon: "none",
      });
    } finally {
      connectingRef.current = false;
      setConnectingId("");
    }
  };

  if (!authed) return <View />;

  return (
    <View className={`page devices-page ${themeClass}`}>
      {snapshot.error ? (
        <View className="error-inline">{snapshot.error}</View>
      ) : snapshot.loading && snapshot.entries.length === 0 ? (
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
      ) : snapshot.entries.length === 0 && !snapshot.error ? (
        <View className="card empty">
          <Image className="icon icon-xl" src={iconUrl("devices")} />
          <View className="empty-title">还没有设备</View>
          <View className="empty-desc">
            在你的开发机上安装 aaswitch daemon 并登录同一账号，设备会自动出现在这里。
          </View>
        </View>
      ) : (
        <>
          {snapshot.entries.map((entry) => {
            const meta = osMeta(entry.os);
            const busy = connectingId === entry.deviceId;
            const pill = busy ? { cls: "pill pill-running", text: "连接中…" } : statusPill(entry);
            return (
              <View
                key={entry.deviceId}
                className={`card device-card ${entry.status === "offline" ? "device-offline" : "device-online"}`}
                onClick={() => void connectDevice(entry)}
              >
                <View className="device-icon">
                  <Image className="icon icon-lg" src={iconUrl("devices")} />
                </View>
                <View className="device-main">
                  <View className="device-name">{entry.name}</View>
                  <View className="muted device-sub">
                    {meta.label} · 最后心跳 {formatRelativeTime(entry.lastSeenAt)}
                  </View>
                  {entry.unreported ? (
                    <View className="device-hint">
                      桌面端未登录 aaswitch 账号，设备不会出现在其他手机
                    </View>
                  ) : null}
                </View>
                <View className={pill.cls}>
                  <View className="pill-dot" />
                  {pill.text}
                </View>
              </View>
            );
          })}
          <View className="loading-tip">
            点击在线设备连接 · 已连接设备点开直达对话 · 下拉刷新列表
          </View>
        </>
      )}
      {snapshot.error ? (
        <Button className="btn btn-ghost btn-block" onClick={() => void refresh()}>
          重试
        </Button>
      ) : null}
      <PermissionOverlay />
    </View>
  );
}
