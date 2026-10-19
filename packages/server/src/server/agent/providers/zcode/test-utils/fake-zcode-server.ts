import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { Logger } from "pino";
import { pino } from "pino";

import { ZCodeAppServerClient } from "../protocol.js";

export function createTestLogger(): Logger {
  return pino({ level: "silent" });
}

export interface CapturedServerRequest {
  id: string;
  method: string;
  params: unknown;
  respond: (result: unknown) => void;
}

export interface CapturedClientRequest {
  id: number;
  method: string;
  params: unknown;
}

export class FakeZcodeAppServer {
  readonly child: ChildProcessWithoutNullStreams;
  readonly clientRequests: CapturedClientRequest[] = [];
  readonly serverRequests: CapturedServerRequest[] = [];
  readonly notifications: Array<{ method: string; params: unknown }> = [];
  private nextServerRequestId = 1;
  /** Scripts the response to `session/send`; defaults to an immediate ack. */
  onSend: (params: { sessionId: string; content: string }) => void = () => {};
  /** Called for every server->client request before it is captured. */
  onServerRequest: (request: CapturedServerRequest) => void = () => {};
  /**
   * Intercept a client->server request before the default scripting runs.
   * Return true when the request was handled (responded or intentionally
   * left pending).
   */
  onClientRequest: (request: CapturedClientRequest) => boolean = () => false;

  constructor() {
    const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    emitter.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    emitter.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    emitter.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    emitter.kill = ((signal?: NodeJS.Signals) => {
      emitter.emit("exit", null, signal ?? "SIGTERM");
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    this.child = emitter;

    let buffer = "";
    emitter.stdin.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) this.handleLine(line);
      }
    });
  }

  /** Responds to a captured client request on its behalf. */
  respond(id: number, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: number, error: unknown): void {
    this.write({ id, error });
  }

  /** Pushes a notification frame to the client. */
  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  /** Pushes a server->client request and captures it. */
  serverRequest(method: string, params: unknown): CapturedServerRequest {
    const id = `server-${this.nextServerRequestId++}`;
    const request: CapturedServerRequest = {
      id,
      method,
      params,
      respond: (result) => this.write({ id, result }),
    };
    this.serverRequests.push(request);
    this.onServerRequest(request);
    this.write({ id, method, params });
    return request;
  }

  sessionEvent(params: unknown): void {
    this.notify("session/event", params);
  }

  client(): ZCodeAppServerClient {
    return new ZCodeAppServerClient({
      child: this.child,
      logger: createTestLogger(),
      onNotification: (notification) => this.notifications.push(notification),
      onServerRequest: (request) => {
        const captured: CapturedServerRequest = {
          id: request.id,
          method: request.method,
          params: request.params,
          respond: (result) => this.write({ id: request.id, result }),
        };
        this.serverRequests.push(captured);
        this.onServerRequest(captured);
      },
    });
  }

  private write(frame: Record<string, unknown>): void {
    (this.child.stdout as PassThrough).write(`${JSON.stringify(frame)}\n`);
  }

  private handleLine(line: string): void {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const request: CapturedClientRequest = {
      id: frame.id as number,
      method: frame.method as string,
      params: frame.params,
    };
    this.clientRequests.push(request);
    if (this.onClientRequest(request)) {
      return;
    }
    switch (request.method) {
      case "session/create":
        this.respond(request.id, { session: { sessionId: "sess-create-1" } });
        return;
      case "session/resume":
        this.respond(request.id, {});
        return;
      case "session/subscribe":
        this.respond(request.id, {});
        return;
      case "session/setModel":
      case "session/setMode":
      case "session/setThoughtLevel":
      case "session/close":
        this.respond(request.id, {});
        return;
      case "session/send":
        this.respond(request.id, {});
        this.onSend(request.params as { sessionId: string; content: string });
        return;
      case "session/stop":
        this.respond(request.id, {});
        return;
      default:
        this.respond(request.id, {});
    }
  }
}
