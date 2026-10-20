/**
 * daemon 连接：hello 握手 + requestId 关联 RPC + agent 目录/时间线订阅。
 *
 * 消息协议 vendor 自 packages/protocol/src/messages.ts：
 * - WS 外层信封：{type:"hello"|"ping"|"session", message?}（WSInboundMessageSchema）
 * - daemon 主动推送 server_info：{type:"session",message:{type:"status",payload:{status:"server_info",...}}}
 * - RPC：请求带 requestId（fetch_agents_request 等），响应 payload.requestId 回关联
 *   （官方客户端同机制，见 packages/client/src/daemon-client.ts sendRequest/select）
 * - 流订阅：agent.timeline.set_subscription.request 声明关注的 agentId 集合，
 *   之后 daemon 以 agent_stream 推送时间线/turn 事件
 *
 * 设计约束（平台无关）：
 * - 不 import 任何平台 API；socket 通过 SocketPortFactory 注入
 *   （直连 ws:// 用 wx-socket；relay 用 relay-transport 包装后的明文端口）
 * - 不做自动重连（MVP：onDisconnect 通知上层，由用户/页面触发重连）
 */

import {
  parseAgentSnapshot,
  parseAgentStreamPayload,
  parseDaemonStatusPayload,
  parseFetchAgentsResponse,
  parseFetchTimelineResponse,
  parseSendAgentMessageResponse,
  parseServerInfoPayload,
  type AgentSnapshot,
  type AgentStreamPayload,
  type AgentTimelineEntry,
  type DaemonStatus,
  type ServerInfo,
  type SessionRequestMessage,
  type WsClientType,
} from "./protocol-types";
import type { PlaintextPort, PlaintextPortFactory, SocketEventHandler } from "./websocket-port";

export interface DaemonConnectionOptions {
  clientId: string;
  clientType?: WsClientType;
  password?: string;
  appVersion?: string;
  /** RPC 默认超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** hello 之后等待 server_info 的超时（毫秒）。 */
  helloTimeoutMs?: number;
}

export type DaemonConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";

export interface DaemonConnectionEvents {
  onStateChange?: (state: DaemonConnectionState, detail?: string) => void;
  onServerInfo?: (info: ServerInfo) => void;
  onStreamEvent?: (payload: AgentStreamPayload) => void;
  onAgentUpdate?: (
    update: { kind: "upsert"; agent: AgentSnapshot } | { kind: "remove"; agentId: string },
  ) => void;
  onDisconnect?: (code: number, reason: string) => void;
}

interface PendingRequest {
  resolve: (message: Record<string, unknown> & { requestId?: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  responseType: string;
}

/** Omit 的分配律版本：对联合类型逐成员 Omit，保留各消息自己的字段形状。 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type SessionRequestInput = DistributiveOmit<SessionRequestMessage, "requestId"> & {
  requestId?: string;
};

let requestCounter = 0;

function createRequestId(): string {
  requestCounter += 1;
  const rand = Math.floor(Math.random() * 0x100000000).toString(36);
  return `mp-${Date.now().toString(36)}-${requestCounter.toString(36)}-${rand}`;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class DaemonConnection {
  private portFactory: PlaintextPortFactory;
  private options: DaemonConnectionOptions & {
    clientType: Exclude<DaemonConnectionOptions["clientType"], undefined>;
    requestTimeoutMs: number;
    helloTimeoutMs: number;
  };
  private events: DaemonConnectionEvents;
  private socket: PlaintextPort | null = null;
  private unbindSocket: (() => void) | null = null;
  private state: DaemonConnectionState = "idle";
  private pending = new Map<string, PendingRequest>();
  private serverInfo: ServerInfo | null = null;
  private helloWaiters: Array<{
    resolve: (info: ServerInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closeReason: { code: number; reason: string } | null = null;
  private lastError: string | null = null;

  constructor(
    portFactory: PlaintextPortFactory,
    options: DaemonConnectionOptions,
    events: DaemonConnectionEvents = {},
  ) {
    this.portFactory = portFactory;
    this.options = {
      ...options,
      clientType: options.clientType ?? "mobile",
      requestTimeoutMs: options.requestTimeoutMs ?? 15_000,
      helloTimeoutMs: options.helloTimeoutMs ?? 10_000,
    };
    this.events = events;
  }

  getState(): DaemonConnectionState {
    return this.state;
  }

  getServerInfo(): ServerInfo | null {
    return this.serverInfo;
  }

  getLastError(): string | null {
    return this.lastError;
  }

  getCloseReason(): { code: number; reason: string } | null {
    return this.closeReason;
  }

  private setState(state: DaemonConnectionState, detail?: string): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange?.(state, detail);
  }

  /** 连接并完成 hello 握手（等待 daemon server_info）。 */
  async connect(): Promise<ServerInfo> {
    if (this.state === "connected" && this.serverInfo) {
      return this.serverInfo;
    }
    if (this.state === "connecting") {
      return this.waitServerInfo();
    }

    this.setState("connecting");
    const socket = this.portFactory();
    this.socket = socket;

    const handler: SocketEventHandler = (event) => {
      switch (event.type) {
        case "open":
          this.sendHello();
          break;
        case "message":
          this.handleMessage(event.data);
          break;
        case "error":
          this.lastError = event.message;
          this.failHelloWaiters(new Error(event.message));
          this.setState("error", event.message);
          break;
        case "close":
          this.handleSocketClose(event.code, event.reason);
          break;
      }
    };
    this.unbindSocket = socket.onEvent(handler);

    return this.waitServerInfo();
  }

  private waitServerInfo(): Promise<ServerInfo> {
    if (this.serverInfo) return Promise.resolve(this.serverInfo);
    return new Promise<ServerInfo>((resolve, reject) => {
      const waiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = this.helloWaiters.indexOf(waiter);
          if (index >= 0) this.helloWaiters.splice(index, 1);
          const detail = this.lastError ?? "等待 daemon 响应超时";
          this.setState("error", detail);
          reject(new Error(detail));
        }, this.options.helloTimeoutMs),
      };
      this.helloWaiters.push(waiter);
    });
  }

  private sendHello(): void {
    const hello = {
      type: "hello",
      clientId: this.options.clientId,
      clientType: this.options.clientType,
      protocolVersion: 1,
      ...(this.options.password
        ? { auth: { kind: "password", password: this.options.password } }
        : {}),
      ...(this.options.appVersion ? { appVersion: this.options.appVersion } : {}),
      // 不声明 capabilities：走 legacy 路径即可拿到隐式 agent_stream 推送
      // （server session.ts 的 COMPAT(ownedSubscriptions) 分支），同时
      // agent.timeline.set_subscription.request 仍然生效。
    };
    this.sendEnvelope(hello);
  }

  private handleSocketClose(code: number, reason: string): void {
    this.closeReason = { code, reason };
    this.failHelloWaiters(new Error(`连接已关闭：${code} ${reason}`));
    this.failAllPending(new Error(`连接已关闭：${code} ${reason}`));
    const wasConnected = this.state === "connected" || this.state === "connecting";
    this.setState("closed", reason);
    if (wasConnected) {
      this.events.onDisconnect?.(code, reason);
    }
  }

  private failHelloWaiters(error: Error): void {
    const waiters = this.helloWaiters.splice(0);
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  private failAllPending(error: Error): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      // 二进制帧（终端流/文件传输）超出 MVP 范围，忽略。
      return;
    }
    const parsed = safeJsonParse(data);
    if (!parsed || typeof parsed !== "object") return;
    const envelope = parsed as { type?: unknown };

    if (envelope.type === "pong") return;

    if (envelope.type === "hello.rejected") {
      const rejected = parsed as { reason?: string };
      const detail = rejected.reason ?? "hello 被拒绝";
      this.lastError = detail;
      this.failHelloWaiters(new Error(`daemon 拒绝连接：${detail}`));
      this.setState("error", detail);
      this.socket?.close(1000, "hello rejected");
      return;
    }

    if (envelope.type !== "session") return;
    const session = (parsed as { message?: unknown }).message;
    if (!session || typeof session !== "object") return;
    const message = session as { type?: unknown; payload?: unknown };

    if (message.type === "status") {
      const info = parseServerInfoPayload(message.payload);
      if (info) {
        const first = this.serverInfo === null;
        this.serverInfo = info;
        this.events.onServerInfo?.(info);
        if (first) {
          this.setState("connected");
          const waiters = this.helloWaiters.splice(0);
          for (const waiter of waiters) {
            clearTimeout(waiter.timer);
            waiter.resolve(info);
          }
        }
      }
      return;
    }

    if (message.type === "agent_stream") {
      const payload = parseAgentStreamPayload(message.payload);
      if (payload) {
        this.events.onStreamEvent?.(payload);
      }
      return;
    }

    if (message.type === "agent_update") {
      const payload = message.payload as
        | { kind?: unknown; agent?: unknown; agentId?: unknown }
        | undefined;
      if (payload?.kind === "upsert") {
        const agent = parseAgentSnapshot(payload.agent);
        if (agent) this.events.onAgentUpdate?.({ kind: "upsert", agent });
      } else if (payload?.kind === "remove" && typeof payload.agentId === "string") {
        this.events.onAgentUpdate?.({ kind: "remove", agentId: payload.agentId });
      }
      return;
    }

    // requestId 关联的 RPC 响应
    const payload = message.payload as { requestId?: unknown } | undefined;
    if (payload && typeof payload.requestId === "string") {
      const pending = this.pending.get(payload.requestId);
      if (pending) {
        this.pending.delete(payload.requestId);
        clearTimeout(pending.timer);
        pending.resolve(message as Record<string, unknown> & { requestId?: string });
      }
    }
  }

  private sendEnvelope(envelope: unknown): void {
    this.socket?.send(JSON.stringify(envelope));
  }

  /** 发送会话请求并等待 requestId 关联的响应。 */
  private request<T>(message: SessionRequestInput): Promise<T> {
    if (this.state !== "connected" || !this.socket) {
      return Promise.reject(new Error("未连接 daemon"));
    }
    const requestId = createRequestId();
    const fullMessage = { ...message, requestId } as SessionRequestMessage;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC 超时：${message.type}`));
      }, this.options.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (msg) => resolve(msg as unknown as T),
        reject,
        timer,
        responseType: message.type,
      });
      this.sendEnvelope({ type: "session", message: fullMessage });
    });
  }

  /** 拉取 agent 列表。 */
  async fetchAgents(): Promise<AgentSnapshot[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fetch_agents_request",
    });
    const parsed = parseFetchAgentsResponse(response.payload);
    return parsed?.agents ?? [];
  }

  /** 拉取 agent 时间线尾部。 */
  async fetchAgentTimeline(agentId: string, limit = 50): Promise<AgentTimelineEntry[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fetch_agent_timeline_request",
      agentId,
      direction: "tail",
      limit,
    });
    const parsed = parseFetchTimelineResponse(response.payload);
    if (parsed?.error) throw new Error(parsed.error);
    return parsed?.entries ?? [];
  }

  /**
   * 订阅 agent 时间线流（daemon 之后的 agent_stream 推送经 onStreamEvent 回调）。
   * 返回 daemon 确认的 subscriptionId（作为集成测试握手成功的证据）。
   */
  async subscribeAgentTimelines(agentIds: string[]): Promise<{ subscriptionId?: string }> {
    const response = await this.request<{ type: string; payload: { subscriptionId?: string } }>({
      type: "agent.timeline.set_subscription.request",
      agentIds,
    });
    return { subscriptionId: response.payload?.subscriptionId };
  }

  /** 向 agent 发送消息。 */
  async sendAgentMessage(
    agentId: string,
    text: string,
  ): Promise<{ accepted: boolean; error: string | null }> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "send_agent_message_request",
      agentId,
      text,
      attachments: [],
    });
    const parsed = parseSendAgentMessageResponse(response.payload);
    return parsed
      ? { accepted: parsed.accepted, error: parsed.error }
      : { accepted: false, error: "响应解析失败" };
  }

  /** daemon 状态（设置页展示）。 */
  async fetchDaemonStatus(): Promise<DaemonStatus | null> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "daemon.get_status.request",
    });
    return parseDaemonStatusPayload(response.payload);
  }

  close(code = 1000, reason = "client close"): void {
    this.failHelloWaiters(new Error("连接已关闭"));
    this.failAllPending(new Error("连接已关闭"));
    this.unbindSocket?.();
    this.unbindSocket = null;
    this.socket?.close(code, reason);
    this.socket = null;
    this.setState("closed", reason);
  }
}
