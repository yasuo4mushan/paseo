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
  binaryFileKind,
  parseAgentSnapshot,
  parseAgentStreamPayload,
  parseAttentionPush,
  parseCommitsListResponse,
  parseCommitFileDiffResponse,
  parseCreateAgentStatusPayload,
  parseDaemonStatusPayload,
  parseFetchAgentsResponse,
  parseFetchTimelineResponse,
  parseFetchWorkspacesResponse,
  parseFileEntryMutationResponse,
  parseFileExplorerResponse,
  parseFileSubscribeResponse,
  parseFileUpdatePush,
  parseFileUploadResponse,
  parseFileWriteResponse,
  parseGithubCloneResponse,
  parseListAvailableProvidersResponse,
  parseListCommandsResponse,
  parseOpenProjectResponse,
  parsePermissionRequestPush,
  parsePermissionResolvedPush,
  parseProviderModelsResult,
  parseProviderModesResponse,
  parseRecentProviderSessionsResponse,
  parseScheduleDeleteResponse,
  parseScheduleListResponse,
  parseScheduleLogsResponse,
  parseScheduleMutationResponse,
  parseSendAgentMessageResponse,
  parseServerInfoPayload,
  parseSubagentsListResponse,
  parseSubagentUpdate,
  parseSubscribeTerminalResponse,
  parseTerminalInfo,
  parseUpdateAgentResponse,
  parseAgentActionResponse,
  parseAgentRewindResponse,
  parseKillTerminalResponse,
  parseWorkspaceScriptResponse,
  type AgentSnapshot,
  type AgentStreamPayload,
  type AgentTimelineEntry,
  type AttentionPush,
  type CheckoutCommit,
  type CreateAgentOptions,
  type DaemonStatus,
  type FetchWorkspacesResponse,
  type FileEntryMutationResult,
  type FileExplorerEntry,
  type FileReadResult,
  type FileSubscribeResult,
  type FileUpdatePush,
  type FileWriteResult,
  type ParsedDiffFile,
  type PermissionRequestPush,
  type PermissionResolvedPush,
  type PermissionResponseMessage,
  type PermissionResponsePayload,
  type ProviderAvailability,
  type ProviderModelsResult,
  type ProviderMode,
  type ProviderSubagentSummary,
  type RecentProviderSession,
  type ScheduleCadence,
  type ScheduleCreateTarget,
  type ScheduleRun,
  type ScheduleSummary,
  type ServerInfo,
  type SessionRequestMessage,
  type SlashCommand,
  type SubagentUpdate,
  type TerminalInfo,
  type TerminalInputMessage,
  type UploadedFileAttachment,
  type WorkspaceScriptInfo,
  type WsClientType,
} from "./protocol-types";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileBeginMetadata,
} from "./file-transfer-frames";
import {
  decodeTerminalStreamFrame,
  TerminalStreamOpcode,
  type TerminalStreamFrame,
} from "./terminal-frames";
import { base64ToArrayBuffer } from "./nacl-box";
import { encodeUtf8 } from "./utf8";
import type { PlaintextPort, PlaintextPortFactory, SocketEventHandler } from "./websocket-port";

/**
 * provider 目录（模型/模式）RPC 专用超时。冷快照时 daemon 要先拉起 provider CLI
 * 探测目录（t31-d 实测：zcode app-server session/create ~30s、qoder daemon 侧上限
 * 120s），默认 15s 必然超时并把错误吞成空目录。60s 覆盖常见冷启动；超时由调用方
 * 以错误态展示并可重试（daemon 按 cwd 去重 warmup，重试不会重复探测）。
 */
const PROVIDER_CATALOG_TIMEOUT_MS = 60_000;

export interface DaemonConnectionOptions {
  clientId: string;
  clientType?: WsClientType;
  password?: string;
  appVersion?: string;
  /** RPC 默认超时（毫秒）。 */
  requestTimeoutMs?: number;
  /** hello 之后等待 server_info 的超时（毫秒）。 */
  helloTimeoutMs?: number;
  /** 文件读取（下载）默认超时（毫秒），t17。 */
  readFileTimeoutMs?: number;
}

export type DaemonConnectionState = "idle" | "connecting" | "connected" | "closed" | "error";

export interface DaemonConnectionEvents {
  onStateChange?: (state: DaemonConnectionState, detail?: string) => void;
  onServerInfo?: (info: ServerInfo) => void;
  onStreamEvent?: (payload: AgentStreamPayload) => void;
  onAgentUpdate?: (
    update: { kind: "upsert"; agent: AgentSnapshot } | { kind: "remove"; agentId: string },
  ) => void;
  /** daemon 推送权限请求（agent_permission_request，legacy 客户端免订阅）。 */
  onPermissionRequest?: (push: PermissionRequestPush) => void;
  /** daemon 推送权限已解决（本端或其他端已回应）。 */
  onPermissionResolved?: (push: PermissionResolvedPush) => void;
  /** t18：daemon 推送 agent_attention_required（legacy 客户端免订阅）。 */
  onAttention?: (push: AttentionPush) => void;
  /** t19：daemon 推送 fs.file.update（订阅中的文件被修改）。 */
  onFileUpdate?: (push: FileUpdatePush) => void;
  /** t19：daemon 推送 agent.provider_subagents.update（子 agent upsert/remove）。 */
  onSubagentUpdate?: (update: SubagentUpdate) => void;
  /** t19：终端观察流结束（daemon 侧 detach；error 为观察失败，非进程退出）。 */
  onTerminalExit?: (payload: { terminalId: string; error?: string }) => void;
  onDisconnect?: (code: number, reason: string) => void;
}

interface PendingRequest {
  resolve: (message: Record<string, unknown> & { requestId?: string }) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  responseType: string;
}

/** 二进制文件读取（file_explorer_request acceptBinary）的等待者状态。 */
interface BinaryReadWaiter {
  cwd: string;
  path: string;
  maxBytes?: number;
  resolve: (result: FileReadResult) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  /** FileBegin 之后建立的传输累积状态。 */
  transfer: {
    metadata: FileBeginMetadata;
    received: number;
    chunks: Uint8Array[];
  } | null;
  /** 下载进度回调（已收字节/总字节）。 */
  onProgress?: (received: number, total: number) => void;
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

/** status 推送 payload 里的 error 字段容错读取（t18 导入/恢复共用）。 */
function strError(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/** 目录排序：目录在前，同级按名称不区分大小写（对齐 app 文件浏览器展示习惯）。 */
function sortDirectoryEntries(entries: FileExplorerEntry[]): FileExplorerEntry[] {
  return [...entries].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
  });
}

export class DaemonConnection {
  private portFactory: PlaintextPortFactory;
  private options: DaemonConnectionOptions & {
    clientType: Exclude<DaemonConnectionOptions["clientType"], undefined>;
    requestTimeoutMs: number;
    helloTimeoutMs: number;
    readFileTimeoutMs: number;
  };
  private events: DaemonConnectionEvents;
  private socket: PlaintextPort | null = null;
  private unbindSocket: (() => void) | null = null;
  private state: DaemonConnectionState = "idle";
  private pending = new Map<string, PendingRequest>();
  private binaryReads = new Map<string, BinaryReadWaiter>();
  private serverInfo: ServerInfo | null = null;
  private helloWaiters: Array<{
    resolve: (info: ServerInfo) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private closeReason: { code: number; reason: string } | null = null;
  private lastError: string | null = null;
  /** agent 目录订阅 id（fetch_agents subscribe 建立；后续 fetch 复用以免叠加订阅）。 */
  private agentsSubscriptionId: string | null = null;
  /**
   * t19：终端流 slot → 订阅者（subscribe_terminal_response 分配 slot 后注册）。
   * terminal_stream_exit 按 terminalId 释放对应 slot。
   */
  private terminalSlots = new Map<
    number,
    { terminalId: string; receive: (frame: TerminalStreamFrame) => void }
  >();

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
      readFileTimeoutMs: options.readFileTimeoutMs ?? 120_000,
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
      // t31：必须声明 all_providers——daemon 对未声明该能力且 appVersion < 0.1.45 的
      // 客户端只下发 LEGACY_PROVIDER_IDS（claude/codex/opencode），zcode/kimi/qwen 等
      // provider 的 agent 与 provider 目录会被整体过滤（session.ts isProviderVisibleToClient）。
      // 本端解析器（parseAgentSnapshot 等）接受任意 provider 字符串，可以安全声明。
      // 仍不声明 owned_subscriptions：保留 legacy 隐式 agent_stream 推送路径
      // （server session.ts 的 COMPAT(ownedSubscriptions) 分支），同时
      // agent.timeline.set_subscription.request 依然生效。
      capabilities: { all_providers: true },
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
    for (const [, waiter] of this.binaryReads) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.binaryReads.clear();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      // 二进制帧：文件传输（0x10+）与终端流（0x01-0x05）两个通道。
      this.handleBinaryFrame(new Uint8Array(data));
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
        return;
      }
      // 非 server_info 的 status（如 create_agent 的 agent_created/agent_create_failed）
      // 走 requestId 关联，落到下方通用响应分发。
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

    if (message.type === "agent_permission_request") {
      const push = parsePermissionRequestPush(message.payload);
      if (push) this.events.onPermissionRequest?.(push);
      return;
    }

    if (message.type === "agent_permission_resolved") {
      const push = parsePermissionResolvedPush(message.payload);
      if (push) this.events.onPermissionResolved?.(push);
      // requestId 是权限请求 id，通常没有对应 pending；继续走通用分发也无副作用
    }

    // t18：attention 推送（legacy 客户端免订阅，服务端 wantsEvent 直接放行）。
    if (message.type === "agent_attention_required") {
      const push = parseAttentionPush(message.payload);
      if (push) this.events.onAttention?.(push);
      return;
    }

    // t19：fs.file.update 推送（编辑器远端变更检测）。
    if (message.type === "fs.file.update") {
      const push = parseFileUpdatePush(message.payload);
      if (push) this.events.onFileUpdate?.(push);
      return;
    }

    // t19：子 agent 轨道推送（upsert/remove；timeline 子事件由 parseSubagentUpdate 归零）。
    if (message.type === "agent.provider_subagents.update") {
      const update = parseSubagentUpdate(message.payload);
      if (update) this.events.onSubagentUpdate?.(update);
      return;
    }

    // t19：终端观察流结束（按 terminalId 释放对应 slot；页面据此停止等待输出）。
    if (message.type === "terminal_stream_exit") {
      const payload = message.payload as { terminalId?: unknown; error?: unknown } | undefined;
      const terminalId = typeof payload?.terminalId === "string" ? payload.terminalId : null;
      if (terminalId) {
        for (const [slot, registration] of this.terminalSlots) {
          if (registration.terminalId === terminalId) this.terminalSlots.delete(slot);
        }
        this.events.onTerminalExit?.({
          terminalId,
          ...(typeof payload?.error === "string" ? { error: payload.error } : {}),
        });
      }
      return;
    }

    // t17：file_explorer_response 只服务二进制读取等待者——
    // acceptBinary 成功路径没有 JSON 响应（daemon 只发帧），这里只会收到
    // 错误响应或无二进制通道的 legacy 内容响应。
    if (message.type === "file_explorer_response") {
      const filePayload = message.payload as { requestId?: unknown } | undefined;
      if (filePayload && typeof filePayload.requestId === "string") {
        const waiter = this.binaryReads.get(filePayload.requestId);
        if (waiter) {
          this.settleBinaryReadFromJson(filePayload.requestId, waiter, message.payload);
          return;
        }
      }
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
  private request<T>(message: SessionRequestInput, timeoutMs?: number): Promise<T> {
    return this.requestWithId<T>(createRequestId(), message, timeoutMs);
  }

  /** 同 request，但使用调用方提供的 requestId（上传等需要帧与 JSON 关联的场景）。 */
  private requestWithId<T>(
    requestId: string,
    message: SessionRequestInput,
    timeoutMs?: number,
  ): Promise<T> {
    if (this.state !== "connected" || !this.socket) {
      return Promise.reject(new Error("未连接 daemon"));
    }
    const fullMessage = { ...message, requestId } as SessionRequestMessage;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`RPC 超时：${message.type}`));
      }, timeoutMs ?? this.options.requestTimeoutMs);
      this.pending.set(requestId, {
        resolve: (msg) => resolve(msg as unknown as T),
        reject,
        timer,
        responseType: message.type,
      });
      this.sendEnvelope({ type: "session", message: fullMessage });
    });
  }

  /** 拉取 agent 列表（t18：可选包含归档项 + 建立 agent_update 订阅）。 */
  async fetchAgents(options?: { includeArchived?: boolean }): Promise<AgentSnapshot[]> {
    const subscribe = {
      ...(this.agentsSubscriptionId ? { subscriptionId: this.agentsSubscriptionId } : {}),
    };
    const response = await this.request<{
      type: string;
      payload: { requestId: string; subscriptionId?: string };
    }>({
      type: "fetch_agents_request",
      subscribe,
      ...(options?.includeArchived ? { filter: { includeArchived: true } } : {}),
    });
    const parsed = parseFetchAgentsResponse(response.payload);
    if (parsed?.subscriptionId) this.agentsSubscriptionId = parsed.subscriptionId;
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

  /** 向 agent 发送消息（t17 附件/幂等；t19 activeTurnBehavior 运行中行为）。 */
  async sendAgentMessage(
    agentId: string,
    text: string,
    options?: {
      messageId?: string;
      attachments?: UploadedFileAttachment[];
      /** t19：运行中再发消息 → "interrupt" 先中断再投递；缺省 steer。 */
      activeTurnBehavior?: "interrupt" | "steer";
    },
  ): Promise<{ accepted: boolean; error: string | null }> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "send_agent_message_request",
      agentId,
      text,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
      attachments: options?.attachments ?? [],
      ...(options?.activeTurnBehavior ? { activeTurnBehavior: options.activeTurnBehavior } : {}),
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

  /** 拉取工作区列表（fetch_workspaces_request；含无活跃工作区的项目父级）。 */
  async fetchWorkspaces(): Promise<FetchWorkspacesResponse> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fetch_workspaces_request",
    });
    const parsed = parseFetchWorkspacesResponse(response.payload);
    if (!parsed) throw new Error("工作区列表解析失败");
    return parsed;
  }

  /** 可用 provider 列表（list_available_providers_request）。 */
  async listAvailableProviders(): Promise<ProviderAvailability[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "list_available_providers_request",
    });
    return parseListAvailableProvidersResponse(response.payload) ?? [];
  }

  /**
   * provider 的模型目录（list_provider_models_request）。
   * t31-d：daemon 失败时只回 {provider, error}——错误必须透出（result.error），
   * 不能静默折叠成空列表（否则「模型/thinking 为空」无从解释）。
   * 目录请求用专用超时：daemon 冷快照要先拉起 provider CLI 探测
   * （codex 走 app-server session/create；实测 zcode ~30s、qoder 上限 120s），
   * 默认 15s 会在冷启动时必然超时。
   */
  async listProviderModels(provider: string, cwd?: string): Promise<ProviderModelsResult> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "list_provider_models_request",
        provider,
        ...(cwd ? { cwd } : {}),
      },
      PROVIDER_CATALOG_TIMEOUT_MS,
    );
    if (response.type === "rpc_error") {
      const error = (response.payload as { error?: unknown })?.error;
      return {
        models: [],
        error: typeof error === "string" && error ? error : "daemon 不支持该请求",
      };
    }
    return (
      parseProviderModelsResult(response.payload) ?? { models: [], error: "模型目录响应解析失败" }
    );
  }

  /** provider 的模式列表（list_provider_modes_request；冷快照同理用目录超时）。 */
  async listProviderModes(provider: string, cwd?: string): Promise<ProviderMode[]> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "list_provider_modes_request",
        provider,
        ...(cwd ? { cwd } : {}),
      },
      PROVIDER_CATALOG_TIMEOUT_MS,
    );
    return parseProviderModesResponse(response.payload) ?? [];
  }

  /**
   * 创建 agent（create_agent_request）。
   * 应答不是独立 RPC response，而是 status 推送（agent_created/agent_create_failed），
   * requestId 在 payload 内，由通用 pending 关联回来后再解析。
   */
  async createAgent(
    options: CreateAgentOptions & {
      /** t19：worktree 隔离（branch-off 新分支）。 */
      worktree?: { mode: "branch-off"; newBranch: string; base?: string };
    },
  ): Promise<AgentSnapshot> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "create_agent_request",
      config: {
        provider: options.provider,
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.modeId ? { modeId: options.modeId } : {}),
        ...(options.thinkingOptionId ? { thinkingOptionId: options.thinkingOptionId } : {}),
      },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
      ...(options.worktree ? { worktree: options.worktree } : {}),
    });
    const parsed = parseCreateAgentStatusPayload(response.payload);
    if (!parsed) throw new Error("创建响应解析失败");
    if (!parsed.ok) throw new Error(parsed.error);
    return parsed.agent;
  }

  /** 中断 agent 当前 turn（cancel_agent_request）。 */
  async cancelAgent(agentId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "cancel_agent_request",
      agentId,
    });
    const payload = response.payload as { error?: unknown };
    if (typeof payload?.error === "string" && payload.error) {
      throw new Error(payload.error);
    }
  }

  /** 删除 agent（delete_agent_request；应答是 agent_deleted 推送，requestId 关联）。 */
  async deleteAgent(agentId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "delete_agent_request",
      agentId,
    });
    const payload = response.payload as { agentId?: unknown };
    if (typeof payload?.agentId === "string" && payload.agentId !== agentId) {
      throw new Error("删除响应的 agentId 不匹配");
    }
  }

  // ---------------------------------------------------------------------------
  // t18：归档/标签 / attention 清除 / 会话导入 / 项目注册 / 脚本 / 定时任务
  // ---------------------------------------------------------------------------

  /** 归档 agent（archive_agent_request；应答 agent_archived 推送，requestId 关联）。 */
  async archiveAgent(agentId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "archive_agent_request",
      agentId,
    });
    const payload = response.payload as { agentId?: unknown; error?: unknown };
    if (typeof payload?.agentId === "string" && payload.agentId !== agentId) {
      throw new Error("归档响应的 agentId 不匹配");
    }
    if (typeof payload?.error === "string" && payload.error) throw new Error(payload.error);
  }

  /**
   * 恢复归档 agent（refresh_agent_request；unarchive 语义，app archived-agent-callout 同款）。
   * 应答是 status 推送 agent_refreshed / agent_create_failed（requestId 关联）。
   */
  async refreshAgent(agentId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "refresh_agent_request",
      agentId,
    });
    const payload = response.payload as { status?: unknown; error?: unknown };
    if (payload?.status === "agent_create_failed") {
      throw new Error(strError(payload.error) ?? "恢复失败");
    }
  }

  /** 改名 / 打标签（update_agent_request → update_agent_response）。labels 为全量替换。 */
  async updateAgent(
    agentId: string,
    input: { name?: string; labels?: Record<string, string> },
  ): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "update_agent_request",
      agentId,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.labels !== undefined ? { labels: input.labels } : {}),
    });
    const parsed = parseUpdateAgentResponse(response.payload);
    if (!parsed) throw new Error("更新响应解析失败");
    if (!parsed.accepted) throw new Error(parsed.error ?? "更新被拒绝");
  }

  /** 清除 attention（clear_agent_attention → clear_agent_attention_response）。 */
  async clearAgentAttention(agentIds: string[]): Promise<void> {
    if (agentIds.length === 0) return;
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "clear_agent_attention",
      agentId: agentIds.length === 1 ? agentIds[0] : agentIds,
    });
    const payload = response.payload as { error?: unknown };
    if (typeof payload?.error === "string" && payload.error) throw new Error(payload.error);
  }

  // ---------------------------------------------------------------------------
  // t20：会话中配置切换（composer 四 pill → set_agent_mode/model/thinking）。
  // 三个 RPC 的响应同为 AgentActionResponsePayload（accepted/error/notice）。
  // ---------------------------------------------------------------------------

  /** 审批模式切换（set_agent_mode_request；provider modes 见 listProviderModes）。 */
  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "set_agent_mode_request",
      agentId,
      modeId,
    });
    const parsed = parseAgentActionResponse(response.payload);
    if (!parsed) throw new Error("模式切换响应解析失败");
    if (!parsed.accepted) throw new Error(parsed.error ?? "模式切换被拒绝");
  }

  /** 模型切换（set_agent_model_request；null = 清除自定义回 provider 默认）。 */
  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "set_agent_model_request",
      agentId,
      modelId,
    });
    const parsed = parseAgentActionResponse(response.payload);
    if (!parsed) throw new Error("模型切换响应解析失败");
    if (!parsed.accepted) throw new Error(parsed.error ?? "模型切换被拒绝");
  }

  /** thinking 档位切换（set_agent_thinking_request；null = 清除）。 */
  async setAgentThinking(agentId: string, thinkingOptionId: string | null): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "set_agent_thinking_request",
      agentId,
      thinkingOptionId,
    });
    const parsed = parseAgentActionResponse(response.payload);
    if (!parsed) throw new Error("thinking 切换响应解析失败");
    if (!parsed.accepted) throw new Error(parsed.error ?? "thinking 切换被拒绝");
  }

  /** t20：终止终端 PTY（kill_terminal_request；验收后清理，页面退出时按需调用）。 */
  async killTerminal(terminalId: string): Promise<boolean> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "kill_terminal_request", terminalId },
      15_000,
    );
    const parsed = parseKillTerminalResponse(response.payload);
    return parsed?.success ?? false;
  }

  /**
   * t25：会话回退（agent.rewind.request → agent.rewind.response）。
   * 编辑重发的底层语义：conversation 模式把会话回退到该 user_message 之前
   * （daemon 侧先取消运行中 turn，回退后广播 timeline 重置）。响应在回退
   * 完成后返回，调用方随后重取时间线 + 重发修正文本。
   * messageId 取时间线 user_message 条目的 messageId（乐观本地条目没有 →
   * 上层降级为草稿模式，不走本 RPC）。
   */
  async rewindAgent(
    agentId: string,
    messageId: string,
    mode: "conversation" | "files" | "both",
  ): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "agent.rewind.request", agentId, messageId, mode },
      60_000,
    );
    const parsed = parseAgentRewindResponse(response.payload);
    if (!parsed) throw new Error("回退响应解析失败");
    if (!parsed.ok) throw new Error(parsed.error ?? "回退失败");
  }

  /** provider 会话列表（fetch_recent_provider_sessions_request）。 */
  async fetchRecentProviderSessions(input?: { cwd?: string; limit?: number }): Promise<{
    entries: RecentProviderSession[];
    providerErrors: Array<{ provider: string; message: string }>;
  }> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fetch_recent_provider_sessions_request",
      ...(input?.cwd ? { cwd: input.cwd } : {}),
      ...(input?.limit ? { limit: input.limit } : {}),
    });
    const parsed = parseRecentProviderSessionsResponse(response.payload);
    if (!parsed) throw new Error("会话列表解析失败");
    return parsed;
  }

  /**
   * 导入 provider 会话（import_agent_request）。
   * 应答是 status 推送 agent_resumed（成功）或 agent_create_failed（失败），requestId 关联。
   */
  async importAgent(input: {
    provider: string;
    providerHandleId: string;
    cwd?: string;
    workspaceId?: string;
  }): Promise<AgentSnapshot> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "import_agent_request",
      provider: input.provider,
      providerHandleId: input.providerHandleId,
      ...(input.cwd ? { cwd: input.cwd } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    });
    const payload = response.payload as { status?: unknown; agent?: unknown; error?: unknown };
    if (payload?.status === "agent_resumed") {
      const agent = parseAgentSnapshot(payload.agent);
      if (agent) return agent;
    }
    if (payload?.status === "agent_create_failed") {
      throw new Error(strError(payload.error) ?? "导入失败");
    }
    throw new Error("导入响应解析失败");
  }

  /** 注册本机目录为项目工作区（open_project_request；新建工作区最小路径）。 */
  async openProject(cwd: string): Promise<FetchWorkspacesResponse["workspaces"][number]> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "open_project_request", cwd },
      30_000,
    );
    const parsed = parseOpenProjectResponse(response.payload);
    if (!parsed) throw new Error("注册响应解析失败");
    if (parsed.error || !parsed.workspace) throw new Error(parsed.error ?? "目录注册失败");
    return parsed.workspace;
  }

  /** GitHub 仓库 clone（project.github.clone.request；clone 可能耗时，超时放宽）。 */
  async cloneGithubProject(input: {
    repo: string;
    targetDirectory: string;
    cloneProtocol?: "https" | "ssh";
  }): Promise<{ checkoutPath: string }> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "project.github.clone.request",
        repo: input.repo,
        targetDirectory: input.targetDirectory,
        ...(input.cloneProtocol ? { cloneProtocol: input.cloneProtocol } : {}),
      },
      180_000,
    );
    const parsed = parseGithubCloneResponse(response.payload);
    if (!parsed) throw new Error("clone 响应解析失败");
    if (parsed.error || !parsed.checkoutPath) throw new Error(parsed.error ?? "clone 失败");
    return { checkoutPath: parsed.checkoutPath };
  }

  /** workspace scripts 列表（workspace.script.list.request）。 */
  async listWorkspaceScripts(workspaceId: string): Promise<WorkspaceScriptInfo[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "workspace.script.list.request",
      workspaceId,
    });
    const parsed = parseWorkspaceScriptResponse(response.payload);
    if (!parsed) throw new Error("脚本列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.scripts;
  }

  /** 触发 workspace script（start/stop；输出走终端流，小程序只展示状态，见 t19 注记）。 */
  async workspaceScriptAction(
    action: "start" | "stop",
    workspaceId: string,
    scriptName: string,
  ): Promise<WorkspaceScriptInfo | null> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: action === "start" ? "workspace.script.start.request" : "workspace.script.stop.request",
      workspaceId,
      scriptName,
    });
    const parsed = parseWorkspaceScriptResponse(response.payload);
    if (!parsed) throw new Error("脚本操作解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.scripts[0] ?? null;
  }

  /** 定时任务列表（schedule/list）。 */
  async listSchedules(): Promise<ScheduleSummary[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "schedule/list",
    });
    const parsed = parseScheduleListResponse(response.payload);
    if (!parsed) throw new Error("定时任务列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.schedules;
  }

  /** 创建定时任务（schedule/create）。 */
  async createSchedule(input: {
    prompt: string;
    name?: string;
    cadence: ScheduleCadence;
    target: ScheduleCreateTarget;
    maxRuns?: number;
    runOnCreate?: boolean;
  }): Promise<ScheduleSummary> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "schedule/create",
      prompt: input.prompt,
      cadence: input.cadence,
      target: input.target,
      ...(input.name ? { name: input.name } : {}),
      ...(input.maxRuns ? { maxRuns: input.maxRuns } : {}),
      ...(input.runOnCreate ? { runOnCreate: true } : {}),
    });
    const parsed = parseScheduleMutationResponse(response.payload);
    if (!parsed) throw new Error("创建响应解析失败");
    if (parsed.error || !parsed.schedule) throw new Error(parsed.error ?? "创建失败");
    return parsed.schedule;
  }

  /** 暂停/恢复定时任务（schedule/pause | resume）。 */
  async setSchedulePaused(scheduleId: string, paused: boolean): Promise<ScheduleSummary> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: paused ? "schedule/pause" : "schedule/resume",
      scheduleId,
    });
    const parsed = parseScheduleMutationResponse(response.payload);
    if (!parsed) throw new Error("操作响应解析失败");
    if (parsed.error || !parsed.schedule) throw new Error(parsed.error ?? "操作失败");
    return parsed.schedule;
  }

  /** 手动触发一次（schedule/run-once；返回含 runs 的完整 schedule）。 */
  async runScheduleOnce(scheduleId: string): Promise<ScheduleSummary> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "schedule/run-once", scheduleId },
      30_000,
    );
    const parsed = parseScheduleMutationResponse(response.payload);
    if (!parsed) throw new Error("触发响应解析失败");
    if (parsed.error || !parsed.schedule) throw new Error(parsed.error ?? "触发失败");
    return parsed.schedule;
  }

  /** 删除定时任务（schedule/delete）。 */
  async deleteSchedule(scheduleId: string): Promise<void> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "schedule/delete",
      scheduleId,
    });
    const parsed = parseScheduleDeleteResponse(response.payload);
    if (!parsed) throw new Error("删除响应解析失败");
    if (parsed.error) throw new Error(parsed.error);
  }

  /** 定时任务执行记录（schedule/logs）。 */
  async scheduleLogs(scheduleId: string): Promise<ScheduleRun[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "schedule/logs",
      scheduleId,
    });
    const parsed = parseScheduleLogsResponse(response.payload);
    if (!parsed) throw new Error("执行记录解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.runs;
  }

  // ---------------------------------------------------------------------------
  // t19：文件写回 / 条目操作 / 文件订阅 / diff / 终端 / subagents / 斜杠命令
  // ---------------------------------------------------------------------------

  /**
   * 写回文本文件（fs.file.write.request）。
   * 冲突协议：expectedModifiedAt/expectedRevision 是"读时版本"；daemon 侧版本
   * 不一致时返回 status:"conflict" + 当前版本，由上层提示用户重载或覆盖。
   */
  async writeFile(input: {
    cwd: string;
    path: string;
    content: string;
    expectedModifiedAt: string;
    expectedRevision?: string;
  }): Promise<FileWriteResult> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "fs.file.write.request",
        cwd: input.cwd,
        path: input.path,
        content: input.content,
        expectedModifiedAt: input.expectedModifiedAt,
        ...(input.expectedRevision ? { expectedRevision: input.expectedRevision } : {}),
      },
      30_000,
    );
    return (
      parseFileWriteResponse(response.payload) ?? { status: "error", error: "写入响应解析失败" }
    );
  }

  /** 新建文件/文件夹（fs.entry.create.request）。 */
  async createFsEntry(input: {
    cwd: string;
    parentPath: string;
    name: string;
    kind: "file" | "directory";
  }): Promise<FileEntryMutationResult> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fs.entry.create.request",
      cwd: input.cwd,
      parentPath: input.parentPath,
      name: input.name,
      kind: input.kind,
    });
    return (
      parseFileEntryMutationResponse(response.payload) ?? { success: false, error: "响应解析失败" }
    );
  }

  /** 重命名条目（fs.entry.rename.request；name 为新 basename）。 */
  async renameFsEntry(input: {
    cwd: string;
    path: string;
    name: string;
  }): Promise<FileEntryMutationResult> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fs.entry.rename.request",
      cwd: input.cwd,
      path: input.path,
      name: input.name,
    });
    return (
      parseFileEntryMutationResponse(response.payload) ?? { success: false, error: "响应解析失败" }
    );
  }

  /** 删除条目（fs.entry.delete.request；文件与目录同签名）。 */
  async deleteFsEntry(input: { cwd: string; path: string }): Promise<FileEntryMutationResult> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fs.entry.delete.request",
      cwd: input.cwd,
      path: input.path,
    });
    return (
      parseFileEntryMutationResponse(response.payload) ?? { success: false, error: "响应解析失败" }
    );
  }

  /**
   * 订阅文件版本变更（fs.file.subscribe.request）。
   * 变更推送经 onFileUpdate；返回 subscriptionId 供退订。
   */
  async subscribeFile(input: { cwd: string; path: string }): Promise<FileSubscribeResult> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "fs.file.subscribe.request",
      cwd: input.cwd,
      path: input.path,
    });
    const parsed = parseFileSubscribeResponse(response.payload);
    if (!parsed) throw new Error("文件订阅失败");
    return parsed;
  }

  /** 退订文件变更。 */
  async unsubscribeFile(subscriptionId: string): Promise<void> {
    await this.request<{ type: string; payload: unknown }>({
      type: "fs.file.unsubscribe.request",
      subscriptionId,
    });
  }

  /** commit 列表（checkout.commits.list.request；agent 会话改动溯源入口）。 */
  async listCommits(cwd: string): Promise<{ commits: CheckoutCommit[]; baseRef: string | null }> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "checkout.commits.list.request", cwd },
      30_000,
    );
    const parsed = parseCommitsListResponse(response.payload);
    if (!parsed) throw new Error("commit 列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return { commits: parsed.commits, baseRef: parsed.baseRef };
  }

  /** 单 commit 单文件 diff（checkout.commits.file_diff.request）。 */
  async getCommitFileDiff(input: {
    cwd: string;
    sha: string;
    path: string;
  }): Promise<ParsedDiffFile | null> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "checkout.commits.file_diff.request",
        cwd: input.cwd,
        sha: input.sha,
        path: input.path,
      },
      30_000,
    );
    const parsed = parseCommitFileDiffResponse(response.payload);
    if (!parsed) throw new Error("diff 响应解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.file;
  }

  /**
   * 订阅终端流（subscribe_terminal_request → slot；Restore/Output 帧经 onFrame）。
   * detach() 释放 slot 并退订。restore.visible-snapshot：daemon 先回放存量输出
   * （Restore 帧 = snapshot 渲染的 ANSI 文本）再持续推 Output。
   */
  async subscribeTerminal(
    terminalId: string,
    onFrame: (frame: TerminalStreamFrame) => void,
    options?: { scrollbackLines?: number },
  ): Promise<{ slot: number; subscriptionId?: string; detach: () => void }> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "subscribe_terminal_request",
      terminalId,
      restore: {
        mode: "visible-snapshot",
        ...(options?.scrollbackLines ? { scrollbackLines: options.scrollbackLines } : {}),
      },
    });
    const parsed = parseSubscribeTerminalResponse(response.payload);
    if (!parsed) throw new Error("终端订阅响应解析失败");
    if (parsed.error !== null) throw new Error(parsed.error);
    const registration = { terminalId, receive: onFrame };
    this.terminalSlots.set(parsed.slot, registration);
    return {
      slot: parsed.slot,
      ...(parsed.subscriptionId ? { subscriptionId: parsed.subscriptionId } : {}),
      detach: () => {
        const current = this.terminalSlots.get(parsed.slot);
        if (current === registration) this.terminalSlots.delete(parsed.slot);
        void this.request({ type: "unsubscribe_terminal_request", terminalId }).catch(() => {});
      },
    };
  }

  /** 终端输入/尺寸（terminal_input；fire-and-forget）。 */
  sendTerminalInput(terminalId: string, message: TerminalInputMessage["message"]): void {
    const input: TerminalInputMessage = { type: "terminal_input", terminalId, message };
    this.sendEnvelope({ type: "session", message: input });
  }

  /** 打开新终端（工作区终端入口；返回 terminalId 供 subscribeTerminal）。 */
  async createTerminal(input: {
    cwd: string;
    workspaceId?: string;
    name?: string;
  }): Promise<TerminalInfo> {
    const response = await this.request<{ type: string; payload: unknown }>(
      {
        type: "create_terminal_request",
        cwd: input.cwd,
        ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
        ...(input.name ? { name: input.name } : {}),
      },
      30_000,
    );
    const payload = response.payload as { terminal?: unknown; error?: unknown };
    if (typeof payload?.error === "string" && payload.error) throw new Error(payload.error);
    const terminal = parseTerminalInfo(payload?.terminal);
    if (!terminal) throw new Error("终端创建响应解析失败");
    return terminal;
  }

  /** 子 agent 列表（agent.provider_subagents.list.request）。 */
  async listSubagents(parentAgentId: string): Promise<ProviderSubagentSummary[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "agent.provider_subagents.list.request",
      parentAgentId,
    });
    const parsed = parseSubagentsListResponse(response.payload);
    if (!parsed) throw new Error("子 agent 列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    return parsed.subagents;
  }

  /** composer 斜杠命令目录（list_commands_request）。 */
  async listCommands(agentId: string): Promise<SlashCommand[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "list_commands_request",
      agentId,
    });
    const parsed = parseListCommandsResponse(response.payload);
    if (!parsed) throw new Error("命令列表解析失败");
    return parsed;
  }

  // ---------------------------------------------------------------------------
  // t17：文件浏览 / 二进制读取 / 附件上传
  // ---------------------------------------------------------------------------

  /**
   * 列目录（file_explorer_request mode:"list"；排序：目录优先、名称不区分大小写）。
   *
   * t24 考古结论：cwd 并不限定在已注册工作区——daemon 侧 expandUserPath 接受任意
   * 绝对路径或 "~"，path 只受"不得逃出 cwd"约束（assertWithinWorkspace）。
   * folder-picker 固定 cwd="/"、path 传相对 trail，即可浏览整盘。
   */
  async listDirectory(cwd: string, path: string, timeoutMs?: number): Promise<FileExplorerEntry[]> {
    const result = await this.browseDirectory(cwd, path, timeoutMs);
    return result.entries;
  }

  /**
   * 列目录并返回归一化路径（t24 folder-picker 用）。
   * 返回的 path 是相对所传 cwd 的归一化路径（cwd="/" 时即去头斜杠的绝对 trail，
   * 如 "Users/xxx/projects"；path 传 "~" 时 daemon 展开 home 后同样归一化）。
   */
  async browseDirectory(
    cwd: string,
    path: string,
    timeoutMs?: number,
  ): Promise<{ path: string; entries: FileExplorerEntry[] }> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "file_explorer_request", cwd, path, mode: "list" },
      timeoutMs,
    );
    const parsed = parseFileExplorerResponse(response.payload);
    if (!parsed) throw new Error("目录列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.directory) throw new Error("目录不可用");
    return {
      path: parsed.directory.path,
      entries: sortDirectoryEntries(parsed.directory.entries),
    };
  }

  /**
   * 读文件（file_explorer_request mode:"file" + acceptBinary）。
   *
   * daemon 有二进制通道时只回 FileBegin/Chunk/End 帧（无 JSON 响应），没有时回
   * legacy JSON（utf-8/base64 内容）。`maxBytes` 仅用于内联预览：daemon 会先检查
   * 文件大小并直接拒绝（"File is too large to display"），不会截断传输。
   * 下载场景不传 maxBytes（完整文件）。
   */
  readFile(input: {
    cwd: string;
    path: string;
    maxBytes?: number;
    timeoutMs?: number;
    onProgress?: (received: number, total: number) => void;
  }): Promise<FileReadResult> {
    if (this.state !== "connected" || !this.socket) {
      return Promise.reject(new Error("未连接 daemon"));
    }
    const requestId = createRequestId();
    return new Promise<FileReadResult>((resolve, reject) => {
      const waiter: BinaryReadWaiter = {
        cwd: input.cwd,
        path: input.path,
        maxBytes: input.maxBytes,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.binaryReads.delete(requestId);
          reject(new Error("读取文件超时"));
        }, input.timeoutMs ?? this.options.readFileTimeoutMs),
        transfer: null,
        onProgress: input.onProgress,
      };
      this.binaryReads.set(requestId, waiter);
      this.sendEnvelope({
        type: "session",
        message: {
          type: "file_explorer_request",
          cwd: input.cwd,
          path: input.path,
          mode: "file",
          acceptBinary: true,
          ...(input.maxBytes ? { maxBytes: input.maxBytes } : {}),
          requestId,
        },
      });
    });
  }

  /**
   * 上传附件（file.upload.request + FileBegin/Chunk/End 二进制帧）。
   * 返回可随 sendAgentMessage 发送的 uploaded_file 附件对象。
   */
  async uploadFile(input: {
    fileName: string;
    mimeType: string;
    bytes: Uint8Array;
    modifiedAt?: string;
    chunkSize?: number;
    onProgress?: (sent: number, total: number) => void;
  }): Promise<UploadedFileAttachment> {
    const bytes = input.bytes;
    if (!bytes || bytes.byteLength === 0) throw new Error("文件内容为空");
    const requestId = createRequestId();
    const modifiedAt = input.modifiedAt ?? new Date().toISOString();
    // 上传总时长与体积正相关：保守按 1MB/s 估算，最少 60s。
    const timeoutMs = Math.max(60_000, bytes.byteLength * 1.5);
    const responsePromise = this.requestWithId<{ type: string; payload: unknown }>(
      requestId,
      {
        type: "file.upload.request",
        fileName: input.fileName,
        mimeType: input.mimeType,
        size: bytes.byteLength,
        modifiedAt,
      },
      timeoutMs,
    );

    this.sendBinaryEnvelope(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId,
        metadata: {
          mime: input.mimeType,
          size: bytes.byteLength,
          encoding: "binary",
          modifiedAt,
          fileName: input.fileName,
        },
      }),
    );

    const chunkSize = input.chunkSize ?? 64 * 1024;
    for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
      // 与官方客户端一致：分片间让出事件循环，避免大文件同步发送阻塞渲染。
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      if (this.state !== "connected") {
        throw new Error("连接已断开，上传中止");
      }
      const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
      this.sendBinaryEnvelope(
        encodeFileTransferFrame({
          opcode: FileTransferOpcode.FileChunk,
          requestId,
          payload: chunk,
        }),
      );
      input.onProgress?.(Math.min(offset + chunkSize, bytes.byteLength), bytes.byteLength);
    }

    this.sendBinaryEnvelope(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId }),
    );

    const response = await responsePromise;
    const parsed = parseFileUploadResponse(response.payload);
    if (!parsed) throw new Error("上传响应解析失败");
    if (parsed.error || !parsed.file) throw new Error(parsed.error ?? "上传失败");
    return parsed.file;
  }

  /** 二进制帧入口（daemon → 客户端方向的 FileBegin/Chunk/End 与终端流帧）。 */
  private handleBinaryFrame(bytes: Uint8Array): void {
    const frame = decodeFileTransferFrame(bytes);
    if (!frame) {
      // t19：非文件帧 → 终端流帧（opcode 0x01-0x05；按 slot 分发）。
      const terminalFrame = decodeTerminalStreamFrame(bytes);
      if (terminalFrame && terminalFrame.opcode !== TerminalStreamOpcode.Input) {
        const registration = this.terminalSlots.get(terminalFrame.slot);
        registration?.receive(terminalFrame);
      }
      return;
    }

    const waiter = this.binaryReads.get(frame.requestId);
    if (!waiter) return;

    if (frame.opcode === FileTransferOpcode.FileBegin) {
      waiter.transfer = { metadata: frame.metadata, received: 0, chunks: [] };
      waiter.onProgress?.(0, frame.metadata.size);
      return;
    }
    if (!waiter.transfer) return;

    if (frame.opcode === FileTransferOpcode.FileChunk) {
      // COMPAT(fileReadByteBudget): 老 daemon 无视 maxBytes 仍全量推流；超限时丢弃分片，
      // 由 End 帧统一转成"文件过大"错误（与官方客户端同款）。
      if (waiter.maxBytes && waiter.transfer.metadata.size > waiter.maxBytes) return;
      waiter.transfer.chunks.push(frame.payload);
      waiter.transfer.received += frame.payload.byteLength;
      waiter.onProgress?.(waiter.transfer.received, waiter.transfer.metadata.size);
      return;
    }

    // FileEnd
    const transfer = waiter.transfer;
    this.binaryReads.delete(frame.requestId);
    clearTimeout(waiter.timer);
    if (waiter.maxBytes && transfer.metadata.size > waiter.maxBytes) {
      waiter.reject(new Error("文件过大，无法预览"));
      return;
    }
    if (transfer.received !== transfer.metadata.size) {
      waiter.reject(
        new Error(`文件传输不完整：期望 ${transfer.metadata.size}，收到 ${transfer.received}`),
      );
      return;
    }
    const merged = new Uint8Array(transfer.received);
    let offset = 0;
    for (const chunk of transfer.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    waiter.resolve({
      bytes: merged,
      mime: transfer.metadata.mime,
      size: transfer.metadata.size,
      path: waiter.path,
      kind: binaryFileKind(transfer.metadata.mime, transfer.metadata.encoding),
      modifiedAt: transfer.metadata.modifiedAt,
      revision: transfer.metadata.revision,
    });
  }

  /** 二进制读取等待者收到 JSON file_explorer_response（错误或 legacy 内容）。 */
  private settleBinaryReadFromJson(
    requestId: string,
    waiter: BinaryReadWaiter,
    payload: unknown,
  ): void {
    const parsed = parseFileExplorerResponse(payload);
    this.binaryReads.delete(requestId);
    clearTimeout(waiter.timer);
    if (!parsed) {
      waiter.reject(new Error("文件响应解析失败"));
      return;
    }
    if (parsed.error) {
      waiter.reject(new Error(parsed.error));
      return;
    }
    if (!parsed.file) {
      waiter.reject(new Error("文件不可用"));
      return;
    }
    // legacy JSON 路径（daemon 无二进制通道）：utf-8 / base64 内容。
    const file = parsed.file;
    let bytes: Uint8Array;
    if (file.encoding === "base64" && file.content) {
      bytes = new Uint8Array(base64ToArrayBuffer(file.content));
    } else if (file.encoding === "utf-8" && file.content) {
      bytes = encodeUtf8(file.content);
    } else {
      bytes = new Uint8Array();
    }
    waiter.resolve({
      bytes,
      mime: file.mimeType ?? "application/octet-stream",
      size: file.size,
      path: file.path,
      kind: file.kind,
      modifiedAt: file.modifiedAt,
      revision: file.revision,
    });
  }

  /** 发送二进制帧（上传方向）。要求端口支持 sendBinary（wx socket / relay E2EE 均支持）。 */
  private sendBinaryEnvelope(bytes: Uint8Array): void {
    if (!this.socket?.sendBinary) {
      throw new Error("当前连接不支持二进制帧");
    }
    // subarray 共享底层 buffer，copy 出独立 ArrayBuffer 保证 byteOffset=0。
    this.socket.sendBinary(bytes.slice().buffer as ArrayBuffer);
  }

  /**
   * 回应权限请求（agent_permission_response，fire-and-forget）。
   * requestId 是权限请求的 id；结果由 agent_permission_resolved 推送告知。
   */
  respondToPermission(
    agentId: string,
    permissionRequestId: string,
    response: PermissionResponsePayload,
  ): void {
    const message: PermissionResponseMessage = {
      type: "agent_permission_response",
      agentId,
      requestId: permissionRequestId,
      response,
    };
    this.sendEnvelope({ type: "session", message });
  }

  close(code = 1000, reason = "client close"): void {
    this.failHelloWaiters(new Error("连接已关闭"));
    this.failAllPending(new Error("连接已关闭"));
    this.agentsSubscriptionId = null; // 订阅随 socket 失效，重连后由下次 fetch 重建
    this.unbindSocket?.();
    this.unbindSocket = null;
    this.socket?.close(code, reason);
    this.socket = null;
    this.setState("closed", reason);
  }
}
