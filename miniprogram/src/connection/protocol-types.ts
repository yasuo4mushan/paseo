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

/** messages.ts: AgentUsageSchema（子集；上下文计量条用）。 */
export interface AgentUsageInfo {
  inputTokens?: number;
  outputTokens?: number;
  totalCostUsd?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

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
  /**
   * t20：composer 四 pill 的会话态数据源。
   * thinkingOptionId/effectiveThinkingOptionId（AgentSnapshotPayload 同名字段，
   * effective 是 provider 侧实际生效值）；currentModeId/availableModes（快照
   * payload 独有，agent_update upsert 推送同样带全量快照，列表拉取即有）。
   */
  thinkingOptionId?: string | null;
  effectiveThinkingOptionId?: string | null;
  currentModeId?: string | null;
  availableModes?: ProviderMode[];
  /** messages.ts AgentListItemPayload.labels：t18 归档/标签用（内部 paseo.* 前缀不展示）。 */
  labels?: Record<string, string>;
  /**
   * messages.ts AgentSnapshotPayload.capabilities（AgentCapabilityFlags 子集）。
   * t25 编辑重发用：supportsRewindConversation 决定"编辑"走 rewind 回退语义
   * 还是降级为"填入输入框作为新消息草稿"（app RewindMenu 的同源开关）。
   */
  capabilities?: {
    supportsRewindConversation?: boolean;
    supportsRewindFiles?: boolean;
    supportsRewindBoth?: boolean;
  };
  /** messages.ts AgentListItemPayload.attentionReason：finished | error | permission。 */
  attentionReason?: "finished" | "error" | "permission" | null;
  /**
   * messages.ts AgentSnapshotPayload.lastUsage：上下文窗口计量（t19）。
   * agent_update upsert 推送带全量 snapshot（含 lastUsage）；fetch_agents
   * 列表项不含，故列表态无计量、进入详情后由推送补上。
   */
  usage?: AgentUsageInfo | null;
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

/** messages.ts: AgentSelectOptionSchema（thinking 档位等选择器选项）。 */
export interface AgentSelectOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** messages.ts: AgentModelDefinitionSchema（子集；t20 补 thinkingOptions）。 */
export interface ProviderModelDefinition {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  /** t20：模型档位（如 GLM 的 thinking 高低档）；空 = 该模型无 thinking 选择。 */
  thinkingOptions?: AgentSelectOption[];
  defaultThinkingOptionId?: string;
}

/** messages.ts: AgentModeSchema（子集） */
export interface ProviderMode {
  id: string;
  label: string;
  description?: string;
}

/**
 * list_provider_models 的完整结果（t31-d）。
 * daemon 失败时（provider 认证失败/CLI 探测超时/不可用）只回 {provider, error}，
 * models 缺席——错误必须透出给 UI，静默映射成空列表会让「模型/thinking 为空」
 * 变成无解释的空白（见 t31-d 根因）。
 */
export interface ProviderModelsResult {
  models: ProviderModelDefinition[];
  /** daemon 侧错误原文；null = 成功（models 可能为空 = provider 确实无目录）。 */
  error: string | null;
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
  /** t20：thinking 档位（AgentSessionConfigSchema.thinkingOptionId）。 */
  thinkingOptionId?: string;
  workspaceId?: string;
  initialPrompt?: string;
}

/** hello 客户端类型枚举：messages.ts WSHelloMessageSchema.clientType */
export type WsClientType = "mobile" | "browser" | "cli" | "mcp" | "hub";

// --- t18：定时任务 / 脚本 / attention 推送 / 会话导入 / 归档标签（vendor 自 packages/protocol） ---

/** protocol/schedule/types.ts ScheduleCadenceSchema */
export type ScheduleCadence =
  | { type: "every"; everyMs: number }
  | { type: "cron"; expression: string; timezone?: string };

/** protocol/schedule/types.ts ScheduleStatusSchema */
export type ScheduleStatus = "active" | "paused" | "completed";

/** protocol/schedule/rpc-schemas.ts ScheduleCreateTargetSchema（self 是老别名，保解析） */
export type ScheduleCreateTarget =
  | { type: "self" | "agent"; agentId: string }
  | {
      type: "new-agent";
      config: {
        provider: string;
        cwd: string;
        modeId?: string;
        model?: string;
        archiveOnFinish?: boolean;
        isolation?: "local" | "worktree";
        title?: string | null;
      };
    };

/** protocol/schedule/types.ts ScheduleRunSchema */
export interface ScheduleRun {
  id: string;
  scheduledFor: string;
  startedAt: string;
  endedAt: string | null;
  status: "running" | "succeeded" | "failed";
  agentId: string | null;
  output: string | null;
  error: string | null;
}

/** protocol/schedule/types.ts ScheduleSummarySchema（StoredSchedule 去掉 runs） */
export interface ScheduleSummary {
  id: string;
  name: string | null;
  prompt: string;
  cadence: ScheduleCadence;
  target: ScheduleCreateTarget;
  status: ScheduleStatus;
  createdAt: string;
  updatedAt: string;
  nextRunAt: string | null;
  lastRunAt: string | null;
  pausedAt: string | null;
  expiresAt: string | null;
  maxRuns: number | null;
  runs?: ScheduleRun[];
}

/** messages.ts AgentAttentionRequiredMessageSchema.payload（推送，legacy 客户端免订阅） */
export interface AttentionPush {
  agentId: string;
  reason: "finished" | "error" | "permission";
  timestamp: string;
  shouldNotify: boolean;
  notification?: { title: string; body: string };
}

/** messages.ts RecentProviderSessionDescriptorPayloadSchema */
export interface RecentProviderSession {
  providerId: string;
  providerLabel: string;
  providerHandleId: string;
  cwd: string;
  title: string | null;
  firstPromptPreview: string | null;
  lastPromptPreview: string | null;
  lastActivityAt: string;
}

/** messages.ts WorkspaceScriptPayloadSchema（子集：状态展示需要的字段） */
export interface WorkspaceScriptInfo {
  scriptName: string;
  type: "script" | "service";
  hostname: string;
  port: number | null;
  proxyUrl: string | null;
  publicProxyUrl: string | null;
  lifecycle: "running" | "stopped";
  health: "healthy" | "unhealthy" | null;
  exitCode: number | null;
  terminalId: string | null;
}

// --- t19：文件写回 / 条目操作 / diff / 终端 / subagents / 斜杠命令 ---

/** messages.ts: FileVersionSchema。 */
export type FileVersionInfo =
  | {
      status: "ready";
      cwd: string;
      path: string;
      size: number;
      modifiedAt: string;
      revision?: string;
    }
  | { status: "missing"; cwd: string; path: string }
  | { status: "error"; cwd: string; path: string; error: string };

/** messages.ts: FileWriteResultSchema（written / conflict(带当前版本) / error）。 */
export type FileWriteResult =
  | { status: "written"; modifiedAt: string; size: number; revision?: string }
  | { status: "conflict"; version: FileVersionInfo }
  | { status: "error"; error: string };

/** messages.ts: fs.entry.*.response 公共形状（create 多 path）。 */
export interface FileEntryMutationResult {
  success: boolean;
  error: string | null;
  path?: string | null;
  renamedPath?: string | null;
}

/** messages.ts: fs.file.subscribe.response。 */
export interface FileSubscribeResult {
  subscriptionId: string;
  initial: FileVersionInfo;
}

/** messages.ts: fs.file.update 推送。 */
export interface FileUpdatePush {
  subscriptionId: string;
  version: FileVersionInfo;
}

/** messages.ts: CheckoutCommitFileSchema。 */
export interface CheckoutCommitFile {
  path: string;
  additions: number;
  deletions: number;
  status?: "added" | "modified" | "deleted" | "renamed";
}

/** messages.ts: CheckoutCommitSchema（子集）。 */
export interface CheckoutCommit {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorDate: string;
  isOnRemote: boolean;
  files: CheckoutCommitFile[];
}

/** messages.ts: DiffLineSchema / DiffHunkSchema / ParsedDiffFileSchema（去高亮 tokens）。 */
export interface DiffLine {
  type: "add" | "remove" | "context" | "header";
  content: string;
}

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface ParsedDiffFile {
  path: string;
  oldPath?: string;
  isNew: boolean;
  isDeleted: boolean;
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
  status?: "ok" | "too_large" | "binary";
}

/** messages.ts: ProviderSubagentDescriptorPayloadSchema（子集：轨道展示用）。 */
export interface ProviderSubagentSummary {
  id: string;
  parentAgentId: string;
  provider: string;
  title: string | null;
  description: string | null;
  status: "running" | "completed" | "failed" | "canceled";
  createdAt: string;
  updatedAt: string;
  subtitle?: string | null;
}

/** messages.ts: agent.provider_subagents.update 推送（upsert/remove；timeline 忽略）。 */
export type SubagentUpdate =
  | { kind: "upsert"; subagent: ProviderSubagentSummary }
  | { kind: "remove"; parentAgentId: string; subagentId: string };

/** messages.ts: AgentSlashCommandSchema。 */
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
  kind?: "command" | "skill";
}

/** messages.ts: TerminalInfoSchema（子集）。 */
export interface TerminalInfo {
  id: string;
  name: string;
  cwd: string;
  workspaceId?: string;
  title?: string;
}

/** messages.ts: subscribe_terminal_response payload（成功带 slot；失败仅 error）。 */
export type SubscribeTerminalResult =
  | { terminalId: string; slot: number; subscriptionId?: string; error: null }
  | { terminalId: string; error: string };

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
  | {
      type: "fetch_agents_request";
      requestId: string;
      /**
       * t18：带 subscribe 建立 agent 目录订阅 → daemon 持续推送 agent_update
       * （messages.ts FetchAgentsRequestMessageSchema.subscribe；不传则 daemon
       * 只回快照、不推送——t15 起的隐性缺口，归档/attention 红点依赖此修复）。
       * subscriptionId 传上次返回值以复用订阅。
       */
      subscribe?: { subscriptionId?: string };
      filter?: { includeArchived?: boolean };
    }
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
      /**
       * t25：会话回退（messages.ts AgentRewindRequestMessageSchema，dotted 命名空间）。
       * 编辑重发的底层语义：conversation 模式把会话回退到该消息之前（app 的
       * RewindMenu 同款 RPC），随后客户端重发修正文本。messageId 取时间线
       * user_message 条目上的 messageId（daemon 侧有 provider 回执映射）。
       */
      type: "agent.rewind.request";
      requestId: string;
      agentId: string;
      messageId: string;
      mode: "conversation" | "files" | "both";
    }
  | {
      type: "send_agent_message_request";
      requestId: string;
      agentId: string;
      text: string;
      messageId?: string;
      /** t17：uploaded_file 附件（messages.ts AgentAttachmentsSchema 的子集）。 */
      attachments: UploadedFileAttachment[];
      /**
       * t19：agent 运行中再发消息的行为。缺省不声明（daemon 默认 steer）；
       * "interrupt" 先中断当前 turn 再投递。
       */
      activeTurnBehavior?: "interrupt" | "steer";
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
      /**
       * t19：worktree 隔离（messages.ts CreateAgentWorktreeTargetSchema 子集）。
       * branch-off：基于 base（缺省当前分支）新建 newBranch 的独立 worktree。
       */
      worktree?: {
        mode: "branch-off";
        newBranch: string;
        base?: string;
      };
    }
  | { type: "cancel_agent_request"; agentId: string; requestId: string }
  | { type: "delete_agent_request"; agentId: string; requestId: string }
  | {
      /** t18：归档 agent；应答 agent_archived 推送（requestId 关联）。 */
      type: "archive_agent_request";
      agentId: string;
      requestId: string;
    }
  | {
      /** t18：恢复归档 agent（unarchive 语义，见 app archived-agent-callout）。 */
      type: "refresh_agent_request";
      agentId: string;
      requestId: string;
    }
  | {
      /** t18：改名/打标签；应答 update_agent_response。 */
      type: "update_agent_request";
      agentId: string;
      name?: string;
      labels?: Record<string, string>;
      requestId: string;
    }
  | {
      /** t18：清除 attention（红点消除）；应答 clear_agent_attention_response。 */
      type: "clear_agent_attention";
      agentId: string | string[];
      requestId: string;
    }
  | {
      /** t18：provider 会话列表（导入已有会话用）。 */
      type: "fetch_recent_provider_sessions_request";
      cwd?: string;
      providers?: string[];
      since?: string;
      limit?: number;
      query?: string;
      requestId: string;
    }
  | {
      /** t18：导入 provider 会话；应答 status 推送 agent_resumed/agent_create_failed。 */
      type: "import_agent_request";
      provider?: string;
      providerId?: string;
      sessionId?: string;
      providerHandleId?: string;
      cwd?: string;
      workspaceId?: string;
      labels?: Record<string, string>;
      requestId: string;
    }
  | {
      /** t18：注册本机目录为项目工作区（新建工作区最小路径）。 */
      type: "open_project_request";
      cwd: string;
      requestId: string;
    }
  | {
      /** t18：GitHub 仓库 clone 到设备目录（repo 形如 owner/name 或完整 URL）。 */
      type: "project.github.clone.request";
      repo: string;
      cloneProtocol?: "https" | "ssh";
      targetDirectory: string;
      requestId: string;
    }
  | {
      /** t18：workspace scripts（package.json scripts 目录）。 */
      type: "workspace.script.list.request";
      workspaceId: string;
      requestId: string;
    }
  | {
      type: "workspace.script.start.request";
      workspaceId: string;
      scriptName: string;
      requestId: string;
    }
  | {
      type: "workspace.script.stop.request";
      workspaceId: string;
      scriptName: string;
      requestId: string;
    }
  | {
      /** t18：定时任务（schedule/rpc-schemas.ts，slash 命名族）。 */
      type: "schedule/list";
      requestId: string;
    }
  | {
      type: "schedule/create";
      prompt: string;
      name?: string;
      cadence: ScheduleCadence;
      target: ScheduleCreateTarget;
      maxRuns?: number;
      expiresAt?: string;
      runOnCreate?: boolean;
      requestId: string;
    }
  | { type: "schedule/pause"; scheduleId: string; requestId: string }
  | { type: "schedule/resume"; scheduleId: string; requestId: string }
  | { type: "schedule/delete"; scheduleId: string; requestId: string }
  | { type: "schedule/run-once"; scheduleId: string; requestId: string }
  | { type: "schedule/logs"; scheduleId: string; requestId: string }
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
    }
  // --- t19：文件写回 / 条目操作 / 文件订阅 ---
  | {
      /** t19：写回文件（fs.file.write.request；expectedModifiedAt 冲突检测）。 */
      type: "fs.file.write.request";
      requestId: string;
      cwd: string;
      path: string;
      content: string;
      expectedModifiedAt: string;
      expectedRevision?: string;
    }
  | {
      /** t19：新建文件/文件夹（fs.entry.create.request）。 */
      type: "fs.entry.create.request";
      requestId: string;
      cwd: string;
      parentPath: string;
      name: string;
      kind: "file" | "directory";
    }
  | {
      /** t19：重命名（fs.entry.rename.request；name 为新 basename）。 */
      type: "fs.entry.rename.request";
      requestId: string;
      cwd: string;
      path: string;
      name: string;
    }
  | {
      /** t19：删除（fs.entry.delete.request；文件与目录同签名）。 */
      type: "fs.entry.delete.request";
      requestId: string;
      cwd: string;
      path: string;
    }
  | {
      /** t19：订阅单个文件版本变更（fs.file.subscribe.request → fs.file.update 推送）。 */
      type: "fs.file.subscribe.request";
      requestId: string;
      cwd: string;
      path: string;
      subscriptionId?: string;
    }
  | {
      /** t19：取消文件订阅。 */
      type: "fs.file.unsubscribe.request";
      requestId: string;
      subscriptionId: string;
    }
  // --- t19：diff（checkout.commits.*） ---
  | { type: "checkout.commits.list.request"; requestId: string; cwd: string }
  | {
      /** t19：单个 commit 内单个文件的解析后 diff。 */
      type: "checkout.commits.file_diff.request";
      requestId: string;
      cwd: string;
      sha: string;
      path: string;
    }
  // --- t19：终端流 ---
  | {
      /** t19：订阅终端输出（→ slot + Restore/Snapshot/Output 二进制帧）。 */
      type: "subscribe_terminal_request";
      requestId: string;
      terminalId: string;
      restore?: {
        mode: "live" | "visible-snapshot" | "full-snapshot";
        scrollbackLines?: number;
      };
    }
  | { type: "unsubscribe_terminal_request"; requestId: string; terminalId: string }
  | {
      /** t19：打开新终端（工作区终端入口用；agent/脚本终端由 daemon 侧自建）。 */
      type: "create_terminal_request";
      requestId: string;
      cwd: string;
      workspaceId?: string;
      name?: string;
    }
  | {
      /** t19：子 agent 列表（agent.provider_subagents.list.request）。 */
      type: "agent.provider_subagents.list.request";
      requestId: string;
      parentAgentId: string;
    }
  | {
      /** t19：composer 斜杠命令目录（list_commands_request）。 */
      type: "list_commands_request";
      requestId: string;
      agentId: string;
    }
  // --- t20：会话中配置切换（composer 四 pill 的审批模式/模型/thinking） ---
  | {
      /** messages.ts SetAgentModeRequestMessageSchema（审批模式切换）。 */
      type: "set_agent_mode_request";
      agentId: string;
      modeId: string;
      requestId: string;
    }
  | {
      /** messages.ts SetAgentModelRequestMessageSchema（modelId null = 回默认）。 */
      type: "set_agent_model_request";
      agentId: string;
      modelId: string | null;
      requestId: string;
    }
  | {
      /** messages.ts SetAgentThinkingRequestMessageSchema（thinking 档位；null = 清除）。 */
      type: "set_agent_thinking_request";
      agentId: string;
      thinkingOptionId: string | null;
      requestId: string;
    }
  | {
      /** t20：验收后清理 PTY（messages.ts KillTerminalRequestSchema）。 */
      type: "kill_terminal_request";
      terminalId: string;
      requestId: string;
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

/**
 * 终端输入/尺寸（messages.ts TerminalInputSchema；fire-and-forget，
 * 不走 requestId 关联，观察失败经 terminal_stream_exit 推送告知）。
 */
export interface TerminalInputMessage {
  type: "terminal_input";
  terminalId: string;
  message:
    | { type: "input"; data: string }
    | { type: "resize"; rows: number; cols: number; intent?: "claim" | "update" };
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

/** messages.ts AgentSelectOptionSchema 容错解析（thinking 档位）。 */
function parseSelectOption(value: unknown): AgentSelectOption | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    label: str(value.label) ?? id,
    description: nullableStr(value.description) ?? undefined,
    isDefault: bool(value.isDefault) || undefined,
  };
}

/** AgentModeSchema 容错解析（快照 availableModes 用）。 */
function parseProviderMode(value: unknown): ProviderMode | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    label: str(value.label) ?? id,
    description: nullableStr(value.description) ?? undefined,
  };
}

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
  const availableModesRaw = Array.isArray(value.availableModes) ? value.availableModes : [];
  const availableModes = availableModesRaw
    .map(parseProviderMode)
    .filter((m): m is ProviderMode => m !== null);
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
    thinkingOptionId: nullableStr(value.thinkingOptionId),
    effectiveThinkingOptionId: nullableStr(value.effectiveThinkingOptionId),
    currentModeId: nullableStr(value.currentModeId),
    ...(availableModes.length > 0 ? { availableModes } : {}),
    labels: parseLabels(value.labels),
    capabilities: parseRewindCapabilities(value.capabilities),
    attentionReason:
      value.attentionReason === "finished" || value.attentionReason === "error"
        ? value.attentionReason
        : value.attentionReason === "permission"
          ? "permission"
          : null,
    usage: parseAgentUsage(value.lastUsage),
  };
}

/** AgentUsageSchema 容错解析：仅取数值字段，坏值丢弃。 */
function parseAgentUsage(value: unknown): AgentUsageInfo | null {
  if (!isRecord(value)) return null;
  const usage: AgentUsageInfo = {};
  let count = 0;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalCostUsd",
    "contextWindowMaxTokens",
    "contextWindowUsedTokens",
  ] as const) {
    const raw = value[key];
    if (typeof raw === "number" && Number.isFinite(raw)) {
      usage[key] = raw;
      count += 1;
    }
  }
  return count > 0 ? usage : null;
}

/** labels 容错解析：仅保留 string→string；坏值丢弃（协议 Record<string,string>）。 */
function parseLabels(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") {
      out[key] = raw;
      count += 1;
    }
  }
  return count > 0 ? out : undefined;
}

/**
 * t25：AgentCapabilityFlags 容错解析（子集：rewind 三开关）。
 * 只在至少一个开关有值时返回对象，避免每条快照都挂空 capabilities。
 */
function parseRewindCapabilities(value: unknown): AgentSnapshot["capabilities"] | undefined {
  if (!isRecord(value)) return undefined;
  const caps: NonNullable<AgentSnapshot["capabilities"]> = {};
  let count = 0;
  for (const key of [
    "supportsRewindConversation",
    "supportsRewindFiles",
    "supportsRewindBoth",
  ] as const) {
    const raw = value[key];
    if (typeof raw === "boolean") {
      caps[key] = raw;
      count += 1;
    }
  }
  return count > 0 ? caps : undefined;
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
      const thinkingRaw = Array.isArray(raw.thinkingOptions) ? raw.thinkingOptions : [];
      const thinkingOptions = thinkingRaw
        .map(parseSelectOption)
        .filter((o): o is AgentSelectOption => o !== null);
      return {
        id,
        label: str(raw.label) ?? id,
        description: nullableStr(raw.description) ?? undefined,
        isDefault: bool(raw.isDefault) || undefined,
        ...(thinkingOptions.length > 0 ? { thinkingOptions } : {}),
        ...(str(raw.defaultThinkingOptionId)
          ? { defaultThinkingOptionId: str(raw.defaultThinkingOptionId) ?? "" }
          : {}),
      };
    })
    .filter((m): m is ProviderModelDefinition => m !== null);
}

/** t31-d：模型目录 + daemon 错误透出（错误 payload 的 models 缺席 ≠ 空目录）。 */
export function parseProviderModelsResult(payload: unknown): ProviderModelsResult | null {
  if (!isRecord(payload)) return null;
  return {
    models: parseProviderModelsResponse(payload) ?? [],
    error: nullableStr(payload.error),
  };
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

// ---------------------------------------------------------------------------
// t18：定时任务 / attention / 导入 / 脚本 / 项目注册 解析守卫
// ---------------------------------------------------------------------------

function parseCadence(value: unknown): ScheduleCadence | null {
  if (!isRecord(value)) return null;
  if (value.type === "every" && typeof value.everyMs === "number") {
    return { type: "every", everyMs: value.everyMs };
  }
  if (value.type === "cron" && typeof value.expression === "string" && value.expression) {
    const timezone = nullableStr(value.timezone);
    return { type: "cron", expression: value.expression, ...(timezone ? { timezone } : {}) };
  }
  return null;
}

function parseScheduleTarget(value: unknown): ScheduleCreateTarget | null {
  if (!isRecord(value)) return null;
  if ((value.type === "agent" || value.type === "self") && typeof value.agentId === "string") {
    return { type: value.type, agentId: value.agentId };
  }
  if (value.type === "new-agent" && isRecord(value.config)) {
    const provider = str(value.config.provider);
    const cwd = str(value.config.cwd);
    if (!provider || !cwd) return null;
    return {
      type: "new-agent",
      config: {
        provider,
        cwd,
        ...(str(value.config.modeId) ? { modeId: str(value.config.modeId) ?? "" } : {}),
        ...(str(value.config.model) ? { model: str(value.config.model) ?? "" } : {}),
      },
    };
  }
  return null;
}

const SCHEDULE_STATUSES = new Set(["active", "paused", "completed"]);

export function parseScheduleSummary(value: unknown): ScheduleSummary | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const prompt = str(value.prompt);
  const cadence = parseCadence(value.cadence);
  const target = parseScheduleTarget(value.target);
  if (!id || !prompt || !cadence || !target) return null;
  const statusRaw = str(value.status);
  // StoredSchedule（run-once/inspect 响应）带 runs；ScheduleSummary 不带。都兼容。
  const runsRaw = Array.isArray(value.runs) ? value.runs : undefined;
  return {
    id,
    name: nullableStr(value.name),
    prompt,
    cadence,
    target,
    status:
      statusRaw && SCHEDULE_STATUSES.has(statusRaw) ? (statusRaw as ScheduleStatus) : "active",
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? "",
    nextRunAt: nullableStr(value.nextRunAt),
    lastRunAt: nullableStr(value.lastRunAt),
    pausedAt: nullableStr(value.pausedAt),
    expiresAt: nullableStr(value.expiresAt),
    maxRuns: typeof value.maxRuns === "number" ? value.maxRuns : null,
    ...(runsRaw
      ? {
          runs: runsRaw.map(parseScheduleRun).filter((r): r is ScheduleRun => r !== null),
        }
      : {}),
  };
}

export function parseScheduleRun(value: unknown): ScheduleRun | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  const status = str(value.status);
  return {
    id,
    scheduledFor: str(value.scheduledFor) ?? "",
    startedAt: str(value.startedAt) ?? "",
    endedAt: nullableStr(value.endedAt),
    status: status === "running" || status === "failed" ? status : "succeeded",
    agentId: nullableStr(value.agentId),
    output: nullableStr(value.output),
    error: nullableStr(value.error),
  };
}

/** schedule/list 与 schedule/logs 响应（payload.requestId 已由连接层关联）。 */
export function parseScheduleListResponse(
  payload: unknown,
): { schedules: ScheduleSummary[]; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.schedules) ? payload.schedules : [];
  return {
    schedules: raw.map(parseScheduleSummary).filter((s): s is ScheduleSummary => s !== null),
    error: nullableStr(payload.error),
  };
}

export function parseScheduleLogsResponse(
  payload: unknown,
): { runs: ScheduleRun[]; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.runs) ? payload.runs : [];
  return {
    runs: raw.map(parseScheduleRun).filter((r): r is ScheduleRun => r !== null),
    error: nullableStr(payload.error),
  };
}

/** schedule/create|pause|resume|run-once 响应：schedule 可空 + error。 */
export function parseScheduleMutationResponse(
  payload: unknown,
): { schedule: ScheduleSummary | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  return {
    schedule: parseScheduleSummary(payload.schedule),
    error: nullableStr(payload.error),
  };
}

export function parseScheduleDeleteResponse(
  payload: unknown,
): { scheduleId: string | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  return { scheduleId: nullableStr(payload.scheduleId), error: nullableStr(payload.error) };
}

/** agent_attention_required 推送 payload。 */
export function parseAttentionPush(payload: unknown): AttentionPush | null {
  if (!isRecord(payload)) return null;
  const agentId = str(payload.agentId);
  const reason = payload.reason;
  if (!agentId) return null;
  if (reason !== "finished" && reason !== "error" && reason !== "permission") return null;
  const notification = isRecord(payload.notification)
    ? {
        title: str(payload.notification.title) ?? "",
        body: str(payload.notification.body) ?? "",
      }
    : undefined;
  return {
    agentId,
    reason,
    timestamp: str(payload.timestamp) ?? "",
    shouldNotify: bool(payload.shouldNotify),
    ...(notification ? { notification } : {}),
  };
}

/** fetch_recent_provider_sessions_response payload。 */
export function parseRecentProviderSessionsResponse(payload: unknown): {
  entries: RecentProviderSession[];
  providerErrors: Array<{ provider: string; message: string }>;
} | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.entries) ? payload.entries : [];
  const entries = raw
    .map((value): RecentProviderSession | null => {
      if (!isRecord(value)) return null;
      const providerHandleId = str(value.providerHandleId);
      if (!providerHandleId) return null;
      return {
        providerId: str(value.providerId) ?? "",
        providerLabel: str(value.providerLabel) ?? str(value.providerId) ?? "",
        providerHandleId,
        cwd: str(value.cwd) ?? "",
        title: nullableStr(value.title),
        firstPromptPreview: nullableStr(value.firstPromptPreview),
        lastPromptPreview: nullableStr(value.lastPromptPreview),
        lastActivityAt: str(value.lastActivityAt) ?? "",
      };
    })
    .filter((e): e is RecentProviderSession => e !== null);
  const errorsRaw = Array.isArray(payload.providerErrors) ? payload.providerErrors : [];
  const providerErrors = errorsRaw
    .map((value): { provider: string; message: string } | null => {
      if (!isRecord(value)) return null;
      const provider = str(value.provider);
      if (!provider) return null;
      return { provider, message: str(value.message) ?? "" };
    })
    .filter((e): e is { provider: string; message: string } => e !== null);
  return { entries, providerErrors };
}

/** workspace.script.list/start/stop 响应（script 字段可选；list 走 scripts 数组）。 */
export function parseWorkspaceScriptResponse(
  payload: unknown,
): { scripts: WorkspaceScriptInfo[]; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.scripts)
    ? payload.scripts
    : payload.script && isRecord(payload.script)
      ? [payload.script]
      : [];
  const scripts = raw
    .map((value): WorkspaceScriptInfo | null => {
      if (!isRecord(value)) return null;
      const scriptName = str(value.scriptName);
      if (!scriptName) return null;
      const lifecycleRaw = str(value.lifecycle);
      const healthRaw = str(value.health);
      return {
        scriptName,
        type: str(value.type) === "script" ? "script" : "service",
        hostname: str(value.hostname) ?? "",
        port: typeof value.port === "number" ? value.port : null,
        proxyUrl: nullableStr(value.proxyUrl ?? value.localProxyUrl),
        publicProxyUrl: nullableStr(value.publicProxyUrl),
        lifecycle: lifecycleRaw === "stopped" ? "stopped" : "running",
        health: healthRaw === "healthy" || healthRaw === "unhealthy" ? healthRaw : null,
        exitCode: typeof value.exitCode === "number" ? value.exitCode : null,
        terminalId: nullableStr(value.terminalId),
      };
    })
    .filter((s): s is WorkspaceScriptInfo => s !== null);
  return { scripts, error: nullableStr(payload.error) };
}

/** open_project_response payload（注册目录 → 工作区）。 */
export function parseOpenProjectResponse(
  payload: unknown,
): { workspace: WorkspaceDescriptor | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  return {
    workspace: parseWorkspaceDescriptor(payload.workspace),
    error: nullableStr(payload.error),
  };
}

/** project.github.clone.response payload。 */
export function parseGithubCloneResponse(
  payload: unknown,
): { checkoutPath: string | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  return { checkoutPath: nullableStr(payload.checkoutPath), error: nullableStr(payload.error) };
}

/** update_agent_response payload。 */
export function parseUpdateAgentResponse(
  payload: unknown,
): { agentId: string; accepted: boolean; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const requestId = str(payload.requestId);
  if (!requestId) return null;
  return {
    agentId: str(payload.agentId) ?? "",
    accepted: bool(payload.accepted),
    error: nullableStr(payload.error),
  };
}

/**
 * t20：set_agent_mode/model/thinking 与 agent.config.apply 共用的
 * AgentActionResponsePayload（requestId/agentId/accepted/error/notice）。
 */
export function parseAgentActionResponse(
  payload: unknown,
): { agentId: string; accepted: boolean; error: string | null } | null {
  return parseUpdateAgentResponse(payload);
}

/** t20：kill_terminal_response payload（terminalId/success/requestId）。 */
export function parseKillTerminalResponse(
  payload: unknown,
): { terminalId: string; success: boolean } | null {
  if (!isRecord(payload)) return null;
  const terminalId = str(payload.terminalId);
  if (!terminalId) return null;
  return { terminalId, success: bool(payload.success) };
}

/**
 * t25：agent.rewind.response payload（requestId/agentId/ok/error）。
 * ok=false 时 error 带 daemon 侧失败原因（如 provider 未回执前不可回退）。
 */
export function parseAgentRewindResponse(
  payload: unknown,
): { agentId: string; ok: boolean; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const agentId = str(payload.agentId);
  if (!agentId) return null;
  return { agentId, ok: bool(payload.ok), error: nullableStr(payload.error) };
}

// ---------------------------------------------------------------------------
// t19：文件写回 / 条目操作 / 文件订阅 / diff / 终端 / subagents / 斜杠命令
// ---------------------------------------------------------------------------

/** FileVersionSchema 容错解析。 */
export function parseFileVersion(value: unknown): FileVersionInfo | null {
  if (!isRecord(value)) return null;
  const cwd = str(value.cwd) ?? "";
  const path = str(value.path) ?? "";
  if (value.status === "ready") {
    return {
      status: "ready",
      cwd,
      path,
      size: typeof value.size === "number" ? value.size : 0,
      modifiedAt: str(value.modifiedAt) ?? "",
      ...(str(value.revision) ? { revision: str(value.revision) ?? "" } : {}),
    };
  }
  if (value.status === "missing") return { status: "missing", cwd, path };
  if (value.status === "error") {
    return { status: "error", cwd, path, error: str(value.error) ?? "未知错误" };
  }
  return null;
}

/** fs.file.write.response payload → FileWriteResult。 */
export function parseFileWriteResponse(payload: unknown): FileWriteResult | null {
  if (!isRecord(payload)) return null;
  const result = isRecord(payload.result) ? payload.result : null;
  if (!result) return null;
  if (result.status === "written") {
    return {
      status: "written",
      modifiedAt: str(result.modifiedAt) ?? "",
      size: typeof result.size === "number" ? result.size : 0,
      ...(str(result.revision) ? { revision: str(result.revision) ?? "" } : {}),
    };
  }
  if (result.status === "conflict") {
    const version = parseFileVersion(result.version);
    if (version) return { status: "conflict", version };
  }
  if (result.status === "error") return { status: "error", error: str(result.error) ?? "写入失败" };
  return null;
}

/** fs.entry.create/rename/delete.response payload 公共解析。 */
export function parseFileEntryMutationResponse(payload: unknown): FileEntryMutationResult | null {
  if (!isRecord(payload)) return null;
  return {
    success: bool(payload.success),
    error: nullableStr(payload.error),
    path: nullableStr(payload.path),
    renamedPath: nullableStr(payload.renamedPath),
  };
}

/** fs.file.subscribe.response payload。 */
export function parseFileSubscribeResponse(payload: unknown): FileSubscribeResult | null {
  if (!isRecord(payload)) return null;
  const subscriptionId = str(payload.subscriptionId);
  const initial = parseFileVersion(payload.initial);
  if (!subscriptionId || !initial) return null;
  return { subscriptionId, initial };
}

/** fs.file.update 推送 payload。 */
export function parseFileUpdatePush(payload: unknown): FileUpdatePush | null {
  if (!isRecord(payload)) return null;
  const subscriptionId = str(payload.subscriptionId);
  const version = parseFileVersion(payload.version);
  if (!subscriptionId || !version) return null;
  return { subscriptionId, version };
}

/** checkout.commits.list.response payload。 */
export function parseCommitsListResponse(
  payload: unknown,
): { commits: CheckoutCommit[]; baseRef: string | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.commits) ? payload.commits : [];
  const commits = raw
    .map((value): CheckoutCommit | null => {
      if (!isRecord(value)) return null;
      const sha = str(value.sha);
      if (!sha) return null;
      const files = (Array.isArray(value.files) ? value.files : [])
        .map((file): CheckoutCommitFile | null => {
          if (!isRecord(file)) return null;
          const filePath = str(file.path);
          if (!filePath) return null;
          const statusRaw = str(file.status);
          return {
            path: filePath,
            additions: typeof file.additions === "number" ? file.additions : 0,
            deletions: typeof file.deletions === "number" ? file.deletions : 0,
            ...(statusRaw === "added" ||
            statusRaw === "modified" ||
            statusRaw === "deleted" ||
            statusRaw === "renamed"
              ? { status: statusRaw }
              : {}),
          };
        })
        .filter((f): f is CheckoutCommitFile => f !== null);
      return {
        sha,
        shortSha: str(value.shortSha) ?? sha.slice(0, 7),
        subject: str(value.subject) ?? "",
        authorName: str(value.authorName) ?? "",
        authorDate: str(value.authorDate) ?? "",
        isOnRemote: bool(value.isOnRemote),
        files,
      };
    })
    .filter((c): c is CheckoutCommit => c !== null);
  return {
    commits,
    baseRef: nullableStr(payload.baseRef),
    error: nullableStr(payload.error),
  };
}

/** checkout.commits.file_diff.response payload。 */
export function parseCommitFileDiffResponse(
  payload: unknown,
): { file: ParsedDiffFile | null; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const file = isRecord(payload.file) ? parseParsedDiffFile(payload.file) : null;
  return { file, error: nullableStr(payload.error) };
}

function parseParsedDiffFile(value: Record<string, unknown>): ParsedDiffFile | null {
  const path = str(value.path);
  if (!path) return null;
  const statusRaw = str(value.status);
  return {
    path,
    ...(str(value.oldPath) ? { oldPath: str(value.oldPath) ?? "" } : {}),
    isNew: bool(value.isNew),
    isDeleted: bool(value.isDeleted),
    additions: typeof value.additions === "number" ? value.additions : 0,
    deletions: typeof value.deletions === "number" ? value.deletions : 0,
    hunks: (Array.isArray(value.hunks) ? value.hunks : [])
      .map((hunk): DiffHunk | null => {
        if (!isRecord(hunk)) return null;
        const lines = (Array.isArray(hunk.lines) ? hunk.lines : [])
          .map((line): DiffLine | null => {
            if (!isRecord(line)) return null;
            const typeRaw = str(line.type);
            if (
              typeRaw !== "add" &&
              typeRaw !== "remove" &&
              typeRaw !== "context" &&
              typeRaw !== "header"
            ) {
              return null;
            }
            return { type: typeRaw, content: str(line.content) ?? "" };
          })
          .filter((l): l is DiffLine => l !== null);
        return {
          oldStart: typeof hunk.oldStart === "number" ? hunk.oldStart : 0,
          oldCount: typeof hunk.oldCount === "number" ? hunk.oldCount : 0,
          newStart: typeof hunk.newStart === "number" ? hunk.newStart : 0,
          newCount: typeof hunk.newCount === "number" ? hunk.newCount : 0,
          lines,
        };
      })
      .filter((h): h is DiffHunk => h !== null),
    ...(statusRaw === "ok" || statusRaw === "too_large" || statusRaw === "binary"
      ? { status: statusRaw }
      : {}),
  };
}

/** ProviderSubagentDescriptorPayloadSchema 容错解析。 */
export function parseSubagentSummary(value: unknown): ProviderSubagentSummary | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  const parentAgentId = str(value.parentAgentId);
  if (!id || !parentAgentId) return null;
  const statusRaw = str(value.status);
  return {
    id,
    parentAgentId,
    provider: str(value.provider) ?? "",
    title: nullableStr(value.title),
    description: nullableStr(value.description),
    status:
      statusRaw === "completed" || statusRaw === "failed" || statusRaw === "canceled"
        ? statusRaw
        : "running",
    createdAt: str(value.createdAt) ?? "",
    updatedAt: str(value.updatedAt) ?? "",
    subtitle: nullableStr(value.subtitle),
  };
}

/** agent.provider_subagents.list.response payload。 */
export function parseSubagentsListResponse(
  payload: unknown,
): { subagents: ProviderSubagentSummary[]; error: string | null } | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.subagents) ? payload.subagents : [];
  const subagents = raw
    .map(parseSubagentSummary)
    .filter((s): s is ProviderSubagentSummary => s !== null);
  return { subagents, error: nullableStr(payload.error) };
}

/** agent.provider_subagents.update 推送 payload（timeline 子事件返回 null，上层忽略）。 */
export function parseSubagentUpdate(payload: unknown): SubagentUpdate | null {
  if (!isRecord(payload)) return null;
  if (payload.kind === "upsert") {
    const subagent = parseSubagentSummary(payload.subagent);
    return subagent ? { kind: "upsert", subagent } : null;
  }
  if (payload.kind === "remove") {
    const parentAgentId = str(payload.parentAgentId);
    const subagentId = str(payload.subagentId);
    if (parentAgentId && subagentId) return { kind: "remove", parentAgentId, subagentId };
  }
  return null;
}

/** list_commands_response payload。 */
export function parseListCommandsResponse(payload: unknown): SlashCommand[] | null {
  if (!isRecord(payload)) return null;
  const raw = Array.isArray(payload.commands) ? payload.commands : [];
  return raw
    .map((value): SlashCommand | null => {
      if (!isRecord(value)) return null;
      const name = str(value.name);
      if (!name) return null;
      return {
        name,
        description: str(value.description) ?? "",
        argumentHint: str(value.argumentHint) ?? "",
        ...(str(value.kind) === "skill" ? { kind: "skill" } : {}),
      };
    })
    .filter((c): c is SlashCommand => c !== null);
}

/** TerminalInfoSchema 容错解析。 */
export function parseTerminalInfo(value: unknown): TerminalInfo | null {
  if (!isRecord(value)) return null;
  const id = str(value.id);
  if (!id) return null;
  return {
    id,
    name: str(value.name) ?? "",
    cwd: str(value.cwd) ?? "",
    ...(str(value.workspaceId) ? { workspaceId: str(value.workspaceId) ?? "" } : {}),
    ...(str(value.title) ? { title: str(value.title) ?? "" } : {}),
  };
}

/** subscribe_terminal_response payload。 */
export function parseSubscribeTerminalResponse(payload: unknown): SubscribeTerminalResult | null {
  if (!isRecord(payload)) return null;
  const terminalId = str(payload.terminalId);
  if (!terminalId) return null;
  const error = str(payload.error);
  if (error) return { terminalId, error };
  if (typeof payload.slot === "number") {
    return {
      terminalId,
      slot: payload.slot,
      error: null,
      ...(str(payload.subscriptionId) ? { subscriptionId: str(payload.subscriptionId) ?? "" } : {}),
    };
  }
  return null;
}
