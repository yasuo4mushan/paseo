import { useEffect, useState, useSyncExternalStore } from "react";
import Taro from "@tarojs/taro";
import { Button, View } from "@tarojs/components";
import { connectionManager } from "@/connection/connection-manager";
import type { DaemonStatus } from "@/connection/protocol-types";
import "./index.css";

const STATUS_TEXT: Record<string, string> = {
  disconnected: "未连接",
  connecting: "连接中…",
  connected: "已连接",
  error: "连接失败",
};

function endpointLabel(): string {
  const stored = connectionManager.getStored() ?? connectionManager.loadStored();
  if (!stored) return "未配置";
  if (stored.kind === "relay") {
    return `${stored.offer.useTls ? "wss" : "ws"}://${stored.offer.endpoint}（relay，serverId ${stored.offer.serverId}）`;
  }
  return stored.url;
}

export default function SettingsPage() {
  const state = useSyncExternalStore(
    (cb) => connectionManager.subscribe(cb),
    () => connectionManager.getState(),
  );
  const [daemonStatus, setDaemonStatus] = useState<DaemonStatus | null>(null);

  const refreshStatus = async () => {
    try {
      setDaemonStatus(await connectionManager.fetchDaemonStatus());
    } catch {
      setDaemonStatus(null);
    }
  };

  useEffect(() => {
    if (state.status === "connected") void refreshStatus();
  }, [state.status]);

  const info = state.status === "connected" ? state.info : null;

  const reconnect = () => {
    connectionManager
      .connect()
      .then(() => Taro.showToast({ title: "已连接", icon: "success" }))
      .catch((err: unknown) =>
        Taro.showToast({ title: err instanceof Error ? err.message : "重连失败", icon: "none" }),
      );
  };

  return (
    <View className="page">
      <View className="card">
        <View className="row">
          <View className="row-label">连接状态</View>
          <View
            className={`row-value ${state.status === "connected" ? "ok" : state.status === "error" ? "bad" : ""}`}
          >
            {STATUS_TEXT[state.status] ?? state.status}
            {state.status === "error" ? `：${state.message}` : ""}
          </View>
        </View>
        <View className="row">
          <View className="row-label">连接方式</View>
          <View className="row-value">{endpointLabel()}</View>
        </View>
        {info ? (
          <>
            <View className="row">
              <View className="row-label">daemon ID</View>
              <View className="row-value">{info.serverId}</View>
            </View>
            <View className="row">
              <View className="row-label">daemon 版本</View>
              <View className="row-value">{info.version ?? "未知"}</View>
            </View>
          </>
        ) : null}
        {daemonStatus?.listen ? (
          <View className="row">
            <View className="row-label">监听地址</View>
            <View className="row-value">{daemonStatus.listen}</View>
          </View>
        ) : null}
      </View>

      <Button className="button" onClick={reconnect}>
        重连
      </Button>
      <Button
        className="button button-secondary action-btn"
        onClick={() => {
          connectionManager.disconnect();
          Taro.showToast({ title: "已断开", icon: "none" });
        }}
      >
        断开连接
      </Button>
      <Button
        className="button button-secondary action-btn"
        onClick={() =>
          Taro.showModal({
            title: "清除配对",
            content: "将删除已保存的配对链接（等同密码），确定继续？",
            confirmText: "清除",
            confirmColor: "#d4380d",
            success: (res) => {
              if (res.confirm) {
                connectionManager.forget();
                Taro.reLaunch({ url: "/pages/pair/index" });
              }
            },
          })
        }
      >
        清除配对
      </Button>

      <View className="card about">
        <View className="muted">
          Paseo 小程序客户端 MVP。通过自托管 relay（端到端加密）或局域网直连访问你开发机上的
          daemon，代码与数据保留在本机。
        </View>
      </View>
    </View>
  );
}
