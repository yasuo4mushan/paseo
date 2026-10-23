/**
 * 设备选择顶部弹窗（t21）：对话页顶栏设备按钮的下拉面板——
 *  - 设备列表（名称 / OS / 在线点 / 最后心跳；当前设备高亮"已连接"）；
 *  - 点在线设备 → 切换连接（断旧连新，页面处理）；离线设备置灰，点击 toast；
 *  - 底部快捷入口：添加设备（手动配对）/ 管理设备（设备管理页）/ 刷新。
 *
 * 在线语义：只展示 hub devices.list 的 online（t23 统一状态层落地前不掺
 * 本地连接态的第二套语义；"已连接"高亮 = activeDeviceId 匹配）。
 */

import { Image, ScrollView, View } from "@tarojs/components";
import type { HubDevice } from "@/hub/hub-types";
import { formatRelativeTime } from "@/utils/time";
import { iconUrl } from "@/utils/icons";
import { TopSheet } from "@/components/top-sheet";
import "./device-picker.css";

const OS_LABELS: Record<string, string> = {
  darwin: "macOS",
  macos: "macOS",
  win32: "Windows",
  windows: "Windows",
  linux: "Linux",
};

function osLabel(os: string): string {
  return OS_LABELS[os.toLowerCase()] ?? (os || "未知系统");
}

export function DevicePickerSheet({
  visible,
  onClose,
  devices,
  activeDeviceId,
  connectingDeviceId,
  onSelect,
  onRefresh,
  onAddDevice,
  onManage,
}: {
  visible: boolean;
  onClose: () => void;
  /** 最近一次 devices.list 快照（null = 加载中骨架）。 */
  devices: HubDevice[] | null;
  activeDeviceId: string | null;
  /** 正在连接的设备 id（切换中行内"连接中"态）。 */
  connectingDeviceId: string | null;
  /** 点设备行：页面处理切换/离线提示。 */
  onSelect: (device: HubDevice) => void;
  onRefresh: () => void;
  /** 添加设备：跳手动配对。 */
  onAddDevice: () => void;
  /** 管理设备：设备管理页。 */
  onManage: () => void;
}) {
  return (
    <TopSheet
      visible={visible}
      title="选择设备"
      onClose={onClose}
      footer={
        <>
          <View className="dp-action" onClick={onAddDevice}>
            <Image className="icon icon-sm" src={iconUrl("plus")} />
            <View className="dp-action-text">添加设备</View>
          </View>
          <View className="dp-action" onClick={onManage}>
            <Image className="icon icon-sm" src={iconUrl("settings")} />
            <View className="dp-action-text">管理设备</View>
          </View>
          <View className="dp-action" onClick={onRefresh}>
            <Image className="icon icon-sm" src={iconUrl("refresh")} />
            <View className="dp-action-text">刷新</View>
          </View>
        </>
      }
    >
      <ScrollView className="dp-list" scrollY enhanced showScrollbar={false}>
        {devices === null ? (
          <View className="dp-skeleton">
            <View className="skeleton-bar" />
            <View className="skeleton-bar skeleton-bar-short" />
          </View>
        ) : devices.length === 0 ? (
          <View className="dp-empty">
            <Image className="icon icon-lg" src={iconUrl("devices")} />
            <View className="dp-empty-text">还没有设备</View>
            <View className="dp-empty-sub">
              在开发机上安装 aaswitch daemon 并登录同一账号，或用「添加设备」手动配对。
            </View>
          </View>
        ) : (
          devices.map((device) => {
            const active = device.deviceId === activeDeviceId;
            const connecting = device.deviceId === connectingDeviceId;
            const offline = !device.online || !device.offer;
            return (
              <View
                key={device.deviceId}
                className={`dp-row ${active ? "dp-row-active" : ""} ${offline ? "dp-row-offline" : ""}`}
                onClick={() => onSelect(device)}
              >
                <View className={`dp-dot ${device.online ? "dp-dot-online" : ""}`} />
                <View className="dp-main">
                  <View className="dp-name">{device.name}</View>
                  <View className="dp-sub">
                    {osLabel(device.os)} · 最后心跳 {formatRelativeTime(device.lastSeenAt)}
                  </View>
                </View>
                {connecting ? (
                  <View className="pill pill-running">连接中…</View>
                ) : active ? (
                  <View className="pill pill-online">
                    <View className="pill-dot" />
                    已连接
                  </View>
                ) : offline ? (
                  <View className="pill">
                    <View className="pill-dot" />
                    离线
                  </View>
                ) : (
                  <View className="pill pill-online">
                    <View className="pill-dot" />
                    在线
                  </View>
                )}
              </View>
            );
          })
        )}
      </ScrollView>
    </TopSheet>
  );
}
