/**
 * 连接管理器：页面与连接层之间的应用态桥。
 *
 * 职责：保存/读取配对配置（Taro storage）、按配置组装 socket 工厂
 * （relay E2EE 或直连 ws）、持有 DaemonConnection 单例、向页面广播状态。
 *
 * 注意：offer 中的 key 与 password 等同于密码，仅存本机 storage，不上传。
 */

import Taro from "@tarojs/taro";
import { DaemonConnection, type DaemonConnectionState } from "./daemon-connection";
import {
  buildRelayClientWebSocketUrl,
  buildRelayUriFromOffer,
  parseConnectionInput,
  type RelayOffer,
} from "./relay-offer";
import { createRelayPlaintextSocket } from "./relay-transport";
import { createWxSocket } from "./wx-socket";
import type { AgentSnapshot, AgentStreamPayload, DaemonStatus, ServerInfo } from "./protocol-types";

const STORAGE_KEY = "paseo_mp_connection";

export type StoredConnection =
  | { kind: "relay"; input: string; offer: RelayOffer }
  | { kind: "direct"; input: string; url: string };

/** 当前连接的 hub 设备（仅内存态；设置页展示用）。 */
export interface ActiveDevice {
  deviceId: string;
  name: string;
}

export type ManagerState =
  | { status: "disconnected" }
  | { status: "connecting"; label: string }
  | { status: "connected"; info: ServerInfo; connection: StoredConnection }
  | { status: "error"; message: string };

type Listener = () => void;

function getClientId(): string {
  const KEY = "paseo_mp_client_id";
  let id = Taro.getStorageSync<string>(KEY);
  if (!id) {
    id = `mp-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`;
    Taro.setStorageSync(KEY, id);
  }
  return id;
}

class ConnectionManager {
  private connection: DaemonConnection | null = null;
  private stored: StoredConnection | null = null;
  private state: ManagerState = { status: "disconnected" };
  private activeDevice: ActiveDevice | null = null;
  private listeners = new Set<Listener>();
  private streamListeners = new Set<(payload: AgentStreamPayload) => void>();
  private agentUpdateListeners = new Set<
    (update: { kind: "upsert"; agent: AgentSnapshot } | { kind: "remove"; agentId: string }) => void
  >();
  private disconnectListeners = new Set<() => void>();

  getState(): ManagerState {
    return this.state;
  }

  getStored(): StoredConnection | null {
    return this.stored;
  }

  getActiveDevice(): ActiveDevice | null {
    return this.activeDevice;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStreamEvent(listener: (payload: AgentStreamPayload) => void): () => void {
    this.streamListeners.add(listener);
    return () => this.streamListeners.delete(listener);
  }

  onAgentUpdate(
    listener: (
      update: { kind: "upsert"; agent: AgentSnapshot } | { kind: "remove"; agentId: string },
    ) => void,
  ): () => void {
    this.agentUpdateListeners.add(listener);
    return () => this.agentUpdateListeners.delete(listener);
  }

  onDisconnect(listener: () => void): () => void {
    this.disconnectListeners.add(listener);
    return () => this.disconnectListeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  loadStored(): StoredConnection | null {
    if (this.stored) return this.stored;
    const raw = Taro.getStorageSync<string>(STORAGE_KEY);
    if (!raw) return null;
    try {
      const parsed = parseConnectionInput(raw);
      this.stored =
        parsed.kind === "relay"
          ? { kind: "relay", input: raw, offer: parsed.offer }
          : { kind: "direct", input: raw, url: parsed.url };
      return this.stored;
    } catch {
      return null;
    }
  }

  private buildPortFactory(target: StoredConnection) {
    if (target.kind === "direct") {
      return () => createWxSocket(target.url);
    }
    const url = buildRelayClientWebSocketUrl({ offer: target.offer });
    return () =>
      createRelayPlaintextSocket({
        connectUnderlying: () => createWxSocket(url),
        offer: target.offer,
      });
  }

  private setState(next: ManagerState): void {
    this.state = next;
    this.notify();
  }

  async connect(input?: string): Promise<ServerInfo> {
    this.disconnect();
    let target: StoredConnection;
    if (input) {
      const parsed = parseConnectionInput(input);
      target =
        parsed.kind === "relay"
          ? { kind: "relay", input: input.trim(), offer: parsed.offer }
          : { kind: "direct", input: input.trim(), url: parsed.url };
    } else {
      const stored = this.loadStored();
      if (!stored) throw new Error("没有已保存的连接");
      target = stored;
    }
    this.activeDevice = null;
    return this.connectTarget(target);
  }

  /**
   * 设备页入口：用 hub 返回的 offer 走 relay E2EE 连接。
   * offer → relay:// URI 往返构造，与手动配对共用一条路径。
   */
  async connectOffer(offer: RelayOffer, device: ActiveDevice): Promise<ServerInfo> {
    this.disconnect();
    this.activeDevice = device;
    return this.connectTarget({ kind: "relay", input: buildRelayUriFromOffer(offer), offer });
  }

  private async connectTarget(target: StoredConnection): Promise<ServerInfo> {
    this.stored = target;
    this.setState({
      status: "connecting",
      label: target.kind === "relay" ? target.offer.endpoint : target.url,
    });

    const daemonConnection = new DaemonConnection(
      this.buildPortFactory(target),
      {
        clientId: getClientId(),
        clientType: "mobile",
        appVersion: "0.1.0",
        ...(target.kind === "relay" && target.offer.password
          ? { password: target.offer.password }
          : {}),
      },
      {
        onStateChange: (state: DaemonConnectionState, detail) => {
          if (state === "error") {
            this.setState({ status: "error", message: detail ?? "连接失败" });
          }
        },
        onStreamEvent: (payload) => {
          for (const listener of this.streamListeners) listener(payload);
        },
        onAgentUpdate: (update) => {
          for (const listener of this.agentUpdateListeners) listener(update);
        },
        onDisconnect: () => {
          this.setState({ status: "disconnected" });
          for (const listener of this.disconnectListeners) listener();
        },
      },
    );
    this.connection = daemonConnection;

    try {
      const info = await daemonConnection.connect();
      this.setState({ status: "connected", info, connection: target });
      Taro.setStorageSync(STORAGE_KEY, target.input);
      return info;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      daemonConnection.close();
      this.connection = null;
      this.setState({ status: "error", message });
      throw error;
    }
  }

  getConnection(): DaemonConnection | null {
    if (this.state.status !== "connected") return null;
    return this.connection;
  }

  requireConnection(): DaemonConnection {
    const conn = this.getConnection();
    if (!conn) throw new Error("未连接");
    return conn;
  }

  disconnect(): void {
    if (this.connection) {
      this.connection.close(1000, "user disconnect");
      this.connection = null;
    }
    this.activeDevice = null;
    this.setState({ status: "disconnected" });
  }

  forget(): void {
    this.disconnect();
    this.stored = null;
    Taro.removeStorageSync(STORAGE_KEY);
  }

  async fetchDaemonStatus(): Promise<DaemonStatus | null> {
    const conn = this.getConnection();
    return conn ? conn.fetchDaemonStatus() : null;
  }
}

export const connectionManager = new ConnectionManager();
