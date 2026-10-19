import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  parseZcodeModelRef,
  readZcodeCatalogModels,
  ZcodeAgentClient,
  ZCODE_DEFAULT_MODE_ID,
  ZCODE_MODES,
  ZCODE_PROVIDER,
  ZcodeAgentSession,
} from "./agent.js";
import { ZCodeAppServerClient, ZCodeRpcError } from "./protocol.js";
import { FakeZcodeAppServer, createTestLogger } from "./test-utils/fake-zcode-server.js";
import { isZcodeLaunchAvailable, resolveZcodeLaunch } from "./discovery.js";
import type { AgentStreamEvent } from "../../agent-sdk-types.js";

function createSession(server: FakeZcodeAppServer, configOverrides: Record<string, unknown> = {}) {
  const session = new ZcodeAgentSession(
    {
      provider: ZCODE_PROVIDER,
      cwd: "/tmp/zcode-test-workspace",
      ...configOverrides,
    },
    null,
    createTestLogger(),
    {
      spawn: () => server.child,
    },
  );
  const events: AgentStreamEvent[] = [];
  session.subscribe((event) => events.push(event));
  return { session, events };
}

function timelineItems(events: AgentStreamEvent[]) {
  return events
    .filter(
      (event): event is Extract<AgentStreamEvent, { type: "timeline" }> =>
        event.type === "timeline",
    )
    .map((event) => event.item);
}

function captureServerRequestResults(server: FakeZcodeAppServer): Array<Record<string, unknown>> {
  const results: Array<Record<string, unknown>> = [];
  (server.child.stdin as PassThrough).on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      const frame = JSON.parse(line) as Record<string, unknown>;
      if (typeof frame.id === "string" && frame.result !== undefined) {
        results.push(frame.result as Record<string, unknown>);
      }
    }
  });
  return results;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("ZCodeAppServerClient protocol transport", () => {
  it("correlates responses to requests by numeric id", async () => {
    const server = new FakeZcodeAppServer();
    const client = server.client();
    server.onClientRequest = (request) => {
      // Keep the create pending so the manual response is the only one.
      return request.method === "session/create";
    };
    const pending = client.request("session/create", { workspace: {} });
    await new Promise((resolve) => setImmediate(resolve));
    const request = server.clientRequests.find((entry) => entry.method === "session/create");
    expect(request).toBeDefined();
    server.respond(request!.id, { session: { sessionId: "s1" } });
    await expect(pending).resolves.toEqual({ session: { sessionId: "s1" } });
    await client.dispose();
  });

  it("rejects with ZCodeRpcError on error responses", async () => {
    const server = new FakeZcodeAppServer();
    const client = server.client();
    server.onClientRequest = (request) => {
      if (request.method === "session/read") {
        server.respondError(request.id, { code: -32602, message: "Invalid params" });
        return true;
      }
      return false;
    };
    const pending = client.request("session/read", { sessionId: "missing" });
    const rejection = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBeInstanceOf(ZCodeRpcError);
    await client.dispose();
  });

  it("answers server requests with the handler result under the string id", async () => {
    const seen: Array<{ id: string; result: unknown }> = [];
    const emitter = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
    emitter.stdin = new PassThrough() as ChildProcessWithoutNullStreams["stdin"];
    emitter.stdout = new PassThrough() as ChildProcessWithoutNullStreams["stdout"];
    emitter.stderr = new PassThrough() as ChildProcessWithoutNullStreams["stderr"];
    emitter.kill = (() => {
      emitter.emit("exit", 0, null);
      return true;
    }) as ChildProcessWithoutNullStreams["kill"];
    const client = new ZCodeAppServerClient({
      child: emitter,
      logger: createTestLogger(),
      onServerRequest: (request) => ({ echoed: request.id, method: request.method }),
    });
    (emitter.stdin as PassThrough).on("data", (chunk: Buffer) => {
      for (const line of chunk.toString().split("\n")) {
        if (!line.trim()) continue;
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (typeof frame.id === "string" && frame.method === undefined) {
          seen.push({ id: frame.id, result: frame.result });
        }
      }
    });
    (emitter.stdout as PassThrough).write(
      `${JSON.stringify({ id: "server-7", method: "interaction/requestOfficialMcpAuthHeaders", params: {} })}\n`,
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(seen).toEqual([
      {
        id: "server-7",
        result: {
          echoed: "server-7",
          method: "interaction/requestOfficialMcpAuthHeaders",
        },
      },
    ]);
    await client.dispose();
  });

  it("rejects pending requests when the process exits", async () => {
    const server = new FakeZcodeAppServer();
    const client = server.client();
    server.onClientRequest = () => true; // Leave every request pending.
    const pending = client.request("session/read", { sessionId: "s" }, 60_000);
    await new Promise((resolve) => setImmediate(resolve));
    server.child.emit("exit", 1, null);
    await expect(pending).rejects.toThrow(/zcode app-server exited/);
  });
});

describe("ZcodeAgentSession turn lifecycle", () => {
  it("runs a full turn: create, subscribe, send, stream, turn.completed", async () => {
    const server = new FakeZcodeAppServer();
    server.onSend = () => {
      server.sessionEvent({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: "Hello", assistantMessageId: "m1" },
      });
      server.sessionEvent({
        type: "model.streaming",
        payload: { kind: "text_delta", delta: " world", assistantMessageId: "m1" },
      });
      server.sessionEvent({
        type: "model.streaming",
        payload: { kind: "reasoning_delta", delta: "thinking...", assistantMessageId: "m1" },
      });
      server.sessionEvent({
        type: "model.streaming",
        payload: { kind: "tool_input_start", toolCallId: "tc1", toolName: "bash" },
      });
      server.sessionEvent({
        type: "model.streaming",
        payload: {
          kind: "tool_call",
          toolCallId: "tc1",
          toolName: "bash",
          input: { command: "echo hi" },
        },
      });
      server.sessionEvent({
        type: "tool.updated",
        payload: { toolCallId: "tc1", kind: "result", result: { success: true, content: "hi" } },
      });
      server.sessionEvent({
        type: "turn.completed",
        payload: {
          response: "Hello world",
          usage: { inputTokens: 120, outputTokens: 30, cacheReadTokens: 20 },
        },
      });
    };
    const { session, events } = createSession(server, { model: "zai/GLM-5.3" });
    const result = await session.run("hi");

    const methods = server.clientRequests.map((request) => request.method);
    expect(methods).toContain("session/create");
    expect(methods).toContain("session/subscribe");
    expect(methods).toContain("session/send");
    expect(methods).toContain("session/setModel");

    expect(result.finalText).toBe("Hello world");
    expect(result.sessionId).toBe("sess-create-1");
    expect(result.usage).toEqual({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 });

    const items = timelineItems(events);
    expect(
      items.filter((item) => item.type === "assistant_message").map((item) => item.text),
    ).toEqual(["Hello", "Hello world"]);
    expect(items.find((item) => item.type === "reasoning")).toMatchObject({
      text: "thinking...",
    });
    const toolCalls = items.filter(
      (item): item is Extract<typeof item, { type: "tool_call" }> => item.type === "tool_call",
    );
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0]).toMatchObject({
      callId: "tc1",
      status: "running",
      detail: { type: "shell", command: "echo hi" },
    });
    expect(toolCalls[1]).toMatchObject({
      callId: "tc1",
      status: "completed",
      detail: { type: "shell", command: "echo hi", output: "hi" },
    });
    expect(events.at(-1)?.type).toBe("turn_completed");
    await session.close();
  });

  it("maps turn.failed errors with attribution status codes", async () => {
    const server = new FakeZcodeAppServer();
    server.onSend = () => {
      server.sessionEvent({
        type: "turn.failed",
        payload: {
          error: { type: "provider", message: "Origin Time-out", attribution: { statusCode: 524 } },
        },
      });
    };
    const { session, events } = createSession(server);
    await expect(session.run("hi")).rejects.toThrow(
      /zcode turn failed: Origin Time-out \(HTTP 524\)/,
    );
    expect(events.some((event) => event.type === "turn_failed")).toBe(true);
    await session.close();
  });

  it("reports cancellation-shaped failures as turn_canceled", async () => {
    const server = new FakeZcodeAppServer();
    server.onSend = () => {
      server.sessionEvent({
        type: "turn.failed",
        payload: { error: { message: "Turn cancelled by user" } },
      });
    };
    const { session, events } = createSession(server);
    await session.run("hi");
    expect(events.some((event) => event.type === "turn_canceled")).toBe(true);
    await session.close();
  });

  it("interrupt sends session/stop and cancels locally when the server stays quiet", async () => {
    const server = new FakeZcodeAppServer();
    server.onSend = () => {
      // Never publish a terminal event.
    };
    const { session, events } = createSession(server);
    const turn = await session.startTurn("work");
    await session.interrupt();
    expect(server.clientRequests.some((request) => request.method === "session/stop")).toBe(true);
    expect(
      events.some((event) => event.type === "turn_canceled" && event.turnId === turn.turnId),
    ).toBe(true);
    await session.close();
  });

  it("resumes the persisted native session when a handle is provided", async () => {
    const server = new FakeZcodeAppServer();
    const session = new ZcodeAgentSession(
      { provider: ZCODE_PROVIDER, cwd: "/tmp/zcode-test-workspace" },
      { provider: ZCODE_PROVIDER, sessionId: "paseo-1", nativeHandle: "sess-old" },
      createTestLogger(),
      { spawn: () => server.child },
    );
    await session.startTurn("continue");
    const resume = server.clientRequests.find((request) => request.method === "session/resume");
    expect(resume?.params).toEqual({ sessionId: "sess-old" });
    await session.close();
  });

  it("falls back to a new session when resume fails", async () => {
    const server = new FakeZcodeAppServer();
    server.onClientRequest = (request) => {
      if (request.method === "session/resume") {
        server.respondError(request.id, { code: -32000, message: "Session not found" });
        return true;
      }
      return false;
    };
    const session = new ZcodeAgentSession(
      { provider: ZCODE_PROVIDER, cwd: "/tmp/zcode-test-workspace" },
      { provider: ZCODE_PROVIDER, sessionId: "paseo-1", nativeHandle: "sess-gone" },
      createTestLogger(),
      { spawn: () => server.child },
    );
    await session.startTurn("hi");
    const creates = server.clientRequests.filter((request) => request.method === "session/create");
    expect(creates).toHaveLength(1);
    await session.close();
  });

  it("applies model and mode selections before sending", async () => {
    const server = new FakeZcodeAppServer();
    const { session } = createSession(server, {
      model: "zai/GLM-5.3",
      thinkingOptionId: "high",
      modeId: "plan",
    });
    await session.startTurn("hi");
    const setModel = server.clientRequests.find((request) => request.method === "session/setModel");
    expect(setModel?.params).toEqual({
      sessionId: "sess-create-1",
      model: {
        providerId: "zai",
        modelId: "GLM-5.3",
        options: { reasoningLevel: "high" },
      },
    });
    const setMode = server.clientRequests.find((request) => request.method === "session/setMode");
    expect(setMode?.params).toEqual({ sessionId: "sess-create-1", mode: "plan" });
    await session.close();
  });

  it("retries setModel without the reasoning level when the server rejects it", async () => {
    const server = new FakeZcodeAppServer();
    let rejectedFirstSetModel = false;
    server.onClientRequest = (request) => {
      if (request.method === "session/setModel" && !rejectedFirstSetModel) {
        rejectedFirstSetModel = true;
        server.respondError(request.id, { code: -32602, message: "reasoning not supported" });
        return true;
      }
      return false;
    };
    const { session } = createSession(server, {
      model: "zai/GLM-5.3",
      thinkingOptionId: "high",
    });
    await session.startTurn("hi");
    const setModelRequests = server.clientRequests.filter(
      (request) => request.method === "session/setModel",
    );
    expect(setModelRequests).toHaveLength(2);
    expect(setModelRequests[1]?.params).toEqual({
      sessionId: "sess-create-1",
      model: { providerId: "zai", modelId: "GLM-5.3" },
    });
    await session.close();
  });
});

describe("ZcodeAgentSession permissions", () => {
  it("surfaces tool permission requests and forwards the decision", async () => {
    const server = new FakeZcodeAppServer();
    const results = captureServerRequestResults(server);
    const { session, events } = createSession(server);
    server.onSend = () => {
      server.serverRequest("interaction/requestPermission", {
        requestId: "perm-1",
        toolCallId: "tc9",
        toolName: "bash",
        reason: "Run bash?",
        input: { command: "rm -rf /tmp/x" },
      });
    };
    const runPromise = session.run("do something");
    await flush();
    const pending = session.getPendingPermissions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      id: "perm-1",
      kind: "tool",
      name: "bash",
      title: "Run bash?",
    });
    await session.respondToPermission("perm-1", { behavior: "allow" });
    server.sessionEvent({ type: "turn.completed", payload: { response: "done" } });
    await runPromise;
    expect(results).toContainEqual({ decision: "allow" });
    expect(events.some((event) => event.type === "permission_requested")).toBe(true);
    expect(events.some((event) => event.type === "permission_resolved")).toBe(true);
    await session.close();
  });

  it("emits a failed tool call when a tool permission is denied", async () => {
    const server = new FakeZcodeAppServer();
    const { session, events } = createSession(server);
    server.onSend = () => {
      server.serverRequest("interaction/requestPermission", {
        requestId: "perm-deny",
        toolCallId: "tc-deny",
        toolName: "bash",
        input: { command: "rm -rf /" },
      });
    };
    const runPromise = session.run("danger");
    await flush();
    await session.respondToPermission("perm-deny", { behavior: "deny", message: "no" });
    server.sessionEvent({ type: "turn.completed", payload: {} });
    await runPromise;
    const denied = timelineItems(events).find(
      (item) => item.type === "tool_call" && item.callId === "tc-deny",
    );
    expect(denied).toMatchObject({ status: "failed" });
    await session.close();
  });

  it("maps askUserQuestion interactions to question permissions", async () => {
    const server = new FakeZcodeAppServer();
    const results = captureServerRequestResults(server);
    const { session, events } = createSession(server);
    server.onSend = () => {
      server.serverRequest("interaction/requestUserInput", {
        requestId: "q-1",
        currentQuestionIndex: 0,
        questions: [
          {
            question: "Which flavor?",
            header: "Flavor",
            options: [
              { value: "mint", label: "Mint" },
              { value: "vanilla", label: "Vanilla" },
            ],
          },
        ],
      });
    };
    const runPromise = session.run("pick one");
    await flush();
    const pending = session.getPendingPermissions();
    expect(pending[0]).toMatchObject({ kind: "question", name: "askUserQuestion" });
    await session.respondToPermission("q-1", {
      behavior: "allow",
      selectedActionId: "mint",
    });
    server.sessionEvent({ type: "turn.completed", payload: {} });
    await runPromise;
    expect(results).toContainEqual({ requestId: "q-1", value: "mint" });
    const questionItems = timelineItems(events).filter((item) => item.type === "tool_call");
    expect(questionItems.at(-1)).toMatchObject({ status: "completed" });
    await session.close();
  });

  it("cancels unanswerable user input requests fail-closed", async () => {
    const server = new FakeZcodeAppServer();
    const results = captureServerRequestResults(server);
    const { session } = createSession(server);
    server.onSend = () => {
      // Malformed request: no questions array.
      server.serverRequest("interaction/requestUserInput", { requestId: "q-bad" });
    };
    const runPromise = session.run("x");
    await flush();
    server.sessionEvent({ type: "turn.completed", payload: {} });
    await runPromise;
    expect(results).toContainEqual({ requestId: "q-bad", cancelled: true });
    await session.close();
  });

  it("denies pending permissions when the session closes", async () => {
    const server = new FakeZcodeAppServer();
    const results = captureServerRequestResults(server);
    const { session } = createSession(server);
    server.onSend = () => {
      server.serverRequest("interaction/requestPermission", {
        requestId: "perm-close",
        toolName: "bash",
        input: { command: "ls" },
      });
    };
    const runPromise = session.run("x");
    // close() settles the turn synchronously; mark the rejection handled
    // before the awaited assertion below.
    void runPromise.catch(() => undefined);
    await flush();
    await session.close();
    await expect(runPromise).rejects.toThrow("zcode session closed");
    expect(results).toContainEqual({ decision: "deny", reason: "Session closed" });
  });
});

describe("parseZcodeModelRef", () => {
  it("splits provider and model on the first slash", () => {
    expect(parseZcodeModelRef("builtin:bigmodel-coding-plan/GLM-5.3-Flash")).toEqual({
      providerId: "builtin:bigmodel-coding-plan",
      modelId: "GLM-5.3-Flash",
    });
    expect(parseZcodeModelRef("noid")).toBeNull();
    expect(parseZcodeModelRef("/leading")).toBeNull();
    expect(parseZcodeModelRef(null)).toBeNull();
  });
});

describe("readZcodeCatalogModels", () => {
  it("maps available model refs with thinking options and defaults", () => {
    const models = readZcodeCatalogModels({
      settings: {
        model: {
          current: { providerId: "zai", modelId: "GLM-5.3" },
          available: [
            {
              ref: { providerId: "zai", modelId: "GLM-5.3" },
              contextWindow: 1_000_000,
              maxOutputTokens: 128_000,
              reasoning: {
                levels: [{ value: "low" }, { value: "high" }],
                defaultLevel: "high",
              },
            },
            { ref: { providerId: "zai", modelId: "GLM-5.3-Flash" } },
          ],
        },
      },
    });
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      provider: ZCODE_PROVIDER,
      id: "zai/GLM-5.3",
      label: "GLM-5.3",
      isDefault: true,
      contextWindowMaxTokens: 1_000_000,
      defaultThinkingOptionId: "high",
    });
    expect(models[0]?.thinkingOptions).toEqual([
      { id: "low", label: "low" },
      { id: "high", label: "high" },
    ]);
    expect(models[1]?.isDefault).toBe(false);
  });

  it("returns empty for unknown snapshots", () => {
    expect(readZcodeCatalogModels({})).toEqual([]);
    expect(readZcodeCatalogModels(null)).toEqual([]);
  });
});

describe("ZcodeAgentClient", () => {
  it("fetches the catalog through a spawned app-server and closes the probe session", async () => {
    const server = new FakeZcodeAppServer();
    server.onClientRequest = (request) => {
      if (request.method === "session/read") {
        server.respond(request.id, {
          settings: {
            model: {
              available: [{ ref: { providerId: "zai", modelId: "GLM-5.3" } }],
            },
          },
        });
        return true;
      }
      return false;
    };
    const client = new ZcodeAgentClient(createTestLogger(), undefined, {
      spawn: () => server.child,
    });
    const catalog = await client.fetchCatalog({ scope: "global", force: true });
    expect(catalog.models).toHaveLength(1);
    expect(catalog.models[0]?.id).toBe("zai/GLM-5.3");
    expect(catalog.defaultModeId).toBe(ZCODE_DEFAULT_MODE_ID);
    expect(catalog.modes).toEqual(ZCODE_MODES);
    expect(server.clientRequests.some((request) => request.method === "session/close")).toBe(true);
  });

  it("createSession wires spawn and exposes persistence after a turn", async () => {
    const server = new FakeZcodeAppServer();
    server.onSend = () => {
      server.sessionEvent({
        type: "turn.completed",
        payload: { response: "ok" },
      });
    };
    const spawn = vi.fn(() => server.child);
    const client = new ZcodeAgentClient(createTestLogger(), undefined, { spawn });
    const session = await client.createSession({ provider: "zcode", cwd: "/tmp/ws" });
    expect(spawn).toHaveBeenCalled();
    expect(session.provider).toBe("zcode");
    const result = await session.run("hi");
    expect(result.finalText).toBe("ok");
    const persistence = session.describePersistence();
    expect(persistence?.provider).toBe("zcode");
    expect(persistence?.nativeHandle).toBe("sess-create-1");
    await session.close();
  });
});

describe("zcode discovery", () => {
  it("uses a replace override verbatim and appends app-server", async () => {
    const launch = await resolveZcodeLaunch({
      command: { mode: "replace", argv: ["/opt/zcode/bin/zcode", "--verbose"] },
    });
    expect(launch).toEqual({
      command: "/opt/zcode/bin/zcode",
      args: ["--verbose", "app-server"],
      source: "override",
    });
  });

  it("reports override availability for absolute paths", async () => {
    const { available, launch } = await isZcodeLaunchAvailable({
      command: { mode: "replace", argv: [process.execPath] },
    });
    expect(available).toBe(true);
    expect(launch.source).toBe("override");
  });

  it("marks unavailable when nothing resolves", async () => {
    const { available } = await isZcodeLaunchAvailable({
      command: { mode: "replace", argv: ["/nonexistent/zcode-binary"] },
    });
    expect(available).toBe(false);
  });
});
