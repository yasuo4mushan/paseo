/**
 * ZCode (Z.ai) built-in provider: Direct adapter over `zcode app-server`.
 *
 * Unlike the ACP providers, ZCode does not support ACP. Its app-server speaks
 * the private "ZCode Protocol" (NDJSON over stdio, see ./protocol.ts). This
 * adapter follows the Codex app-server Direct-adapter shape: one child
 * app-server process per Paseo session, discovered via PATH `zcode`, the macOS
 * desktop-app bundle, or a configured command override (see ./discovery.ts).
 *
 * Turn lifecycle: session/create (or session/resume; the app-server persists
 * sessions in its own store and evicts idle ones from a resident pool, so
 * resume runs before every send) -> session/subscribe -> session/send. A turn
 * ends only on the authoritative session/event `turn.completed` /
 * `turn.failed` notifications; `state.updated` snapshots are not terminal
 * (they race with the next turn on ZCode 0.16.x).
 *
 * Permissions fail closed: unmapped server requests are denied, and Z.ai MCP
 * auth-header requests are answered "unavailable" rather than surfacing
 * desktop credentials through Paseo.
 */
import type { Logger } from "pino";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import os from "node:os";

import {
  extractZcodeSessionId,
  formatZcodeTurnError,
  parseZcodeStreamEvent,
  ZCODE_COLD_START_TIMEOUT_MS,
  ZCODE_RUNTIME_PREFERENCES,
  ZCodeAppServerClient,
  type ZcodeStreamEvent,
  type ZcodeToolResultPayload,
  type ZcodeUsagePayload,
} from "./protocol.js";
import {
  describeZcodeLaunchSource,
  existingZcodeAppBundleCjs,
  isZcodeLaunchAvailable,
  resolveZcodeLaunch,
} from "./discovery.js";
import { buildZcodeToolCallItem, displayZcodeToolName } from "./tool-call-detail.js";
import {
  buildZcodeProviderRepository,
  zcodeServerEnvironmentOverlay,
  type ZcodeProviderRepository,
} from "./provider-repository.js";
import { appendOrReplaceGrowingAssistantMessage, runProviderTurn } from "../provider-runner.js";
import { createProviderEnv, type ProviderRuntimeSettings } from "../../provider-launch-config.js";
import { spawnProcess } from "../../../../utils/spawn.js";
import { renderPromptAttachmentAsText } from "../../prompt-attachments.js";
import { formatProviderDiagnostic, formatProviderDiagnosticError } from "../diagnostic-utils.js";
import type {
  AgentCapabilityFlags,
  AgentClient,
  AgentLaunchContext,
  AgentMode,
  AgentModelDefinition,
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentPromptInput,
  AgentResumeSessionOptions,
  AgentRunOptions,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSelectOption,
  AgentSession,
  AgentSessionConfig,
  AgentStreamEvent,
  AgentTimelineItem,
  AgentUsage,
  AgentCreateSessionOptions,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderRefreshContext,
} from "../../agent-sdk-types.js";

export const ZCODE_PROVIDER = "zcode" as const;

const ZCODE_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: true,
  supportsDynamicModes: false,
  supportsMcpServers: true,
  supportsReasoningStream: true,
  supportsToolInvocations: true,
};

/**
 * Static mode list mirrored from the ZCode app-server's own mode catalog
 * (build/edit/plan/yolo, verified in the 0.16.9 bundle). `session/setMode`
 * accepts exactly these ids.
 */
export const ZCODE_MODES: AgentMode[] = [
  {
    id: "build",
    label: "Ask before changes",
    description: "ZCode asks before each file change.",
  },
  {
    id: "edit",
    label: "Edit automatically",
    description: "ZCode edits selected or relevant workspace files automatically.",
  },
  {
    id: "plan",
    label: "Plan mode",
    description: "ZCode inspects the code and presents a plan before editing.",
  },
  {
    id: "yolo",
    label: "Full access",
    description: "ZCode edits files and runs commands with fewer confirmations.",
    isUnattended: true,
  },
];

export const ZCODE_DEFAULT_MODE_ID = "build";

const SESSION_SEND_TIMEOUT_MS = 120_000;
const INTERRUPT_SETTLE_TIMEOUT_MS = 3_000;
const CANCEL_ERROR_PATTERN = /cancel|abort|interrupt/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

/** ZCode model ids are `providerId/modelId` refs (providerId may contain ':'). */
export function parseZcodeModelRef(
  modelId: string | null | undefined,
): { providerId: string; modelId: string } | null {
  if (!modelId) return null;
  const separator = modelId.indexOf("/");
  if (separator <= 0 || separator === modelId.length - 1) return null;
  return {
    providerId: modelId.slice(0, separator),
    modelId: modelId.slice(separator + 1),
  };
}

function mapZcodeUsage(usage: ZcodeUsagePayload | undefined): AgentUsage | undefined {
  if (!usage) return undefined;
  // ZCode counts cached input inside inputTokens; Paseo tracks it separately.
  const cacheRead = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWrite = Math.max(0, usage.cacheWriteTokens ?? 0);
  return {
    inputTokens: Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite),
    cachedInputTokens: cacheRead + cacheWrite,
    outputTokens: usage.outputTokens ?? 0,
  };
}

function parsePartialJson(text: string): unknown {
  if (!text) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

interface PendingZcodePermission {
  request: AgentPermissionRequest;
  resolve: (result: Record<string, unknown>) => void;
}

export interface ZcodeAgentSessionDeps {
  /** Injectable spawn for tests. */
  spawn?: (launch: {
    command: string;
    args: string[];
    cwd: string;
  }) => ChildProcessWithoutNullStreams;
  runtimeSettings?: ProviderRuntimeSettings;
  environment?: Record<string, string>;
}

export class ZcodeAgentSession implements AgentSession {
  readonly provider = ZCODE_PROVIDER;
  readonly capabilities = ZCODE_CAPABILITIES;

  private readonly subscribers = new Set<(event: AgentStreamEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingZcodePermission>();
  private client: ZCodeAppServerClient | null = null;
  private zcodeSessionId: string | null = null;
  private activeTurnId: string | null = null;
  private nextTurnOrdinal = 0;
  private turnSettled: (() => void) | null = null;
  private turnSettlePromise: Promise<void> | null = null;
  private closed = false;
  private lastAppliedModelKey: string | null = null;
  private lastAppliedThoughtLevel: string | null = null;
  private lastAppliedModeId: string | null = null;
  private readonly resumeHandle: AgentPersistenceHandle | null;
  /** Model metadata from the session snapshot (reasoning defaults, windows). */
  private modelMetadata = new Map<string, ZcodeModelMetadata>();
  /** Default model from the Paseo-built provider repository snapshot. */
  private defaultModelRef: { providerId: string; modelId: string } | null = null;

  // Streaming state, reset at every turn start.
  private textBuffers = new Map<string, string>();
  private reasoningBuffers = new Map<string, string>();
  private toolNamesByCallId = new Map<string, string>();
  private toolInputsByCallId = new Map<string, unknown>();
  private partialToolInputByCallId = new Map<string, string>();
  private finalizedToolCalls = new Set<string>();
  private streamedTextThisTurn = false;

  constructor(
    private readonly config: AgentSessionConfig,
    resumeHandle: AgentPersistenceHandle | null,
    private readonly logger: Logger,
    private readonly deps: ZcodeAgentSessionDeps = {},
  ) {
    this.resumeHandle = resumeHandle;
  }

  get id(): string | null {
    return this.zcodeSessionId;
  }

  async connect(): Promise<void> {
    if (this.client) return;
    if (this.closed) throw new Error("zcode session is closed");
    const launch = await resolveZcodeLaunch(this.deps.runtimeSettings);
    const cwd = this.config.cwd || process.cwd();
    // Tests inject their own spawn; the provider repository only matters for
    // real app-server launches.
    let repository: ZcodeProviderRepository | null = null;
    if (!this.deps.spawn) {
      repository = buildZcodeProviderRepository();
      this.defaultModelRef = repository?.defaultModelRef ?? null;
    }
    const configuredEnv = this.deps.runtimeSettings?.env;
    const child = this.deps.spawn
      ? this.deps.spawn({ command: launch.command, args: launch.args, cwd })
      : spawnZcodeChild(launch.command, launch.args, cwd, {
          ...configuredEnv,
          ...zcodeServerEnvironmentOverlay(repository, configuredEnv),
          ...this.deps.environment,
        });
    this.client = new ZCodeAppServerClient({
      child,
      logger: this.logger,
      onServerRequest: (request) => this.handleServerRequest(request.method, request.params),
      onNotification: (notification) =>
        this.handleNotification(notification.method, notification.params),
      onUnexpectedExit: ({ error }) => {
        this.failActiveTurn(error.message);
      },
    });
  }

  // -----------------------------------------------------------------------
  // AgentSession surface
  // -----------------------------------------------------------------------

  async run(prompt: AgentPromptInput, options?: AgentRunOptions): Promise<AgentRunResult> {
    return runProviderTurn({
      prompt,
      runOptions: options,
      startTurn: (p, o) => this.startTurn(p, o),
      subscribe: (callback) => this.subscribe(callback),
      getSessionId: async () => this.zcodeSessionId ?? "",
      reduceFinalText: appendOrReplaceGrowingAssistantMessage,
    });
  }

  async startTurn(
    prompt: AgentPromptInput,
    _options?: AgentRunOptions,
  ): Promise<{ turnId: string }> {
    if (this.activeTurnId) {
      throw new Error("A zcode turn is already active");
    }
    await this.connect();
    const client = this.client;
    if (!client) throw new Error("zcode app-server client is not initialized");

    await this.ensureZcodeSession();
    await this.applyModelAndMode();

    this.resetTurnStreamState();
    const turnId = `zcode-turn-${this.nextTurnOrdinal++}`;
    this.activeTurnId = turnId;
    this.turnSettlePromise = new Promise<void>((resolve) => {
      this.turnSettled = resolve;
    });

    const content = await this.buildPromptText(prompt);
    try {
      // session/send resolves once the turn is accepted; the turn itself ends
      // on the session/event turn.completed / turn.failed notifications.
      await client.request(
        "session/send",
        { sessionId: this.zcodeSessionId, content },
        SESSION_SEND_TIMEOUT_MS,
      );
    } catch (error) {
      this.settleActiveTurn();
      throw error;
    }
    return { turnId };
  }

  subscribe(callback: (event: AgentStreamEvent) => void): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  async *streamHistory(): AsyncGenerator<AgentStreamEvent> {
    // Paseo persists its own timeline; ZCode history replay is not mapped.
  }

  async getRuntimeInfo(): Promise<AgentRuntimeInfo> {
    await this.connect();
    return {
      provider: ZCODE_PROVIDER,
      sessionId: this.zcodeSessionId,
      model: this.config.model ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
      modeId: this.config.modeId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return ZCODE_MODES;
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? ZCODE_DEFAULT_MODE_ID;
  }

  async setMode(modeId: string): Promise<void> {
    if (!ZCODE_MODES.some((mode) => mode.id === modeId)) {
      throw new Error(`Unknown zcode mode: ${modeId}`);
    }
    this.config.modeId = modeId;
    if (this.client && this.zcodeSessionId && !this.activeTurnId) {
      try {
        await this.client.request("session/setMode", {
          sessionId: this.zcodeSessionId,
          mode: modeId,
        });
        this.lastAppliedModeId = modeId;
      } catch (error) {
        this.logger.warn(
          { err: error, modeId },
          "zcode session/setMode failed; will retry next turn",
        );
      }
    }
  }

  getPendingPermissions(): AgentPermissionRequest[] {
    return [...this.pendingPermissions.values()].map((pending) => pending.request);
  }

  async respondToPermission(requestId: string, response: AgentPermissionResponse): Promise<void> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending zcode permission request with id '${requestId}'`);
    }
    this.pendingPermissions.delete(requestId);
    this.emitEvent({
      type: "permission_resolved",
      provider: ZCODE_PROVIDER,
      requestId,
      resolution: response,
      turnId: this.activeTurnId ?? undefined,
    });
    if (pending.request.kind === "question") {
      this.resolveUserInput(pending, response);
      return;
    }
    if (response.behavior === "allow") {
      pending.resolve({ decision: "allow" });
      return;
    }
    this.emitDeniedToolCall(pending.request, response);
    pending.resolve({
      decision: "deny",
      reason: response.message ?? "Denied in Paseo",
    });
  }

  describePersistence(): AgentPersistenceHandle | null {
    if (!this.zcodeSessionId) return null;
    return {
      provider: ZCODE_PROVIDER,
      sessionId: this.zcodeSessionId,
      nativeHandle: this.zcodeSessionId,
      metadata: {
        provider: ZCODE_PROVIDER,
        cwd: this.config.cwd,
        title: this.config.title ?? null,
        modeId: this.config.modeId,
        model: this.config.model ?? null,
        thinkingOptionId: this.config.thinkingOptionId ?? null,
        systemPrompt: this.config.systemPrompt,
        mcpServers: this.config.mcpServers,
      },
    };
  }

  async interrupt(): Promise<void> {
    const client = this.client;
    const sessionId = this.zcodeSessionId;
    const settle = this.turnSettlePromise;
    if (!client || !sessionId || !this.activeTurnId) {
      return;
    }
    try {
      await client.request("session/stop", { sessionId }, 5_000);
    } catch (error) {
      this.logger.warn({ err: error }, "zcode session/stop failed");
    }
    if (!settle) return;
    const timedOut = await Promise.race([
      settle.then(() => false),
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(true), INTERRUPT_SETTLE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
    if (timedOut) {
      // The server did not publish a terminal event in time; cancel locally so
      // callers cannot observe the turn becoming active again.
      this.emitEvent({
        type: "turn_canceled",
        provider: ZCODE_PROVIDER,
        reason: "Interrupted in Paseo",
        turnId: this.activeTurnId ?? undefined,
      });
      this.settleActiveTurn();
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    const pendingPermissions = [...this.pendingPermissions];
    this.pendingPermissions.clear();
    for (const [requestId, pending] of pendingPermissions) {
      pending.resolve(
        pending.request.kind === "question"
          ? { requestId, cancelled: true }
          : { decision: "deny", reason: "Session closed" },
      );
    }
    // Settle the active turn before dropping subscribers so in-flight run()
    // callers observe the failure instead of hanging forever.
    this.failActiveTurn("zcode session closed");
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    this.zcodeSessionId = null;
    if (client) {
      // Let the resolved permission answers flush to stdin before disposal
      // marks the transport closed (answers are written from a microtask).
      await new Promise((resolve) => setImmediate(resolve));
      await client.dispose();
    }
  }

  async setModel(modelId: string | null): Promise<void> {
    this.config.model = modelId ?? undefined;
    this.lastAppliedModelKey = null; // re-apply on next turn
  }

  async setThinkingOption(thinkingOptionId: string | null): Promise<void> {
    this.config.thinkingOptionId = thinkingOptionId ?? undefined;
    this.lastAppliedThoughtLevel = null; // re-apply on next turn
  }

  // -----------------------------------------------------------------------
  // Server -> client requests
  // -----------------------------------------------------------------------

  private handleServerRequest(method: string, params: unknown): unknown {
    switch (method) {
      case "session/requestRuntimePreferences":
        return ZCODE_RUNTIME_PREFERENCES;
      case "interaction/requestPermission":
        return this.handlePermissionRequest(params);
      case "interaction/requestUserInput":
        return this.handleUserInputRequest(params);
      case "interaction/requestOfficialMcpAuthHeaders":
        // Fail closed: Paseo never proxies Z.ai desktop MCP credentials.
        return { ok: false, reason: "unavailable" };
      case "interaction/requestProviderRuntimeHeaders":
        return { headersApplied: false };
      default:
        // Unknown server requests are denied rather than silently accepted.
        this.logger.debug({ method }, "Denying unrecognized zcode server request");
        throw new Error(`Paseo does not support the zcode request '${method}'`);
    }
  }

  private handlePermissionRequest(params: unknown): unknown {
    if (!isRecord(params)) {
      return { decision: "deny", reason: "Unrecognized zcode permission request" };
    }
    const requestId =
      typeof params.requestId === "string" ? params.requestId : `zcode-perm-${Date.now()}`;
    const toolName = typeof params.toolName === "string" ? params.toolName : "tool";
    const reason =
      typeof params.reason === "string" && params.reason
        ? params.reason
        : `ZCode wants to run ${displayZcodeToolName(toolName)}`;
    const toolCallId = typeof params.toolCallId === "string" ? params.toolCallId : undefined;
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: ZCODE_PROVIDER,
      name: toolName,
      kind: "tool",
      title: reason,
      description: reason,
      input: isRecord(params.input) ? params.input : undefined,
      detail: buildZcodeToolCallItem({
        callId: toolCallId ?? requestId,
        toolName,
        input: params.input,
        status: "running",
      }).detail,
      actions: [
        { id: "allow", label: "Allow", behavior: "allow", variant: "primary" },
        { id: "deny", label: "Deny", behavior: "deny" },
      ],
      metadata: {
        toolCallId,
        riskLevel: typeof params.riskLevel === "string" ? params.riskLevel : undefined,
      },
    };
    return new Promise<Record<string, unknown>>((resolve) => {
      this.pendingPermissions.set(requestId, { request, resolve });
      this.emitEvent({
        type: "permission_requested",
        provider: ZCODE_PROVIDER,
        request,
        turnId: this.activeTurnId ?? undefined,
      });
    });
  }

  private handleUserInputRequest(params: unknown): unknown {
    const cancel = (requestId: string, note?: string): Record<string, unknown> => {
      if (note) {
        this.logger.debug({ note }, "Cancelling un-mappable zcode user input request");
      }
      return { requestId, cancelled: true };
    };
    if (!isRecord(params) || typeof params.requestId !== "string") {
      return cancel(`zcode-question-${Date.now()}`, "missing requestId");
    }
    const requestId = params.requestId;
    const questions = Array.isArray(params.questions) ? params.questions : [];
    const index = typeof params.currentQuestionIndex === "number" ? params.currentQuestionIndex : 0;
    let question: unknown = questions[index];
    if (!isRecord(question)) {
      question = questions[0];
    }
    if (
      !isRecord(question) ||
      typeof question.question !== "string" ||
      !Array.isArray(question.options)
    ) {
      return cancel(requestId, "unrecognized question shape");
    }
    const options = question.options.filter(
      (option): option is { value: string; label?: string; description?: string } =>
        isRecord(option) && typeof option.value === "string",
    );
    if (options.length === 0) {
      return cancel(requestId, "question without options");
    }
    const multiSelect = question.multiSelect === true;
    const header = typeof question.header === "string" ? question.header : "ZCode question";
    const actions: AgentPermissionRequest["actions"] = [];
    for (const [optionIndex, option] of options.entries()) {
      const action: NonNullable<AgentPermissionRequest["actions"]>[number] = {
        id: option.value,
        label: option.label ?? option.value,
        behavior: "allow",
      };
      if (option.description) {
        action.label = `${action.label} — ${option.description}`;
      }
      if (optionIndex === 0 && !multiSelect) {
        action.variant = "primary";
      }
      actions.push(action);
    }
    const request: AgentPermissionRequest = {
      id: requestId,
      provider: ZCODE_PROVIDER,
      name: "askUserQuestion",
      kind: "question",
      title: question.question,
      description: multiSelect ? `${header} (select one or more)` : header,
      input: { question: question.question, options, multiSelect },
      actions,
    };
    this.emitTimeline({
      type: "tool_call",
      callId: requestId,
      name: "askUserQuestion",
      status: "running",
      error: null,
      detail: {
        type: "plain_text",
        label: "askUserQuestion",
        text: question.question,
      },
    });
    return new Promise<Record<string, unknown>>((resolve) => {
      this.pendingPermissions.set(requestId, { request, resolve });
      this.emitEvent({
        type: "permission_requested",
        provider: ZCODE_PROVIDER,
        request,
        turnId: this.activeTurnId ?? undefined,
      });
    });
  }

  private resolveUserInput(
    pending: PendingZcodePermission,
    response: AgentPermissionResponse,
  ): void {
    const input = pending.request.input as { multiSelect?: boolean } | undefined;
    const multiSelect = input?.multiSelect === true;
    const textOf = (status: "completed" | "canceled", answer: string): AgentTimelineItem => ({
      type: "tool_call",
      callId: pending.request.id,
      name: "askUserQuestion",
      status,
      error: null,
      detail: {
        type: "plain_text",
        label: "askUserQuestion",
        text: answer,
      },
    });
    if (response.behavior === "allow") {
      const values = response.selectedActionId ? [response.selectedActionId] : [];
      pending.resolve({
        requestId: pending.request.id,
        value: multiSelect ? values : values[0],
      });
      this.emitTimeline(
        textOf("completed", `${pending.request.title}\nAnswer: ${values.join(", ") || "(none)"}`),
      );
      return;
    }
    pending.resolve({ requestId: pending.request.id, cancelled: true });
    this.emitTimeline(textOf("canceled", pending.request.title ?? ""));
  }

  private emitDeniedToolCall(
    request: AgentPermissionRequest,
    response: Extract<AgentPermissionResponse, { behavior: "deny" }>,
  ): void {
    if (request.kind !== "tool") return;
    this.emitTimeline({
      type: "tool_call",
      callId:
        typeof request.metadata?.toolCallId === "string"
          ? (request.metadata.toolCallId as string)
          : request.id,
      name: request.name,
      status: "failed",
      error: { message: response.message ?? "Permission denied" },
      detail: request.detail ?? { type: "unknown", input: request.input ?? null, output: null },
    });
  }

  // -----------------------------------------------------------------------
  // Notifications
  // -----------------------------------------------------------------------

  private handleNotification(method: string, params: unknown): void {
    if (method !== "session/event") {
      this.logger.trace({ method }, "zcode notification");
      return;
    }
    const event = parseZcodeStreamEvent(params);
    if (!event?.type) return;
    switch (event.type) {
      case "model.streaming":
        this.handleModelStreaming(event);
        return;
      case "tool.updated":
        this.handleToolUpdated(event);
        return;
      case "turn.completed":
        this.handleTurnCompleted(event);
        return;
      case "turn.failed":
        this.handleTurnFailed(event);
        return;
      case "session.updated":
        this.handleSessionUpdated(event);
        return;
      default:
        this.logger.trace({ type: event.type }, "zcode session event ignored");
    }
  }

  private handleModelStreaming(event: ZcodeStreamEvent): void {
    const payload = event.payload ?? {};
    const kind = payload.kind;
    const assistantMessageId = payload.assistantMessageId ?? this.activeTurnId ?? "stream";
    if (kind === "text_start" || kind === "text_delta") {
      this.handleTextStreaming(assistantMessageId, payload.delta);
      return;
    }
    if (kind === "reasoning_start" || kind === "reasoning_delta") {
      this.handleReasoningStreaming(assistantMessageId, payload.delta);
      return;
    }
    this.handleToolInputStreaming(kind, payload);
  }

  private handleTextStreaming(assistantMessageId: string, delta: unknown): void {
    if (typeof delta !== "string" || !delta) return;
    this.streamedTextThisTurn = true;
    const buffer = (this.textBuffers.get(assistantMessageId) ?? "") + delta;
    this.textBuffers.set(assistantMessageId, buffer);
    this.emitTimeline({
      type: "assistant_message",
      text: buffer,
      messageId: assistantMessageId,
    });
  }

  private handleReasoningStreaming(assistantMessageId: string, delta: unknown): void {
    if (typeof delta !== "string" || !delta) return;
    const key = `reasoning:${assistantMessageId}`;
    const buffer = (this.reasoningBuffers.get(key) ?? "") + delta;
    this.reasoningBuffers.set(key, buffer);
    this.emitTimeline({ type: "reasoning", text: buffer });
  }

  private handleToolInputStreaming(
    kind: string | undefined,
    payload: NonNullable<ZcodeStreamEvent["payload"]>,
  ): void {
    if (kind === "tool_input_start") {
      const callId = payload.toolCallId;
      if (callId && payload.toolName) {
        this.toolNamesByCallId.set(callId, payload.toolName);
      }
      return;
    }
    if (kind === "tool_input_delta") {
      const callId = payload.toolCallId;
      if (callId && typeof payload.delta === "string") {
        this.partialToolInputByCallId.set(
          callId,
          (this.partialToolInputByCallId.get(callId) ?? "") + payload.delta,
        );
      }
      return;
    }
    if (kind !== "tool_input_end" && kind !== "tool_call") {
      return;
    }
    const callId = payload.toolCallId;
    if (!callId || this.finalizedToolCalls.has(callId)) return;
    this.finalizedToolCalls.add(callId);
    const toolName = payload.toolName ?? this.toolNamesByCallId.get(callId) ?? "tool";
    this.toolNamesByCallId.set(callId, toolName);
    const input =
      payload.input !== undefined
        ? payload.input
        : parsePartialJson(this.partialToolInputByCallId.get(callId) ?? "");
    this.toolInputsByCallId.set(callId, input);
    this.emitTimeline(buildZcodeToolCallItem({ callId, toolName, input, status: "running" }));
  }

  private handleToolUpdated(event: ZcodeStreamEvent): void {
    const payload = event.payload ?? {};
    const callId = payload.toolCallId;
    if (!callId || payload.kind !== "result" || payload.result === undefined) return;
    const toolName = this.toolNamesByCallId.get(callId) ?? "tool";
    const input = this.toolInputsByCallId.get(callId);
    const result = payload.result as ZcodeToolResultPayload;
    this.emitTimeline(
      buildZcodeToolCallItem({
        callId,
        toolName,
        input,
        status: result.success === false ? "failed" : "completed",
        result,
      }),
    );
  }

  private handleTurnCompleted(event: ZcodeStreamEvent): void {
    const payload = event.payload ?? {};
    // Fall back to the definitive final response when no live text deltas
    // arrived (quiet model or a missed subscription), mirroring the community
    // bridge behavior.
    if (!this.streamedTextThisTurn && typeof payload.response === "string" && payload.response) {
      this.emitTimeline({
        type: "assistant_message",
        text: payload.response,
        messageId: "final-response",
      });
    }
    this.emitEvent({
      type: "turn_completed",
      provider: ZCODE_PROVIDER,
      usage: mapZcodeUsage(payload.usage),
      turnId: this.activeTurnId ?? undefined,
    });
    this.settleActiveTurn();
  }

  private handleTurnFailed(event: ZcodeStreamEvent): void {
    const payload = event.payload ?? {};
    const message = formatZcodeTurnError(payload.error) ?? "zcode turn ended with failure";
    if (CANCEL_ERROR_PATTERN.test(message)) {
      this.emitEvent({
        type: "turn_canceled",
        provider: ZCODE_PROVIDER,
        reason: message,
        turnId: this.activeTurnId ?? undefined,
      });
    } else {
      this.emitEvent({
        type: "turn_failed",
        provider: ZCODE_PROVIDER,
        error: `zcode turn failed: ${message}`,
        turnId: this.activeTurnId ?? undefined,
      });
    }
    this.settleActiveTurn();
  }

  private handleSessionUpdated(event: ZcodeStreamEvent): void {
    const payload = event.payload ?? {};
    if (payload.trigger === "auto" && payload.status === "completed") {
      this.emitTimeline({
        type: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens:
          typeof payload.preCompactTokenCount === "number"
            ? payload.preCompactTokenCount
            : undefined,
      });
    }
  }

  private failActiveTurn(message: string): void {
    if (!this.activeTurnId) return;
    this.emitEvent({
      type: "turn_failed",
      provider: ZCODE_PROVIDER,
      error: message,
      turnId: this.activeTurnId,
    });
    this.settleActiveTurn();
  }

  private settleActiveTurn(): void {
    this.activeTurnId = null;
    this.turnSettlePromise = null;
    const settle = this.turnSettled;
    this.turnSettled = null;
    settle?.();
  }

  private resetTurnStreamState(): void {
    this.textBuffers = new Map();
    this.reasoningBuffers = new Map();
    this.toolNamesByCallId = new Map();
    this.toolInputsByCallId = new Map();
    this.partialToolInputByCallId = new Map();
    this.finalizedToolCalls = new Set();
    this.streamedTextThisTurn = false;
  }

  // -----------------------------------------------------------------------
  // Session lifecycle helpers
  // -----------------------------------------------------------------------

  private async ensureZcodeSession(): Promise<void> {
    const client = this.client;
    if (!client) throw new Error("zcode app-server client is not initialized");
    let created = false;
    if (!this.zcodeSessionId && this.resumeHandle) {
      const nativeHandle = this.resumeHandle.nativeHandle ?? this.resumeHandle.sessionId;
      if (nativeHandle) {
        try {
          await client.request("session/resume", { sessionId: nativeHandle });
          this.zcodeSessionId = nativeHandle;
        } catch (error) {
          this.logger.warn(
            { err: error, nativeHandle },
            "zcode session/resume failed; falling back to a new zcode session",
          );
          this.emitTimeline({
            type: "notification",
            level: "warning",
            message:
              "The original ZCode session could not be resumed; a new ZCode session was started.",
          });
        }
      }
    }
    if (this.zcodeSessionId) {
      // The app-server evicts idle sessions from its resident pool; resume is a
      // no-op while resident and rehydrates from the persisted store otherwise.
      try {
        await client.request("session/resume", { sessionId: this.zcodeSessionId });
      } catch (error) {
        this.logger.warn(
          { err: error },
          "zcode session/resume refresh failed; continuing with the resident session",
        );
      }
    } else {
      const cwd = this.config.cwd || process.cwd();
      const createResult = await client.request(
        "session/create",
        {
          workspace: { workspacePath: cwd, workspaceKey: cwd },
        },
        ZCODE_COLD_START_TIMEOUT_MS,
      );
      const sessionId = extractZcodeSessionId(createResult);
      if (!sessionId) {
        throw new Error("zcode session/create did not return a sessionId");
      }
      this.zcodeSessionId = sessionId;
      this.lastAppliedModelKey = null;
      this.lastAppliedThoughtLevel = null;
      this.lastAppliedModeId = null;
      created = true;
    }
    if (created || !this.subscribedSessionIds.has(this.zcodeSessionId)) {
      await client.request("session/subscribe", {
        sessionId: this.zcodeSessionId,
        deliveryKind: "desktop-continuous",
      });
      this.subscribedSessionIds.add(this.zcodeSessionId);
    }
    if (created || this.modelMetadata.size === 0) {
      await this.refreshModelMetadata();
    }
  }

  private readonly subscribedSessionIds = new Set<string>();

  /**
   * Caches model metadata from a session/read snapshot. The snapshot is the
   * authoritative source for reasoning levels (reasoning models reject
   * session/setModel without an options.reasoningLevel) and context windows.
   */
  private async refreshModelMetadata(): Promise<void> {
    const client = this.client;
    const sessionId = this.zcodeSessionId;
    if (!client || !sessionId) return;
    try {
      const snapshot = await client.request("session/read", {
        sessionId,
        messageLimit: 1,
      });
      const metadata = readZcodeModelMetadata(snapshot);
      if (metadata.size > 0) {
        this.modelMetadata = metadata;
      }
    } catch (error) {
      this.logger.debug({ err: error }, "zcode session/read metadata refresh failed");
    }
  }

  private async applyModelAndMode(): Promise<void> {
    const client = this.client;
    const sessionId = this.zcodeSessionId;
    if (!client || !sessionId) return;
    const ref = this.resolveModelRef();
    if (ref) {
      await this.applyModelSelection(client, sessionId, ref);
    }
    const modeId = this.config.modeId ?? ZCODE_DEFAULT_MODE_ID;
    if (modeId !== this.lastAppliedModeId) {
      try {
        await client.request("session/setMode", { sessionId, mode: modeId });
        this.lastAppliedModeId = modeId;
      } catch (error) {
        this.logger.warn({ err: error, modeId }, "zcode session/setMode failed");
      }
    }
  }

  private resolveModelRef(): { providerId: string; modelId: string } | null {
    const ref = parseZcodeModelRef(this.config.model) ?? this.defaultModelRef ?? null;
    if (!ref || this.modelMetadata.size === 0) {
      return ref;
    }
    // The configured/default ref may not be exposed by the server (plan
    // filtering, disabled variants); fall back to the first available model
    // so the turn can proceed.
    const key = `${ref.providerId}/${ref.modelId}`;
    if (this.modelMetadata.has(key)) {
      return ref;
    }
    const firstAvailable = this.modelMetadata.keys().next().value;
    if (typeof firstAvailable !== "string") {
      return ref;
    }
    this.logger.warn(
      { requested: key, fallback: firstAvailable },
      "zcode model not available on this install; falling back",
    );
    return parseZcodeModelRef(firstAvailable) ?? ref;
  }

  private async applyModelSelection(
    client: ZCodeAppServerClient,
    sessionId: string,
    ref: { providerId: string; modelId: string },
  ): Promise<void> {
    const metadata = this.modelMetadata.get(`${ref.providerId}/${ref.modelId}`);
    // Reasoning models refuse selection without a level; resolve the
    // configured level, else the model's default, else its first level.
    const levels = metadata?.reasoningLevels ?? [];
    const thoughtLevel =
      this.config.thinkingOptionId ?? metadata?.defaultReasoningLevel ?? levels[0] ?? null;
    const key = `${ref.providerId}/${ref.modelId}`;
    if (key === this.lastAppliedModelKey) {
      if (thoughtLevel && thoughtLevel !== this.lastAppliedThoughtLevel) {
        await this.applyThoughtLevel(client, sessionId, thoughtLevel);
      }
      return;
    }
    try {
      await client.request("session/setModel", {
        sessionId,
        model: {
          providerId: ref.providerId,
          modelId: ref.modelId,
          ...(thoughtLevel ? { options: { reasoningLevel: thoughtLevel } } : {}),
        },
      });
      this.lastAppliedModelKey = key;
      this.lastAppliedThoughtLevel = thoughtLevel;
    } catch (error) {
      if (!thoughtLevel) throw error;
      // The selected level may be unsupported; retry bare (non-reasoning
      // models) before surfacing the failure.
      await client.request("session/setModel", {
        sessionId,
        model: { providerId: ref.providerId, modelId: ref.modelId },
      });
      this.lastAppliedModelKey = key;
      this.lastAppliedThoughtLevel = null;
    }
  }

  private async applyThoughtLevel(
    client: ZCodeAppServerClient,
    sessionId: string,
    thoughtLevel: string,
  ): Promise<void> {
    try {
      await client.request("session/setThoughtLevel", { sessionId, thoughtLevel });
    } catch (error) {
      this.logger.warn(
        { err: error, thoughtLevel },
        "zcode session/setThoughtLevel failed; keeping the model default",
      );
    }
    this.lastAppliedThoughtLevel = thoughtLevel;
  }

  private async buildPromptText(prompt: AgentPromptInput): Promise<string> {
    if (typeof prompt === "string") return prompt;
    const parts: string[] = [];
    for (const block of prompt) {
      if (block.type === "text") {
        parts.push(block.text);
      } else if (block.type === "image") {
        parts.push(`[image attached: ${block.mimeType}]`);
      } else {
        parts.push(renderPromptAttachmentAsText(block));
      }
    }
    return parts.filter(Boolean).join("\n\n");
  }

  private emitTimeline(item: AgentTimelineItem): void {
    this.emitEvent({
      type: "timeline",
      provider: ZCODE_PROVIDER,
      item,
      turnId: this.activeTurnId ?? undefined,
    });
  }

  private emitEvent(event: AgentStreamEvent): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(event);
      } catch (error) {
        this.logger.warn({ err: error }, "zcode stream subscriber threw");
      }
    }
  }
}

export function spawnZcodeChild(
  command: string,
  args: string[],
  cwd: string,
  envOverlay?: Record<string, string>,
): ChildProcessWithoutNullStreams {
  const child = spawnProcess(command, args, {
    cwd,
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: createProviderEnv({ baseEnv: process.env, overlays: [envOverlay] }),
  });
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error("zcode app-server was spawned without stdio pipes");
  }
  return child as ChildProcessWithoutNullStreams;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface ZcodeAgentClientDeps extends ZcodeAgentSessionDeps {}

export class ZcodeAgentClient implements AgentClient {
  readonly provider = ZCODE_PROVIDER;
  readonly capabilities = ZCODE_CAPABILITIES;

  constructor(
    private readonly logger: Logger,
    private readonly runtimeSettings?: ProviderRuntimeSettings,
    private readonly deps: ZcodeAgentClientDeps = {},
  ) {}

  async createSession(
    config: AgentSessionConfig,
    _launchContext?: AgentLaunchContext,
    _options?: AgentCreateSessionOptions,
  ): Promise<AgentSession> {
    const sessionConfig: AgentSessionConfig = { ...config, provider: ZCODE_PROVIDER };
    const session = new ZcodeAgentSession(sessionConfig, null, this.sessionLogger(), {
      ...this.deps,
      runtimeSettings: this.runtimeSettings,
    });
    await session.connect();
    return session;
  }

  async resumeSession(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>,
    _launchContext?: AgentLaunchContext,
    _options?: AgentResumeSessionOptions,
  ): Promise<AgentSession> {
    const storedConfig = (handle.metadata ?? {}) as Partial<AgentSessionConfig>;
    const merged: AgentSessionConfig = {
      ...storedConfig,
      ...overrides,
      provider: ZCODE_PROVIDER,
      cwd: overrides?.cwd ?? storedConfig.cwd ?? process.cwd(),
    };
    const session = new ZcodeAgentSession(merged, handle, this.sessionLogger(), {
      ...this.deps,
      runtimeSettings: this.runtimeSettings,
    });
    await session.connect();
    return session;
  }

  private sessionLogger(): Logger {
    return this.logger.child({ provider: ZCODE_PROVIDER });
  }

  async getCatalogCacheKey(): Promise<string> {
    // Model discovery is global to the ZCode install, independent of cwd.
    return "host";
  }

  async fetchCatalog(
    options: FetchCatalogOptions,
    context?: ProviderRefreshContext,
  ): Promise<ProviderCatalog> {
    const cwd = options.scope === "workspace" ? options.cwd : os.tmpdir();
    const launch = await resolveZcodeLaunch(this.runtimeSettings);
    const repository = this.deps.spawn ? null : buildZcodeProviderRepository();
    const configuredEnv = this.runtimeSettings?.env;
    const child = this.deps.spawn
      ? this.deps.spawn({ command: launch.command, args: launch.args, cwd })
      : spawnZcodeChild(launch.command, launch.args, cwd, {
          ...configuredEnv,
          ...zcodeServerEnvironmentOverlay(repository, configuredEnv),
          ...this.deps.environment,
        });
    const client = new ZCodeAppServerClient({
      child,
      logger: this.logger,
      onServerRequest: (request) => defaultCatalogServerRequestHandler(request.method),
    });
    const dispose = (): Promise<void> => client.dispose().catch(() => undefined);
    context?.signal.addEventListener("abort", dispose, { once: true });
    try {
      const created = await client.request(
        "session/create",
        {
          workspace: { workspacePath: cwd, workspaceKey: cwd },
        },
        ZCODE_COLD_START_TIMEOUT_MS,
      );
      const sessionId = extractZcodeSessionId(created);
      if (!sessionId) throw new Error("zcode session/create did not return a sessionId");
      const snapshot = await client.request("session/read", {
        sessionId,
        messageLimit: 1,
      });
      const models = readZcodeCatalogModels(snapshot);
      const defaultModelRef = repository?.defaultModelRef ?? null;
      if (defaultModelRef) {
        const defaultKey = `${defaultModelRef.providerId}/${defaultModelRef.modelId}`;
        let matchedDefault = false;
        for (const model of models) {
          model.isDefault = model.id === defaultKey;
          matchedDefault ||= model.isDefault;
        }
        // The configured default may not be exposed by the server (plan
        // filtering, disabled variants); keep a default so the catalog is
        // always selectable.
        if (!matchedDefault && models.length > 0) {
          models[0].isDefault = true;
        }
      }
      await client.request("session/close", { sessionId }).catch(() => undefined);
      return { models, modes: ZCODE_MODES, defaultModeId: ZCODE_DEFAULT_MODE_ID };
    } finally {
      context?.signal.removeEventListener("abort", dispose);
      await dispose();
    }
  }

  async isAvailable(): Promise<boolean> {
    const { available } = await isZcodeLaunchAvailable(this.runtimeSettings);
    return available;
  }

  async getDiagnostic(): Promise<{ diagnostic: string }> {
    try {
      const { available, launch } = await isZcodeLaunchAvailable(this.runtimeSettings);
      return {
        diagnostic: formatProviderDiagnostic("ZCode", [
          { label: "Launch", value: describeZcodeLaunchSource(launch) },
          {
            label: "zcode on PATH",
            value: launch.source === "path" ? `found (${launch.command})` : "not found",
          },
          {
            label: "App bundle",
            value: existingZcodeAppBundleCjs() ?? "not found",
          },
          { label: "Status", value: available ? "available" : "unavailable" },
        ]),
      };
    } catch (error) {
      return { diagnostic: formatProviderDiagnosticError("ZCode", error) };
    }
  }
}

function defaultCatalogServerRequestHandler(method: string): unknown {
  switch (method) {
    case "session/requestRuntimePreferences":
      return ZCODE_RUNTIME_PREFERENCES;
    case "interaction/requestOfficialMcpAuthHeaders":
      return { ok: false, reason: "unavailable" };
    case "interaction/requestProviderRuntimeHeaders":
      return { headersApplied: false };
    default:
      // Catalog probing must never approve tool execution.
      return { decision: "deny", reason: "Paseo catalog probe" };
  }
}

export interface ZcodeModelMetadata {
  label?: string;
  providerLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoningLevels: string[];
  defaultReasoningLevel?: string;
}

interface ZcodeAvailableModel {
  ref?: { providerId?: string; modelId?: string };
  label?: string;
  providerLabel?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  reasoning?: { levels?: Array<{ value?: string }>; defaultLevel?: string };
}

function readZcodeAvailableModels(snapshot: unknown): ZcodeAvailableModel[] {
  if (!isRecord(snapshot)) return [];
  const settings = isRecord(snapshot.settings) ? snapshot.settings : {};
  const modelSettings = isRecord(settings.model) ? settings.model : {};
  const available = Array.isArray(modelSettings.available) ? modelSettings.available : [];
  return available.filter((entry): entry is ZcodeAvailableModel => isRecord(entry));
}

function zcodeModelKeyOf(candidate: ZcodeAvailableModel): string | null {
  const providerId = candidate.ref?.providerId;
  const modelId = candidate.ref?.modelId;
  if (typeof providerId !== "string" || !providerId || typeof modelId !== "string" || !modelId) {
    return null;
  }
  return `${providerId}/${modelId}`;
}

function reasoningLevelsOf(candidate: ZcodeAvailableModel): string[] {
  return (candidate.reasoning?.levels ?? [])
    .map((level) => (typeof level?.value === "string" ? level.value : null))
    .filter((value): value is string => value !== null);
}

export function readZcodeModelMetadata(snapshot: unknown): Map<string, ZcodeModelMetadata> {
  const metadata = new Map<string, ZcodeModelMetadata>();
  for (const candidate of readZcodeAvailableModels(snapshot)) {
    const key = zcodeModelKeyOf(candidate);
    if (!key) continue;
    const levels = reasoningLevelsOf(candidate);
    metadata.set(key, {
      label: typeof candidate.label === "string" ? candidate.label : undefined,
      providerLabel:
        typeof candidate.providerLabel === "string" ? candidate.providerLabel : undefined,
      contextWindow:
        typeof candidate.contextWindow === "number" && candidate.contextWindow > 0
          ? candidate.contextWindow
          : undefined,
      maxOutputTokens:
        typeof candidate.maxOutputTokens === "number" && candidate.maxOutputTokens > 0
          ? candidate.maxOutputTokens
          : undefined,
      reasoningLevels: levels,
      defaultReasoningLevel: candidate.reasoning?.defaultLevel,
    });
  }
  return metadata;
}

export function readZcodeCatalogModels(snapshot: unknown): AgentModelDefinition[] {
  const models: AgentModelDefinition[] = [];
  for (const candidate of readZcodeAvailableModels(snapshot)) {
    const key = zcodeModelKeyOf(candidate);
    if (!key) continue;
    const [providerId, modelId] = key.split("/");
    const levels = reasoningLevelsOf(candidate);
    const thinkingOptions: AgentSelectOption[] | undefined = levels.length
      ? levels.map((value) => ({ id: value, label: value }))
      : undefined;
    models.push({
      provider: ZCODE_PROVIDER,
      id: key,
      label: candidate.label ?? modelId,
      description: candidate.providerLabel ?? providerId,
      isDefault: models.length === 0,
      contextWindowMaxTokens:
        typeof candidate.contextWindow === "number" && candidate.contextWindow > 0
          ? candidate.contextWindow
          : undefined,
      thinkingOptions,
      defaultThinkingOptionId:
        candidate.reasoning?.defaultLevel ?? thinkingOptions?.[0]?.id ?? undefined,
      metadata: {
        providerId,
        modelId,
        maxOutputTokens: candidate.maxOutputTokens,
      },
    });
  }
  return models;
}
