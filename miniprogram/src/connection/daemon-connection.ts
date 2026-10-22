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
  parseCreateAgentStatusPayload,
  parseDaemonStatusPayload,
  parseFetchAgentsResponse,
  parseFetchTimelineResponse,
  parseFetchWorkspacesResponse,
  parseFileExplorerResponse,
  parseFileUploadResponse,
  parseListAvailableProvidersResponse,
  parsePermissionRequestPush,
  parsePermissionResolvedPush,
  parseProviderModelsResponse,
  parseProviderModesResponse,
  parseSendAgentMessageResponse,
  parseServerInfoPayload,
  type AgentSnapshot,
  type AgentStreamPayload,
  type AgentTimelineEntry,
  type CreateAgentOptions,
  type DaemonStatus,
  type FetchWorkspacesResponse,
  type FileExplorerEntry,
  type FileReadResult,
  type PermissionRequestPush,
  type PermissionResolvedPush,
  type PermissionResponseMessage,
  type PermissionResponsePayload,
  type ProviderAvailability,
  type ProviderModelDefinition,
  type ProviderMode,
  type ServerInfo,
  type SessionRequestMessage,
  type UploadedFileAttachment,
  type WsClientType,
} from "./protocol-types";
import {
  decodeFileTransferFrame,
  encodeFileTransferFrame,
  FileTransferOpcode,
  type FileBeginMetadata,
} from "./file-transfer-frames";
import { base64ToArrayBuffer } from "./nacl-box";
import { encodeUtf8 } from "./utf8";
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
    for (const [, waiter] of this.binaryReads) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.binaryReads.clear();
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") {
      // t17：文件传输二进制帧（终端流不在小程序范围，解码失败即忽略）。
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

  /** 向 agent 发送消息（t17：可携带 uploaded_file 附件与幂等 messageId）。 */
  async sendAgentMessage(
    agentId: string,
    text: string,
    options?: { messageId?: string; attachments?: UploadedFileAttachment[] },
  ): Promise<{ accepted: boolean; error: string | null }> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "send_agent_message_request",
      agentId,
      text,
      ...(options?.messageId ? { messageId: options.messageId } : {}),
      attachments: options?.attachments ?? [],
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

  /** provider 的模型目录（list_provider_models_request；daemon 不含目录时返回空）。 */
  async listProviderModels(provider: string, cwd?: string): Promise<ProviderModelDefinition[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "list_provider_models_request",
      provider,
      ...(cwd ? { cwd } : {}),
    });
    return parseProviderModelsResponse(response.payload) ?? [];
  }

  /** provider 的模式列表（list_provider_modes_request）。 */
  async listProviderModes(provider: string, cwd?: string): Promise<ProviderMode[]> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "list_provider_modes_request",
      provider,
      ...(cwd ? { cwd } : {}),
    });
    return parseProviderModesResponse(response.payload) ?? [];
  }

  /**
   * 创建 agent（create_agent_request）。
   * 应答不是独立 RPC response，而是 status 推送（agent_created/agent_create_failed），
   * requestId 在 payload 内，由通用 pending 关联回来后再解析。
   */
  async createAgent(options: CreateAgentOptions): Promise<AgentSnapshot> {
    const response = await this.request<{ type: string; payload: unknown }>({
      type: "create_agent_request",
      config: {
        provider: options.provider,
        cwd: options.cwd,
        ...(options.model ? { model: options.model } : {}),
        ...(options.modeId ? { modeId: options.modeId } : {}),
      },
      ...(options.workspaceId ? { workspaceId: options.workspaceId } : {}),
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
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
  // t17：文件浏览 / 二进制读取 / 附件上传
  // ---------------------------------------------------------------------------

  /** 列目录（file_explorer_request mode:"list"；排序：目录优先、名称不区分大小写）。 */
  async listDirectory(cwd: string, path: string, timeoutMs?: number): Promise<FileExplorerEntry[]> {
    const response = await this.request<{ type: string; payload: unknown }>(
      { type: "file_explorer_request", cwd, path, mode: "list" },
      timeoutMs,
    );
    const parsed = parseFileExplorerResponse(response.payload);
    if (!parsed) throw new Error("目录列表解析失败");
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.directory) throw new Error("目录不可用");
    return sortDirectoryEntries(parsed.directory.entries);
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

  /** 二进制帧入口（daemon → 客户端方向的 FileBegin/Chunk/End）。 */
  private handleBinaryFrame(bytes: Uint8Array): void {
    const frame = decodeFileTransferFrame(bytes);
    if (!frame) return;

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
    this.unbindSocket?.();
    this.unbindSocket = null;
    this.socket?.close(code, reason);
    this.socket = null;
    this.setState("closed", reason);
  }
}
