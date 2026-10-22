/**
 * Paseo daemon 协议子集类型（MVP 用到的消息）。
 *
 * 来源：vendor 自 packages/protocol/src/messages.ts（以及 agent-lifecycle.ts）。
 * 官方 schema 使用 zod；这里手工挑出小程序 MVP 需要的消息子集并手写为 TS 接口。
 * 协议约定向后兼容（新字段可选、不删除字段），因此"只解析认识的字段、
 * 其余忽略"是官方认可的客户端策略（docs/protocol-compatibility.md）。
 * 所有解析都配合 parse* 守卫函数做防御式读取。
 */

// --- agent-lifecycle.ts: AGENT_LIFECYCLE_STATUSES ---
export type AgentLifecycleStatus = "initializing" | "idle" | "running" | "error" | "closed";

/** messages.ts: AgentSnapshotPayloadSchema（子集：UI 需要的字段） */
export interface AgentSnapshot {
  id: string;
  title: string | null;
  provider: string;
  model: string | null;
  status: AgentLifecycleStatus;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  lastUserMessageAt: string | null;
  archivedAt?: string | null;
  requiresAttention?: boolean;
}

/** messages.ts: FetchAgentsResponseMessageSchema.payload.entries[i].agent 即 AgentSnapshot */
export interface FetchAgentsResponse {
  requestId: string;
  subscriptionId?: string | null;
  agents: AgentSnapshot[];
}

/** messages.ts: AgentTimelineItemPayloadSchema（子集：可渲染的条目） */
export type AgentTimelineItem =
  | {
      type: "user_message";
      text: string;
      /** messages.ts user_message 条目上的可选幂等/消息 id（t17 附件回配对用）。 */
      messageId?: string;
      clientMessageId?: string;
    }
  | { type: "assistant_message"; text: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool_call";
      tool: string;
      status: "running" | "completed" | "failed" | "canceled";
      summary?: string;
      error?: string;
    }
  | { type: "todo"; items: Array<{ text: string; completed: boolean }> }
  | { type: "error"; message: string }
  | { type: "notification"; level: "info" | "warning" | "error"; message: string }
  | { type: "compaction"; status: "loading" | "completed" }
  | { type: "unknown"; raw: unknown };

/** messages.ts: AgentTimelineEntryPayloadSchema（子集） */
export interface AgentTimelineEntry {
  item: AgentTimelineItem;
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  turnId?: string;
}

export interface FetchAgentTimelineResponse {
  requestId: string;
  agentId: string;
  entries: AgentTimelineEntry[];
  hasOlder: boolean;
  error: string | null;
}

/** messages.ts: AgentStreamEventPayloadSchema（子集） */
export type AgentStreamEvent =
  | { type: "thread_started"; sessionId: string }
  | { type: "turn_started" }
  | { type: "turn_completed" }
  | { type: "turn_failed"; error: string }
  | { type: "turn_canceled"; reason: string }
  | { type: "timeline"; item: AgentTimelineItem; seq?: number }
  | { type: "permission_requested"; summary: string }
  | { type: "attention_required"; reason: string };

export interface AgentStreamPayload {
  agentId: string;
  event: AgentStreamEvent;
  timestamp: string;
  seq?: number;
}

/** messages.ts: ServerInfoStatusPayloadSchema（子集） */
export interface ServerInfo {
  serverId: string;
  version?: string | null;
  hostname?: string | null;
}

/** messages.ts: DaemonGetStatusResponseSchema.payload（子集，设置页展示） */
export interface DaemonStatus {
  serverId: string;
  version?: string | null;
  pid: number;
  startedAt?: string | null;
  listen?: string | null;
  relay?: {
    enabled: boolean;
    endpoint: string;
    publicEndpoint: string;
    useTls: boolean;
  } | null;
}

/** messages.ts: SendAgentMessageResponseMessageSchema.payload */
export interface SendAgentMessageResponse {
  requestId: string;
  agentId: string;
  accepted: boolean;
  error: string | null;
}

// --- t17：文件浏览 / 二进制读取 / 附件上传（vendor 自 messages.ts 与 client） ---

/** messages.ts: FileExplorerEntrySchema */
export interface FileExplorerEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size: number;
  modifiedAt: string;
}

/** messages.ts: FileExplorerDirectorySchema */
export interface FileExplorerDirectory {
  path: string;
  entries: FileExplorerEntry[];
}

/** messages.ts: FileExplorerFileSchema（无 acceptBinary 的 legacy JSON 路径） */
export interface LegacyFileExplorerFile {
  path: string;
  kind: "text" | "image" | "binary";
  encoding: "utf-8" | "base64" | "none";
  content?: string;
  mimeType?: string;
  size: number;
  modifiedAt: string;
  revision?: string;
}

/** messages.ts: FileExplorerResponseMessageSchema.payload */
export interface FileExplorerResponsePayload {
  cwd: string;
  path: string;
  mode: "list" | "file";
  directory: FileExplorerDirectory | null;
  file: LegacyFileExplorerFile | null;
  error: string | null;
  requestId: string;
}

/**
 * client daemon-client.ts FileReadResult：二进制帧读到的统一结果。
 * kind 判定与官方 binaryFileKind 一致（image 开头 → image；utf-8 或 text/json → text）。
 */
export interface FileReadResult {
  bytes: Uint8Array;
  mime: string;
  size: number;
  path: string;
  kind: "text" | "image" | "binary";
  modifiedAt: string;
  revision?: string;
}

/** messages.ts: UploadedFileAttachmentSchema（file.upload.response 返回并随消息发送） */
export interface UploadedFileAttachment {
  type: "uploaded_file";
  id: string;
  fileName: string;
  mimeType: string;
  size: number;
  path: string;
}

/** messages.ts: file.upload.response payload */
export interface FileUploadResponse {
  requestId: string;
  file: UploadedFileAttachment | null;
  error: string | null;
}

// --- t16：工作区 / provider 目录 / 创建 / 控制 / 权限（均 vendor 自 messages.ts） ---

/** messages.ts: WorkspaceDescriptorPayloadSchema（子集：选择器需要的字段） */
export interface WorkspaceDescriptor {
  id: string;
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
  workspaceDirectory: string | null;
  name: string;
  title: string | null;
  status: "needs_input" | "failed" | "running" | "attention" | "done";
  activityAt: string | null;
}

/** messages.ts: WorkspaceProjectDescriptorPayloadSchema（子集：无活跃工作区的项目父级） */
export interface WorkspaceProjectDescriptor {
  projectId: string;
  projectDisplayName: string;
  projectRootPath: string;
}

/** messages.ts: FetchWorkspacesResponseMessageSchema.payload（子集） */
export interface FetchWorkspacesResponse {
  requestId: string;
  workspaces: WorkspaceDescriptor[];
  emptyProjects: WorkspaceProjectDescriptor[];
  hasMore: boolean;
  nextCursor: string | null;
}

/** messages.ts: ListAvailableProvidersResponseSchema.payload.providers[i] */
export interface ProviderAvailability {
  provider: string;
  available: boolean;
  error?: string | null;
}

/** messages.ts: AgentModelDefinitionSchema（子集） */
export interface ProviderModelDefinition {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** messages.ts: AgentModeSchema（子集） */
export interface ProviderMode {
  id: string;
  label: string;
  description?: string;
}

/** messages.ts: AgentPermissionActionSchema */
export interface PermissionAction {
  id: string;
  label: string;
  behavior: "allow" | "deny";
  variant?: "primary" | "secondary" | "danger";
}

/** messages.ts: AgentPermissionRequestPayloadSchema（子集：actions 缺省时由客户端补默认两档） */
export interface PermissionRequest {
  id: string;
  provider: string;
  name: string;
  kind: "tool" | "plan" | "question" | "mode" | "other";
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  actions: PermissionAction[];
}

/** messages.ts: AgentPermissionRequestMessageSchema.payload（daemon 主动推送） */
export interface PermissionRequestPush {
  agentId: string;
  request: PermissionRequest;
}

/** messages.ts: AgentPermissionResponseMessageSchema.response（客户端回应权限） */
export type PermissionResponsePayload =
  | { behavior: "allow"; selectedActionId?: string }
  | { behavior: "deny"; selectedActionId?: string; message?: string };

/** messages.ts: AgentPermissionResolvedMessageSchema.payload（daemon 主动推送，子集） */
export interface PermissionResolvedPush {
  agentId: string;
  requestId: string;
}

/** 创建 agent 的可选配置（create_agent_request.config 子集 + workspaceId/initialPrompt） */
export interface CreateAgentOptions {
  provider: string;
  cwd: string;
  model?: string;
  modeId?: string;
  workspaceId?: string;
  initialPrompt?: string;
}

/** hello 客户端类型枚举：messages.ts WSHelloMessageSchema.clientType */
export type WsClientType = "mobile" | "browser" | "cli" | "mcp" | "hub";

/** hello 被拒原因：messages.ts WSHelloRejectedMessageSchema.reason */
export type HelloRejectedReason =
  | "password_required"
  | "incorrect_password"
  | "incompatible_protocol";

/** WS 层外层信封：messages.ts WSInboundMessageSchema / WSOutboundMessageSchema（子集） */
export type WsInboundEnvelope =
  | {
      type: "hello";
      clientId: string;
      clientType: WsClientType;
      protocolVersion: number;
      auth?: { kind: "password"; password: string };
    }
  | { type: "ping" }
  | { type: "session"; message: SessionRequestMessage };

export type WsOutboundEnvelope =
  | { type: "pong" }
  | { type: "hello.rejected"; reason: HelloRejectedReason; accepts: string[] }
  | { type: "session"; message: SessionNotificationMessage };

/** MVP 用到的 request 消息（requestId 由 DaemonConnection 生成） */
export type SessionRequestMessage =
  | { type: "fetch_agents_request"; requestId: string; subscribe?: Record<string, never> }
  | {
      type: "fetch_agent_timeline_request";
      requestId: string;
      agentId: string;
      direction?: "tail" | "before" | "after";
      limit?: number;
      projection?: "projected" | "canonical";
    }
  | { type: "agent.timeline.set_subscription.request"; requestId: string; agentIds: string[] }
  | {
      type: "send_agent_message_request";
      requestId: string;
      agentId: string;
      text: string;
      messageId?: string;
      /** t17：uploaded_file 附件（messages.ts AgentAttachmentsSchema 的子集）。 */
      attachments: UploadedFileAttachment[];
    }
  | { type: "daemon.get_status.request"; requestId: string }
  | { type: "fetch_workspaces_request"; requestId: string }
  | { type: "list_available_providers_request"; requestId: string }
  | {
      type: "list_provider_models_request";
      provider: string;
      cwd?: string;
      requestId: string;
    }
  | {
      type: "list_provider_modes_request";
      provider: string;
      cwd?: string;
      requestId: string;
    }
  | {
      type: "create_agent_request";
      requestId: string;
      config: {
        provider: string;
        cwd: string;
        model?: string;
        modeId?: string;
      };
      workspaceId?: string;
      initialPrompt?: string;
    }
  | { type: "cancel_agent_request"; agentId: string; requestId: string }
  | { type: "delete_agent_request"; agentId: string; requestId: string }
  | {
      /** t17：目录列表走 mode:"list"（纯 JSON 响应）。 */
      type: "file_explorer_request";
      requestId: string;
      cwd: string;
      path?: string;
      mode: "list" | "file";
      acceptBinary?: boolean;
      maxBytes?: number;
    }
  | {
      /** t17：上传附件的元数据头；字节走 FileBegin/Chunk/End 二进制帧。 */
      type: "file.upload.request";
      requestId: string;
      fileName: string;
      mimeType: string;
      size: number;
      modifiedAt: string;
    };

/**
 * 权限回应（messages.ts AgentPermissionResponseMessageSchema）。
 * 注意：这里的 requestId 是"权限请求的 id"，不做 RPC 关联——
 * 官方客户端同款 fire-and-forget，结果由 agent_permission_resolved 推送告知。
 */
export interface PermissionResponseMessage {
  type: "agent_permission_response";
  agentId: string;
  requestId: string;
  response: PermissionResponsePayload;
}

/** MVP 关心的 daemon 主动推送 / 响应消息 */
export type SessionNotificationMessage =
  | { type: "status"; payload: { status: "server_info" } & Record<string, unknown> }
  | { type: "agent_stream"; payload: AgentStreamPayload & Record<string, unknown> }
  | {
      type: "agent_update";
      payload: { kind: "upsert" | "remove"; agent?: unknown; agentId?: string } & Record<
        string,
        unknown
      >;
    }
  | { type: "fetch_agents_response"; payload: Record<string, unknown> & { requestId: string } }
  | {
      type: "fetch_agent_timeline_response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | {
      type: "agent.timeline.set_subscription.response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | {
      type: "send_agent_message_response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | { type: "daemon.get_status.response"; payload: Record<string, unknown> & { requestId: string } }
  | { type: "fetch_workspaces_response"; payload: Record<string, unknown> & { requestId: string } }
  | {
      type: "list_available_providers_response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | {
      type: "list_provider_models_response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | {
      type: "list_provider_modes_response";
      payload: Record<string, unknown> & { requestId: string };
    }
  | { type: "cancel_agent_response"; payload: Record<string, unknown> & { requestId: string } }
  | { type: "agent_deleted"; payload: Record<string, unknown> & { requestId: string } }
  | {
      type: "agent_permission_request";
      payload: { agentId?: unknown; request?: unknown } & Record<string, unknown>;
    }
  | {
      type: "agent_permission_resolved";
      payload: { agentId?: unknown; requestId?: unknown } & Record<string, unknown>;
    }
  | { type: string; payload?: Record<string, unknown> & { requestId?: string } };

// ---------------------------------------------------------------------------
// 防御式解析守卫（协议向前兼容：未知字段忽略、未知枚举归入宽容值）
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function nullableStr(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function bool(value: unknown): boolean {
  return value === true;
}

const LIFECYCLE_STATUSES = new Set(["initializing", "idle", "running", "error", "closed"]);

export function parseAgentSnapshot(value: unknown): AgentSnapshot | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const provider = str(value.provider);
  if (!id || !provider) return null;
  const statusRaw = str(value.status);
  const status =
    statusRaw && LIFECYCLE_STATUSES.has(statusRaw)
      ? (statusRaw as AgentLifecycleStatus)
      : "initializing";
  return {
    id,
    title: nullableStr(value.title),
    provider,
    model: nullableStr(value.model),
    status,
    cwd: str(value.cwd) ?? "",
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? "",
    lastUserMessageAt: nullableStr(value.lastUserMessageAt),
    archivedAt: nullableStr(value.archivedAt),
    requiresAttention: bool(value.requiresAttention),
  };
}

export function parseTimelineItem(value: unknown): AgentTimelineItem {
  if (!isRecord(value)) return { type: "unknown", raw: value };
  switch (value.type) {
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return value.type === "user_message"
        ? {
            type: "user_message",
            text: str(value.text) ?? "",
            ...(str(value.messageId) ? { messageId: str(value.messageId) ?? "" } : {}),
            ...(str(value.clientMessageId)
              ? { clientMessageId: str(value.clientMessageId) ?? "" }
              : {}),
          }
        : { type: value.type, text: str(value.text) ?? "" };
    case "tool_call": {
      const status = str(value.status);
      return {
        type: "tool_call",
        tool: str(value.tool) ?? str(value.name) ?? "",
        status:
          status === "completed" || status === "failed" || status === "canceled"
            ? status
            : "running",
        summary: str(value.summary) ?? undefined,
        error: value.error == null ? undefined : String(value.error),
      };
    }
    case "todo": {
      const items = Array.isArray(value.items)
        ? value.items.map((raw) => {
            const entry = isRecord(raw) ? raw : {};
            return { text: str(entry.text) ?? "", completed: bool(entry.completed) };
          })
        : [];
      return { type: "todo", items };
    }
    case "error":
      return { type: "error", message: str(value.message) ?? String(value.message ?? "") };
    case "notification":
      return {
        type: "notification",
        level:
          str(value.level) === "warning" || str(value.level) === "error"
            ? (str(value.level) as "warning" | "error")
            : "info",
        message: str(value.message) ?? "",
      };
    case "compaction":
      return {
        type: "compaction",
        status: str(value.status) === "completed" ? "completed" : "loading",
      };
    default:
      return { type: "unknown", raw: value };
  }
}

export function parseTimelineEntry(value: unknown): AgentTimelineEntry | null {
  if (!isRecord(value)) return null;
  const seqStart = typeof value.seqStart === "number" ? value.seqStart : null;
  if (seqStart === null) return null;
  return {
    item: parseTimelineItem(value.item),
    timestamp: str(value.timestamp) ?? "",
    seqStart,
    seqEnd: typeof value.seqEnd === "number" ? value.seqEnd : seqStart,
    turnId: str(value.turnId) ?? undefined,
  };
}

export function parseFetchAgentsResponse(payload: unknown): FetchAgentsResponse | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const agents = entries
    .map((entry) => (isRecord(entry) ? parseAgentSnapshot(entry.agent) : null))
    .filter((agent): agent is AgentSnapshot => agent !== null);
  return {
    requestId,
    subscriptionId: nullableStr(payload.subscriptionId) ?? undefined,
    agents,
  };
}

export function parseFetchTimelineResponse(payload: unknown): FetchAgentTimelineResponse | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  const agentId = str(payload.agentId);
  if (!requestId || !agentId) return null;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  return {
    requestId,
    agentId,
    entries: entries
      .map(parseTimelineEntry)
      .filter((entry): entry is AgentTimelineEntry => entry !== null),
    hasOlder: bool(payload.hasOlder),
    error: nullableStr(payload.error),
  };
}

export function parseAgentStreamPayload(payload: unknown): AgentStreamPayload | null {
  if (!isRecord(payload)) return null;
  const agentId = str(payload.agentId);
  const event = isRecord(payload.event) ? payload.event : null;
  if (!agentId || !event) return null;
  let parsedEvent: AgentStreamEvent;
  switch (event.type) {
    case "thread_started":
      parsedEvent = { type: "thread_started", sessionId: str(event.sessionId) ?? "" };
      break;
    case "turn_started":
    case "turn_completed":
      parsedEvent = { type: event.type };
      break;
    case "turn_failed":
      parsedEvent = { type: "turn_failed", error: str(event.error) ?? "" };
      break;
    case "turn_canceled":
      parsedEvent = { type: "turn_canceled", reason: str(event.reason) ?? "" };
      break;
    case "timeline":
      parsedEvent = {
        type: "timeline",
        item: parseTimelineItem(event.item),
        seq: typeof payload.seq === "number" ? payload.seq : undefined,
      };
      break;
    case "permission_requested":
      parsedEvent = {
        type: "permission_requested",
        summary: str(event.request) ? summarizePermissionRequest(event.request) : "",
      };
      break;
    case "attention_required":
      parsedEvent = { type: "attention_required", reason: str(event.reason) ?? "" };
      break;
    default:
      return null;
  }
  return {
    agentId,
    event: parsedEvent,
    timestamp: str(payload.timestamp) ?? "",
    seq: typeof payload.seq === "number" ? payload.seq : undefined,
  };
}

function summarizePermissionRequest(request: unknown): string {
  if (!isRecord(request)) return "";
  const title = str(request.title) ?? str(request.toolName) ?? "";
  const message = str(request.message) ?? "";
  return [title, message].filter(Boolean).join("：");
}

export function parseServerInfoPayload(payload: unknown): ServerInfo | null {
  if (!isRecord(payload) || str(payload.status) !== "server_info") return null;
  const serverId = str(payload.serverId);
  if (!serverId) return null;
  return {
    serverId,
    version: nullableStr(payload.version),
    hostname: nullableStr(payload.hostname),
  };
}

export function parseDaemonStatusPayload(payload: unknown): DaemonStatus | null {
  if (!isRecord(payload)) return null;
  const serverId = str(payload.serverId);
  if (!serverId) return null;
  const relayRaw = isRecord(payload.relay) ? payload.relay : null;
  return {
    serverId,
    version: nullableStr(payload.version),
    pid: typeof payload.pid === "number" ? payload.pid : 0,
    startedAt: nullableStr(payload.startedAt),
    listen: nullableStr(payload.listen),
    relay: relayRaw
      ? {
          enabled: bool(relayRaw.enabled),
          endpoint: str(relayRaw.endpoint) ?? "",
          publicEndpoint: str(relayRaw.publicEndpoint) ?? "",
          useTls: bool(relayRaw.useTls),
        }
      : null,
  };
}

export function parseSendAgentMessageResponse(payload: unknown): SendAgentMessageResponse | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  return {
    requestId,
    agentId: str(payload.agentId) ?? "",
    accepted: bool(payload.accepted),
    error: nullableStr(payload.error),
  };
}

// ---------------------------------------------------------------------------
// t16 新增消息的解析守卫
// ---------------------------------------------------------------------------

const WORKSPACE_STATUS_BUCKETS = new Set(["needs_input", "failed", "running", "attention", "done"]);

function parseWorkspaceDescriptor(value: unknown): WorkspaceDescriptor | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  const statusRaw = str(value.status);
  return {
    id,
    projectId: str(value.projectId) ?? "",
    projectDisplayName: str(value.projectDisplayName) ?? "",
    projectRootPath: str(value.projectRootPath) ?? "",
    workspaceDirectory: nullableStr(value.workspaceDirectory),
    name: str(value.name) ?? "",
    title: nullableStr(value.title),
    status:
      statusRaw && WORKSPACE_STATUS_BUCKETS.has(statusRaw)
        ? (statusRaw as WorkspaceDescriptor["status"])
        : "done",
    activityAt: nullableStr(value.activityAt),
  };
}

function parseWorkspaceProjectDescriptor(value: unknown): WorkspaceProjectDescriptor | null {
  if (!isRecord(value)) return null;
  const projectId = str(value.projectId);
  if (!projectId) return null;
  return {
    projectId,
    projectDisplayName: str(value.projectDisplayName) ?? "",
    projectRootPath: str(value.projectRootPath) ?? "",
  };
}

export function parseFetchWorkspacesResponse(payload: unknown): FetchWorkspacesResponse | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  const entries = Array.isArray(payload.entries) ? payload.entries : [];
  const emptyRaw = Array.isArray(payload.emptyProjects) ? payload.emptyProjects : [];
  const pageInfo = isRecord(payload.pageInfo) ? payload.pageInfo : {};
  return {
    requestId,
    workspaces: entries
      .map(parseWorkspaceDescriptor)
      .filter((w): w is WorkspaceDescriptor => w !== null),
    emptyProjects: emptyRaw
      .map(parseWorkspaceProjectDescriptor)
      .filter((p): p is WorkspaceProjectDescriptor => p !== null),
    hasMore: bool(pageInfo.hasMore),
    nextCursor: nullableStr(pageInfo.nextCursor),
  };
}

export function parseListAvailableProvidersResponse(
  payload: unknown,
): ProviderAvailability[] | null {
  if (!isRecord(payload)) return null;
  const providers = Array.isArray(payload.providers) ? payload.providers : [];
  return providers
    .map((raw): ProviderAvailability | null => {
      if (!isRecord(raw)) return null;
      const provider = str(raw.provider);
      if (!provider) return null;
      return { provider, available: bool(raw.available), error: nullableStr(raw.error) };
    })
    .filter((p): p is ProviderAvailability => p !== null);
}

export function parseProviderModelsResponse(payload: unknown): ProviderModelDefinition[] | null {
  if (!isRecord(payload)) return null;
  const models = Array.isArray(payload.models) ? payload.models : [];
  return models
    .map((raw): ProviderModelDefinition | null => {
      if (!isRecord(raw)) return null;
      const id = str(raw.id);
      if (!id) return null;
      return {
        id,
        label: str(raw.label) ?? id,
        description: nullableStr(raw.description) ?? undefined,
        isDefault: bool(raw.isDefault) || undefined,
      };
    })
    .filter((m): m is ProviderModelDefinition => m !== null);
}

export function parseProviderModesResponse(payload: unknown): ProviderMode[] | null {
  if (!isRecord(payload)) return null;
  const modes = Array.isArray(payload.modes) ? payload.modes : [];
  return modes
    .map((raw): ProviderMode | null => {
      if (!isRecord(raw)) return null;
      const id = str(raw.id);
      if (!id) return null;
      return {
        id,
        label: str(raw.label) ?? id,
        description: nullableStr(raw.description) ?? undefined,
      };
    })
    .filter((m): m is ProviderMode => m !== null);
}

const PERMISSION_KINDS = new Set(["tool", "plan", "question", "mode", "other"]);

/** actions 缺省时补官方默认两档（app PermissionRequestCard 同款兜底）。 */
function defaultPermissionActions(): PermissionAction[] {
  return [
    { id: "reject", label: "拒绝", behavior: "deny", variant: "danger" },
    { id: "accept", label: "允许", behavior: "allow", variant: "primary" },
  ];
}

export function parsePermissionRequest(value: unknown): PermissionRequest | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  const kindRaw = str(value.kind);
  const actionsRaw = Array.isArray(value.actions) ? value.actions : [];
  const actions = actionsRaw
    .map((raw): PermissionAction | null => {
      if (!isRecord(raw)) return null;
      const actionId = str(raw.id);
      const label = str(raw.label);
      const behavior = str(raw.behavior);
      if (!actionId || !label || (behavior !== "allow" && behavior !== "deny")) return null;
      const variant = str(raw.variant);
      return {
        id: actionId,
        label,
        behavior,
        variant:
          variant === "primary" || variant === "secondary" || variant === "danger"
            ? variant
            : undefined,
      };
    })
    .filter((a): a is PermissionAction => a !== null);
  const input = isRecord(value.input) ? (value.input as Record<string, unknown>) : undefined;
  return {
    id,
    provider: str(value.provider) ?? "",
    name: str(value.name) ?? "",
    kind:
      kindRaw && PERMISSION_KINDS.has(kindRaw) ? (kindRaw as PermissionRequest["kind"]) : "other",
    title: nullableStr(value.title) ?? undefined,
    description: nullableStr(value.description) ?? undefined,
    input,
    actions: actions.length > 0 ? actions : defaultPermissionActions(),
  };
}

export function parsePermissionRequestPush(payload: unknown): PermissionRequestPush | null {
  if (!isRecord(payload)) return null;
  const agentId = str(payload.agentId);
  const request = parsePermissionRequest(payload.request);
  if (!agentId || !request) return null;
  return { agentId, request };
}

export function parsePermissionResolvedPush(payload: unknown): PermissionResolvedPush | null {
  if (!isRecord(payload)) return null;
  const agentId = str(payload.agentId);
  const requestId = str(payload.requestId);
  if (!agentId || !requestId) return null;
  return { agentId, requestId };
}

/**
 * create_agent_request 的应答：daemon 以 status 推送（agent_created / agent_create_failed），
 * requestId 在 payload 内，经通用 pending 关联回来后再用这里解析。
 */
export function parseCreateAgentStatusPayload(
  payload: unknown,
): { ok: true; agent: AgentSnapshot } | { ok: false; error: string } | null {
  if (!isRecord(payload)) return null;
  if (payload.status === "agent_created") {
    const agent = parseAgentSnapshot(payload.agent);
    return agent ? { ok: true, agent } : null;
  }
  if (payload.status === "agent_create_failed") {
    return { ok: false, error: str(payload.error) ?? "创建失败" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// t17：文件浏览 / 上传响应解析
// ---------------------------------------------------------------------------

function parseFileExplorerEntry(value: unknown): FileExplorerEntry | null {
  if (!isRecord(value)) return null;
  const name = str(value.name);
  const path = str(value.path);
  if (!name || !path) return null;
  const kind = str(value.kind) === "directory" ? "directory" : "file";
  return {
    name,
    path,
    kind,
    size: typeof value.size === "number" ? value.size : 0,
    modifiedAt: str(value.modifiedAt) ?? "",
  };
}

export function parseFileExplorerResponse(payload: unknown): FileExplorerResponsePayload | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  const mode = str(payload.mode) === "file" ? "file" : "list";
  let directory: FileExplorerDirectory | null = null;
  if (isRecord(payload.directory)) {
    const dirPath = str(payload.directory.path);
    const entriesRaw = Array.isArray(payload.directory.entries) ? payload.directory.entries : [];
    directory = {
      path: dirPath ?? "",
      entries: entriesRaw
        .map(parseFileExplorerEntry)
        .filter((e): e is FileExplorerEntry => e !== null),
    };
  }
  let file: LegacyFileExplorerFile | null = null;
  if (isRecord(payload.file)) {
    const filePath = str(payload.file.path);
    if (filePath) {
      const kindRaw = str(payload.file.kind);
      const encodingRaw = str(payload.file.encoding);
      file = {
        path: filePath,
        kind: kindRaw === "image" || kindRaw === "binary" ? kindRaw : "text",
        encoding: encodingRaw === "base64" || encodingRaw === "none" ? encodingRaw : "utf-8",
        content: nullableStr(payload.file.content) ?? undefined,
        mimeType: nullableStr(payload.file.mimeType) ?? undefined,
        size: typeof payload.file.size === "number" ? payload.file.size : 0,
        modifiedAt: str(payload.file.modifiedAt) ?? "",
        revision: nullableStr(payload.file.revision) ?? undefined,
      };
    }
  }
  return {
    cwd: str(payload.cwd) ?? "",
    path: str(payload.path) ?? "",
    mode,
    directory,
    file,
    error: nullableStr(payload.error),
    requestId,
  };
}

export function parseFileUploadResponse(payload: unknown): FileUploadResponse | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  let file: UploadedFileAttachment | null = null;
  if (isRecord(payload.file)) {
    const id = str(payload.file.id);
    const fileName = str(payload.file.fileName);
    if (id && fileName && str(payload.file.type) === "uploaded_file") {
      file = {
        type: "uploaded_file",
        id,
        fileName,
        mimeType: str(payload.file.mimeType) ?? "application/octet-stream",
        size: typeof payload.file.size === "number" ? payload.file.size : 0,
        path: str(payload.file.path) ?? "",
      };
    }
  }
  return { requestId, file, error: nullableStr(payload.error) };
}

/** 官方 client binaryFileKind：mime/encoding → 展示类型。 */
export function binaryFileKind(mime: string, encoding: string): FileReadResult["kind"] {
  if (mime.startsWith("image/")) return "image";
  if (encoding === "utf-8" || mime.startsWith("text/") || mime === "application/json") {
    return "text";
  }
  return "binary";
}
