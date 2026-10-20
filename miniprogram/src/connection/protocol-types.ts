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
  | { type: "user_message"; text: string }
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
      attachments: [];
    }
  | { type: "daemon.get_status.request"; requestId: string };

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
      return { type: value.type, text: str(value.text) ?? "" };
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
