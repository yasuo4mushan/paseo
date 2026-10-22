/**
 * t19 新增协议方法测试：文件写回/条目操作/文件订阅、diff、终端流订阅与输入、
 * subagents、斜杠命令。复用 t18 的内存 mock socket 套路。
 */
import { describe, expect, it } from "vitest";
import { DaemonConnection, type DaemonConnectionEvents } from "../src/connection/daemon-connection";
import { encodeTerminalStreamFrame, TerminalStreamOpcode } from "../src/connection/terminal-frames";
import { createMockSocketPair, type MockDaemonSide } from "./helpers/mock-socket";

const SERVER_INFO_MESSAGE = {
  type: "status",
  payload: { status: "server_info", serverId: "srv_test", version: "0.13.0-test" },
};

function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error("waitUntil timeout"));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

async function connectedHarness(events?: DaemonConnectionEvents): Promise<{
  conn: DaemonConnection;
  server: MockDaemonSide;
}> {
  const pair = createMockSocketPair();
  const conn = new DaemonConnection(() => pair.clientPort, { clientId: "t19-client" }, events);
  const connectPromise = conn.connect();
  pair.server.emitOpen();
  await waitUntil(() => pair.server.sentFrames.some((frame) => frame.includes('"hello"')));
  pair.server.pushSession(SERVER_INFO_MESSAGE);
  await connectPromise;
  return { conn, server: pair.server };
}

async function captureRequest(
  server: MockDaemonSide,
  type: string,
): Promise<{ type: string; requestId: string } & Record<string, unknown>> {
  await waitUntil(() => server.sentFrames.some((frame) => frame.includes(`"${type}"`)));
  for (let i = server.sentFrames.length - 1; i >= 0; i -= 1) {
    const parsed = JSON.parse(server.sentFrames[i]) as {
      type?: string;
      message?: Record<string, unknown>;
    };
    if (parsed.type === "session" && parsed.message?.type === type) {
      return parsed.message as { type: string; requestId: string } & Record<string, unknown>;
    }
  }
  throw new Error(`request not found: ${type}`);
}

function respond(
  server: MockDaemonSide,
  request: { requestId: string },
  responseType: string,
  payload: Record<string, unknown>,
): void {
  server.pushSession({ type: responseType, payload: { ...payload, requestId: request.requestId } });
}

describe("t19 文件写回与条目操作", () => {
  it("writeFile：请求带 expectedModifiedAt/revision；written 结果回填版本", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.writeFile({
      cwd: "/repo",
      path: "src/a.ts",
      content: "new content",
      expectedModifiedAt: "2026-10-01T00:00:00Z",
      expectedRevision: "r1",
    });
    const request = await captureRequest(server, "fs.file.write.request");
    expect(request.cwd).toBe("/repo");
    expect(request.path).toBe("src/a.ts");
    expect(request.content).toBe("new content");
    expect(request.expectedModifiedAt).toBe("2026-10-01T00:00:00Z");
    expect(request.expectedRevision).toBe("r1");
    respond(server, request, "fs.file.write.response", {
      result: { status: "written", modifiedAt: "2026-10-02T00:00:00Z", size: 11, revision: "r2" },
    });
    const result = await pending;
    expect(result).toEqual({
      status: "written",
      modifiedAt: "2026-10-02T00:00:00Z",
      size: 11,
      revision: "r2",
    });
    conn.close();
  });

  it("writeFile：conflict 带远端当前版本", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.writeFile({
      cwd: "/repo",
      path: "src/a.ts",
      content: "x",
      expectedModifiedAt: "2026-10-01T00:00:00Z",
    });
    const request = await captureRequest(server, "fs.file.write.request");
    respond(server, request, "fs.file.write.response", {
      result: {
        status: "conflict",
        version: {
          status: "ready",
          cwd: "/repo",
          path: "src/a.ts",
          size: 99,
          modifiedAt: "2026-10-03T00:00:00Z",
          revision: "r9",
        },
      },
    });
    const result = await pending;
    expect(result.status).toBe("conflict");
    if (result.status === "conflict") {
      expect(result.version.status).toBe("ready");
      if (result.version.status === "ready") {
        expect(result.version.modifiedAt).toBe("2026-10-03T00:00:00Z");
        expect(result.version.revision).toBe("r9");
      }
    }
    conn.close();
  });

  it("createFsEntry / renameFsEntry / deleteFsEntry 请求与结果", async () => {
    const { conn, server } = await connectedHarness();

    const createPending = conn.createFsEntry({
      cwd: "/repo",
      parentPath: "src",
      name: "notes.md",
      kind: "file",
    });
    const createRequest = await captureRequest(server, "fs.entry.create.request");
    expect(createRequest.kind).toBe("file");
    expect(createRequest.parentPath).toBe("src");
    respond(server, createRequest, "fs.entry.create.response", {
      cwd: "/repo",
      parentPath: "src",
      path: "src/notes.md",
      success: true,
      error: null,
    });
    expect((await createPending).success).toBe(true);

    const renamePending = conn.renameFsEntry({ cwd: "/repo", path: "src/a.ts", name: "b.ts" });
    const renameRequest = await captureRequest(server, "fs.entry.rename.request");
    expect(renameRequest.name).toBe("b.ts");
    respond(server, renameRequest, "fs.entry.rename.response", {
      cwd: "/repo",
      path: "src/a.ts",
      renamedPath: "src/b.ts",
      success: true,
      error: null,
    });
    expect((await renamePending).renamedPath).toBe("src/b.ts");

    const deletePending = conn.deleteFsEntry({ cwd: "/repo", path: "src/b.ts" });
    const deleteRequest = await captureRequest(server, "fs.entry.delete.request");
    respond(server, deleteRequest, "fs.entry.delete.response", {
      cwd: "/repo",
      path: "src/b.ts",
      success: true,
      error: null,
    });
    expect((await deletePending).success).toBe(true);
    conn.close();
  });

  it("subscribeFile → fs.file.update 推送经 onFileUpdate", async () => {
    const events: string[] = [];
    const { conn, server } = await connectedHarness({
      onFileUpdate: (push) => events.push(`${push.subscriptionId}:${push.version.status}`),
    });
    const pending = conn.subscribeFile({ cwd: "/repo", path: "README.md" });
    const request = await captureRequest(server, "fs.file.subscribe.request");
    respond(server, request, "fs.file.subscribe.response", {
      subscriptionId: "fsub-1",
      initial: {
        status: "ready",
        cwd: "/repo",
        path: "README.md",
        size: 10,
        modifiedAt: "2026-10-01T00:00:00Z",
      },
    });
    const sub = await pending;
    expect(sub.subscriptionId).toBe("fsub-1");

    server.pushSession({
      type: "fs.file.update",
      payload: {
        subscriptionId: "fsub-1",
        version: {
          status: "ready",
          cwd: "/repo",
          path: "README.md",
          size: 12,
          modifiedAt: "2026-10-04T00:00:00Z",
        },
      },
    });
    await waitUntil(() => events.length > 0);
    expect(events[0]).toBe("fsub-1:ready");

    void conn.unsubscribeFile("fsub-1").catch(() => {}); // 响应未 mock，fire-and-forget
    await captureRequest(server, "fs.file.unsubscribe.request");
    conn.close();
  });
});

describe("t19 diff（checkout.commits）", () => {
  it("listCommits + getCommitFileDiff", async () => {
    const { conn, server } = await connectedHarness();
    const listPending = conn.listCommits("/repo");
    const listRequest = await captureRequest(server, "checkout.commits.list.request");
    expect(listRequest.cwd).toBe("/repo");
    respond(server, listRequest, "checkout.commits.list.response", {
      cwd: "/repo",
      baseRef: "main",
      commits: [
        {
          sha: "abc123",
          shortSha: "abc123",
          subject: "s",
          authorName: "a",
          authorDate: "2026-10-01T00:00:00Z",
          isOnRemote: true,
          files: [{ path: "x.ts", additions: 1, deletions: 2 }],
        },
      ],
      error: null,
    });
    const { commits } = await listPending;
    expect(commits[0].files[0].additions).toBe(1);

    const diffPending = conn.getCommitFileDiff({ cwd: "/repo", sha: "abc123", path: "x.ts" });
    const diffRequest = await captureRequest(server, "checkout.commits.file_diff.request");
    expect(diffRequest.sha).toBe("abc123");
    respond(server, diffRequest, "checkout.commits.file_diff.response", {
      cwd: "/repo",
      sha: "abc123",
      path: "x.ts",
      file: {
        path: "x.ts",
        isNew: false,
        isDeleted: false,
        additions: 1,
        deletions: 2,
        hunks: [
          {
            oldStart: 1,
            oldCount: 1,
            newStart: 1,
            newCount: 1,
            lines: [{ type: "add", content: "+" }],
          },
        ],
      },
      error: null,
    });
    const file = await diffPending;
    expect(file?.hunks[0].lines[0].type).toBe("add");
    conn.close();
  });
});

describe("t19 终端流", () => {
  it("subscribeTerminal：请求带 visible-snapshot 回放；slot 分配后 Output 帧路由到回调", async () => {
    const frames: string[] = [];
    const { conn, server } = await connectedHarness();
    const pending = conn.subscribeTerminal(
      "term-1",
      (frame) => frames.push(new TextDecoder().decode(frame.payload)),
      { scrollbackLines: 200 },
    );
    const request = await captureRequest(server, "subscribe_terminal_request");
    expect(request.terminalId).toBe("term-1");
    expect(request.restore).toEqual({ mode: "visible-snapshot", scrollbackLines: 200 });
    respond(server, request, "subscribe_terminal_response", {
      terminalId: "term-1",
      slot: 5,
      subscriptionId: "tsub-1",
      error: null,
    });
    const handle = await pending;
    expect(handle.slot).toBe(5);
    expect(handle.subscriptionId).toBe("tsub-1");

    // Restore 回放 + Output 增量（slot=5）
    server.pushBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Restore,
        slot: 5,
        payload: new TextEncoder().encode("$ echo hi\n"),
      }),
    );
    server.pushBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        slot: 5,
        payload: new TextEncoder().encode("hi\n"),
      }),
    );
    // 其他 slot 的帧不路由
    server.pushBinary(
      encodeTerminalStreamFrame({
        opcode: TerminalStreamOpcode.Output,
        slot: 9,
        payload: new TextEncoder().encode("noise"),
      }),
    );
    await waitUntil(() => frames.length >= 2);
    expect(frames).toEqual(["$ echo hi\n", "hi\n"]);

    // 输入走 terminal_input（fire-and-forget JSON，非 requestId RPC）
    conn.sendTerminalInput("term-1", { type: "input", data: "ls\n" });
    await waitUntil(() => server.sentFrames.some((frame) => frame.includes('"terminal_input"')));
    const inputFrame = server.sentFrames.find((frame) => frame.includes('"terminal_input"'));
    const parsed = JSON.parse(inputFrame as string);
    expect(parsed.message).toEqual({
      type: "terminal_input",
      terminalId: "term-1",
      message: { type: "input", data: "ls\n" },
    });

    // detach → unsubscribe 请求
    handle.detach();
    await captureRequest(server, "unsubscribe_terminal_request");
    conn.close();
  });

  it("terminal_stream_exit 推送经 onTerminalExit", async () => {
    const exits: Array<{ terminalId: string; error?: string }> = [];
    const { conn, server } = await connectedHarness({
      onTerminalExit: (payload) => exits.push(payload),
    });
    server.pushSession({
      type: "terminal_stream_exit",
      payload: { terminalId: "term-9", error: "process gone" },
    });
    await waitUntil(() => exits.length > 0);
    expect(exits[0]).toEqual({ terminalId: "term-9", error: "process gone" });
    conn.close();
  });

  it("createTerminal：terminal/error payload 解析", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.createTerminal({ cwd: "/repo", workspaceId: "ws-1", name: "t19" });
    const request = await captureRequest(server, "create_terminal_request");
    expect(request.workspaceId).toBe("ws-1");
    expect(request.name).toBe("t19");
    respond(server, request, "create_terminal_response", {
      terminal: { id: "term-77", name: "t19", cwd: "/repo" },
      error: null,
    });
    const terminal = await pending;
    expect(terminal.id).toBe("term-77");
    conn.close();
  });
});

describe("t19 subagents 与斜杠命令", () => {
  it("listSubagents + agent.provider_subagents.update 推送", async () => {
    const updates: string[] = [];
    const { conn, server } = await connectedHarness({
      onSubagentUpdate: (update) => updates.push(update.kind),
    });
    const pending = conn.listSubagents("agent-1");
    const request = await captureRequest(server, "agent.provider_subagents.list.request");
    expect(request.parentAgentId).toBe("agent-1");
    respond(server, request, "agent.provider_subagents.list.response", {
      parentAgentId: "agent-1",
      subagents: [
        {
          id: "sub-1",
          parentAgentId: "agent-1",
          provider: "zcode",
          title: "搜索子代理",
          description: null,
          status: "running",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:01:00Z",
          subtitle: "正在检索",
        },
      ],
      error: null,
    });
    const subagents = await pending;
    expect(subagents[0].status).toBe("running");
    expect(subagents[0].subtitle).toBe("正在检索");

    server.pushSession({
      type: "agent.provider_subagents.update",
      payload: {
        kind: "upsert",
        subagent: {
          id: "sub-1",
          parentAgentId: "agent-1",
          provider: "zcode",
          title: "搜索子代理",
          description: null,
          status: "completed",
          createdAt: "2026-10-01T00:00:00Z",
          updatedAt: "2026-10-01T00:02:00Z",
        },
      },
    });
    server.pushSession({
      type: "agent.provider_subagents.update",
      payload: { kind: "remove", parentAgentId: "agent-1", subagentId: "sub-1" },
    });
    await waitUntil(() => updates.length >= 2);
    expect(updates).toEqual(["upsert", "remove"]);
    conn.close();
  });

  it("listCommands", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.listCommands("agent-1");
    const request = await captureRequest(server, "list_commands_request");
    expect(request.agentId).toBe("agent-1");
    respond(server, request, "list_commands_response", {
      agentId: "agent-1",
      commands: [
        { name: "init", description: "初始化", argumentHint: "", kind: "command" },
        { name: "review", description: "审查", argumentHint: "[file]", kind: "skill" },
      ],
      error: null,
    });
    const commands = await pending;
    expect(commands).toHaveLength(2);
    expect(commands[1].kind).toBe("skill");
    conn.close();
  });
});

describe("t19 发送行为与 worktree 创建", () => {
  it("sendAgentMessage 带 activeTurnBehavior=interrupt", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.sendAgentMessage("agent-1", "stop this", {
      activeTurnBehavior: "interrupt",
    });
    const request = await captureRequest(server, "send_agent_message_request");
    expect(request.activeTurnBehavior).toBe("interrupt");
    respond(server, request, "send_agent_message_response", {
      agentId: "agent-1",
      accepted: true,
      error: null,
    });
    expect((await pending).accepted).toBe(true);
    conn.close();
  });

  it("createAgent 带 worktree（branch-off）", async () => {
    const { conn, server } = await connectedHarness();
    const pending = conn.createAgent({
      provider: "zcode",
      cwd: "/repo",
      worktree: { mode: "branch-off", newBranch: "t19-branch" },
    });
    const request = await captureRequest(server, "create_agent_request");
    expect(request.worktree).toEqual({ mode: "branch-off", newBranch: "t19-branch" });
    respond(server, request, "status", {
      status: "agent_created",
      agent: { id: "agent-9", provider: "zcode", status: "idle", cwd: "/repo/wt-t19-branch" },
    });
    const agent = await pending;
    expect(agent.id).toBe("agent-9");
    conn.close();
  });
});
