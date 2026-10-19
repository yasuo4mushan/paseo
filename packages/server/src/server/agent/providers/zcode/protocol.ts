/**
 * ZCode app-server protocol client ("ZCode Protocol" v1).
 *
 * `zcode app-server` (bundled with the Z.ai ZCode desktop app, also usable as a
 * standalone CLI) speaks a private NDJSON protocol over stdio. It is
 * JSON-RPC-2.0-shaped but not JSON-RPC: there is no `jsonrpc` field and no
 * `initialize` handshake (the server answers `Method not found: initialize`).
 * Verified against ZCode 0.16.9:
 *
 *   client -> server request:      {"id": 1, "method": "...", "params": {...}}
 *   server -> client response:     {"id": 1, "result": {...}} | {"id": 1, "error": {...}}
 *   server -> client request:      {"id": "server-1", "method": "...", "params": {...}}
 *                                  (answer with {"id": "server-1", "result": {...}})
 *   notification (either direction): {"method": "...", "params": {...}}
 *
 * Server-request ids are strings ("server-N") while client-request ids are
 * numbers, which is how responses are correlated on both sides.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";

import { JsonlFrameDecoder } from "../jsonl-frame-decoder.js";
import { terminateWithTreeKill } from "../../../../utils/tree-kill.js";

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const GRACEFUL_SHUTDOWN_TIMEOUT_MS = 2_000;
const FORCE_SHUTDOWN_TIMEOUT_MS = 1_000;
const STDERR_BUFFER_LIMIT = 8192;

/** Answer for `session/requestRuntimePreferences` (verified live). */
export const ZCODE_RUNTIME_PREFERENCES = {
  nativeSearchEnhancementsEnabled: false,
  memoryEnabled: false,
  askUserQuestionAutoResolutionEnabled: true,
  modelContextBudgetStrategy: "preflight-v1",
} as const;

export class ZCodeRpcError extends Error {
  constructor(
    message: string,
    readonly code: string | number | undefined,
    readonly data: unknown,
  ) {
    super(message);
    this.name = "ZCodeRpcError";
  }
}

export interface ZCodeExit {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error;
}

export interface ZCodeServerRequest {
  id: string;
  method: string;
  params: unknown;
}

export interface ZCodeNotification {
  method: string;
  params: unknown;
}

type ServerRequestHandler = (request: ZCodeServerRequest) => unknown;
type NotificationHandler = (notification: ZCodeNotification) => void;

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function createTimeout(timeoutMs: number | null, onTimeout: () => void): NodeJS.Timeout | null {
  if (timeoutMs == null || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return null;
  }
  return setTimeout(onTimeout, timeoutMs);
}

export interface ZCodeAppServerClientOptions {
  child: ChildProcessWithoutNullStreams;
  logger: Logger;
  /** Handler for server -> client requests (permissions, questions, runtime prefs). */
  onServerRequest?: ServerRequestHandler;
  /** Handler for notifications (session/event, state.updated, ...). */
  onNotification?: NotificationHandler;
  /** Called once when the process exits unexpectedly (not via dispose). */
  onUnexpectedExit?: (exit: ZCodeExit) => void;
  defaultRequestTimeoutMs?: number;
}

export class ZCodeAppServerClient {
  private readonly pending = new Map<number, PendingRequest>();
  private readonly frameDecoder: JsonlFrameDecoder;
  private nextRequestId = 1;
  private disposed = false;
  private stderrBuffer = "";

  constructor(private readonly options: ZCodeAppServerClientOptions) {
    const { child } = options;
    this.frameDecoder = new JsonlFrameDecoder({
      frame: (message) => this.handleFrame(message),
      problem: (problem, detail) => {
        options.logger.warn({ problem, detail }, "Ignoring invalid zcode frame");
      },
    });
    child.stdout.on("data", (chunk: Buffer) => {
      this.frameDecoder.write(chunk.toString());
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderrBuffer += chunk.toString();
      if (this.stderrBuffer.length > STDERR_BUFFER_LIMIT) {
        this.stderrBuffer = this.stderrBuffer.slice(-STDERR_BUFFER_LIMIT);
      }
    });
    child.stdin.on("error", (error) => {
      this.options.logger.warn({ err: error }, "zcode app-server stdin write failed");
    });
    child.on("error", (error) => {
      this.handleExit(null, null, error instanceof Error ? error : new Error(String(error)));
    });
    child.on("exit", (code, signal) => {
      this.handleExit(
        code,
        signal,
        new Error(
          `zcode app-server exited with code ${code ?? "null"} and signal ${signal ?? "null"}\n${this.stderrBuffer}`.trim(),
        ),
      );
    });
  }

  request(method: string, params?: unknown, timeoutMs?: number | null): Promise<unknown> {
    if (this.disposed) {
      return Promise.reject(new Error("zcode app-server client is closed"));
    }
    const id = this.nextRequestId++;
    const requestTimeoutMs =
      timeoutMs === undefined
        ? (this.options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS)
        : timeoutMs;
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = createTimeout(requestTimeoutMs, () => {
        this.pending.delete(id);
        reject(
          new Error(
            `zcode app-server request timed out method=${method} elapsedMs=${Date.now() - startedAt}\n${this.stderrBuffer}`.trim(),
          ),
        );
      });
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params });
    });
  }

  send(message: Record<string, unknown>): void {
    if (this.disposed) return;
    const { stdin } = this.options.child;
    if (stdin.destroyed || !stdin.writable) {
      this.options.logger.warn("zcode app-server stdin is not writable; dropping frame");
      return;
    }
    try {
      stdin.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.options.logger.warn({ err: error }, "zcode app-server stdin write failed");
    }
  }

  /** Answer a server -> client request. */
  respondToServer(id: string, result: unknown): void {
    this.send({ id, result });
  }

  async dispose(exitError = new Error("zcode app-server client is closed")): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(exitError);
    try {
      this.options.child.stdin.end();
    } catch {
      // Ignore cleanup races.
    }
    const result = await terminateWithTreeKill(this.options.child, {
      gracefulTimeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS,
      forceTimeoutMs: FORCE_SHUTDOWN_TIMEOUT_MS,
      onForceSignal: () => {
        this.options.logger.warn(
          { timeoutMs: GRACEFUL_SHUTDOWN_TIMEOUT_MS },
          "zcode app-server did not exit after SIGTERM; sending SIGKILL",
        );
      },
    });
    if (result === "kill-timeout") {
      this.options.logger.warn("zcode app-server did not report exit after SIGKILL");
    }
  }

  private handleFrame(message: Record<string, unknown>): void {
    if (this.disposed) return;
    if (typeof message.id === "number" && message.method === undefined) {
      this.settleResponse(message.id, message);
      return;
    }
    if (typeof message.id === "string" && typeof message.method === "string") {
      this.dispatchServerRequest({
        id: message.id,
        method: message.method,
        params: message.params,
      });
      return;
    }
    if (message.method !== undefined && message.id === undefined) {
      this.options.onNotification?.({ method: message.method as string, params: message.params });
      return;
    }
    this.options.logger.debug({ frame: message }, "Ignoring unrecognized zcode frame");
  }

  private settleResponse(id: number, response: Record<string, unknown>): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    const error = response.error;
    if (isRecord(error)) {
      pending.reject(
        new ZCodeRpcError(
          typeof error.message === "string" ? error.message : "Unknown zcode error",
          error.code as string | number | undefined,
          error.data,
        ),
      );
      return;
    }
    pending.resolve(response.result);
  }

  private dispatchServerRequest(request: ZCodeServerRequest): void {
    let result: unknown;
    try {
      result = this.options.onServerRequest?.(request);
    } catch (error) {
      this.options.logger.warn(
        { err: error, method: request.method },
        "zcode server request handler threw; denying",
      );
      this.respondToServer(request.id, {
        error: { message: error instanceof Error ? error.message : String(error) },
      });
      return;
    }
    // Handlers may return promises; settle asynchronously either way.
    void Promise.resolve(result).then(
      (settled) => this.respondToServer(request.id, settled),
      (error) => {
        this.options.logger.warn(
          { err: error, method: request.method },
          "zcode server request handler rejected; denying",
        );
        this.respondToServer(request.id, {
          error: { message: error instanceof Error ? error.message : String(error) },
        });
      },
    );
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null, error: Error): void {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectPending(error);
    this.options.onUnexpectedExit?.({ code, signal, error });
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

// ---------------------------------------------------------------------------
// Typed views over protocol payloads. The app-server validates its own frames
// with strict zod schemas, so these parsers stay defensive: unknown shapes
// degrade rather than throw.
// ---------------------------------------------------------------------------

export interface ZcodeUsagePayload {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export interface ZcodeTurnError {
  type?: string;
  message?: string;
  code?: string;
  detail?: string;
  attribution?: { statusCode?: number; transport?: string; reason?: string };
}

export interface ZcodeToolResultPayload {
  success?: boolean;
  content?: unknown;
  truncated?: boolean;
}

export interface ZcodeStreamEvent {
  type?: string;
  payload?: {
    kind?: string;
    delta?: string;
    input?: unknown;
    assistantMessageId?: string;
    toolCallId?: string;
    toolName?: string;
    response?: string;
    usage?: ZcodeUsagePayload;
    result?: ZcodeToolResultPayload;
    error?: ZcodeTurnError;
    taskId?: string;
    status?: string;
    trigger?: string;
    operationId?: string;
    preCompactTokenCount?: number;
  };
}

export function parseZcodeStreamEvent(params: unknown): ZcodeStreamEvent | null {
  if (!isRecord(params)) return null;
  const payload = isRecord(params.payload) ? params.payload : {};
  return {
    type: typeof params.type === "string" ? params.type : undefined,
    payload,
  };
}

export function formatZcodeTurnError(error: ZcodeTurnError | undefined): string | null {
  if (!error) return null;
  const message = typeof error.message === "string" && error.message ? error.message : error.type;
  if (!message) return null;
  const statusCode = error.attribution?.statusCode;
  return typeof statusCode === "number" ? `${message} (HTTP ${statusCode})` : message;
}

export function extractZcodeSessionId(createResult: unknown): string | null {
  if (!isRecord(createResult)) return null;
  const session = createResult.session;
  if (!isRecord(session)) return null;
  return typeof session.sessionId === "string" && session.sessionId ? session.sessionId : null;
}
