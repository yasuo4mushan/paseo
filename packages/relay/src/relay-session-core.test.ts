import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_RELAY_VERSION,
  RelaySessionCore,
  type RelayCoreSocket,
  type RelaySocketRegistry,
} from "./relay-session-core.js";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

type MockSocket = RelayCoreSocket & {
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

function createMockSocket(attachment: unknown = null): MockSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    __attachment: attachment,
  } as unknown as MockSocket;
}

/** Minimal in-memory registry mirroring the Node adapter's implementation. */
function createRegistry() {
  const socketsByTag = new Map<string, RelayCoreSocket[]>();
  const attachments = new Map<RelayCoreSocket, unknown>();
  const registry: RelaySocketRegistry = {
    register(socket, attachment, tags) {
      attachments.set(socket, attachment);
      for (const tag of tags) {
        const existing = socketsByTag.get(tag) ?? [];
        existing.push(socket);
        socketsByTag.set(tag, existing);
      }
    },
    byTag(tag) {
      return [...(socketsByTag.get(tag) ?? [])];
    },
    attachmentOf(socket) {
      return attachments.get(socket) ?? null;
    },
  };
  function removeSocket(socket: RelayCoreSocket): void {
    for (const [tag, sockets] of socketsByTag) {
      socketsByTag.set(
        tag,
        sockets.filter((entry) => entry !== socket),
      );
    }
  }
  return { registry, removeSocket };
}

function clientAttachment(connectionId: string): RelaySessionAttachment {
  return {
    serverId: "srv_test",
    role: "client" satisfies ConnectionRole,
    version: CURRENT_RELAY_VERSION,
    connectionId,
    createdAt: Date.now(),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("RelaySessionCore pendingFrames", () => {
  it("buffers at most 200 frames per connectionId, dropping the oldest", () => {
    const { registry } = createRegistry();
    const core = new RelaySessionCore(registry);
    const connectionId = "clt_cap";
    const client = createMockSocket(clientAttachment(connectionId));
    registry.register(client, clientAttachment(connectionId), ["client", `client:${connectionId}`]);

    for (let index = 0; index < 205; index += 1) {
      core.webSocketMessage(client, `frame-${index}`);
    }

    const data = createMockSocket();
    core.acceptV2Connection(data, { role: "server", serverId: "srv_test", connectionId });

    const sends = data.send.mock.calls.map((call) => call[0]);
    expect(sends).toHaveLength(200);
    expect(sends[0]).toBe("frame-5");
    expect(sends[199]).toBe("frame-204");
  });

  it("re-buffers remaining frames when a flush send fails", () => {
    const { registry } = createRegistry();
    const core = new RelaySessionCore(registry);
    const connectionId = "clt_flush_fail";
    const client = createMockSocket(clientAttachment(connectionId));
    registry.register(client, clientAttachment(connectionId), ["client", `client:${connectionId}`]);

    core.webSocketMessage(client, "frame-a");
    core.webSocketMessage(client, "frame-b");
    core.webSocketMessage(client, "frame-c");

    const failing = createMockSocket();
    failing.send.mockImplementationOnce(() => {
      throw new Error("socket closed mid-flush");
    });
    core.acceptV2Connection(failing, { role: "server", serverId: "srv_test", connectionId });

    expect(failing.send).toHaveBeenCalledTimes(1);
    expect(failing.send).toHaveBeenCalledWith("frame-a");

    // Only the frame that failed to send is re-buffered; frames after it in
    // the same flush are dropped (matches the Durable Object behavior).
    const retry = createMockSocket();
    core.acceptV2Connection(retry, { role: "server", serverId: "srv_test", connectionId });
    const sends = retry.send.mock.calls.map((call) => call[0]);
    expect(sends).toEqual(["frame-a"]);
  });
});

describe("RelaySessionCore control nudge", () => {
  it("sends a sync after 10s and force-closes control after 5 more seconds", () => {
    vi.useFakeTimers();
    const { registry } = createRegistry();
    const core = new RelaySessionCore(registry);
    const connectionId = "clt_nudge";
    const control = createMockSocket();
    const client = createMockSocket(clientAttachment(connectionId));

    registry.register(control, {}, ["server-control"]);
    registry.register(client, clientAttachment(connectionId), ["client", `client:${connectionId}`]);

    core.nudgeOrResetControlForConnection(connectionId);

    vi.advanceTimersByTime(10_000);
    expect(control.send).toHaveBeenCalledTimes(1);
    const nudge = JSON.parse(control.send.mock.calls[0]?.[0] as string);
    expect(nudge).toEqual({ type: "sync", connectionIds: [connectionId] });

    vi.advanceTimersByTime(5_000);
    expect(control.close).toHaveBeenCalledWith(1011, "Control unresponsive");
  });

  it("skips the nudge when the daemon opened the data socket in time", () => {
    vi.useFakeTimers();
    const { registry } = createRegistry();
    const core = new RelaySessionCore(registry);
    const connectionId = "clt_fast_daemon";
    const control = createMockSocket();
    const client = createMockSocket(clientAttachment(connectionId));

    registry.register(control, {}, ["server-control"]);
    registry.register(client, clientAttachment(connectionId), ["client", `client:${connectionId}`]);

    core.nudgeOrResetControlForConnection(connectionId);

    const data = createMockSocket();
    core.acceptV2Connection(data, { role: "server", serverId: "srv_test", connectionId });

    vi.advanceTimersByTime(15_000);
    expect(control.send).not.toHaveBeenCalled();
    expect(control.close).not.toHaveBeenCalled();
  });
});

describe("RelaySessionCore legacy JSON ping", () => {
  it("replies with a JSON pong and keeps the historical log line", () => {
    const { registry } = createRegistry();
    const core = new RelaySessionCore(registry);
    const control = createMockSocket();
    registry.register(control, { role: "server", version: "2", connectionId: null }, [
      "server-control",
    ]);

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    core.webSocketMessage(control, JSON.stringify({ type: "ping" }));

    expect(logSpy).toHaveBeenCalledWith("[Relay DO] legacy_json_ping_received");
    const reply = JSON.parse(control.send.mock.calls[0]?.[0] as string);
    expect(reply.type).toBe("pong");
    expect(typeof reply.ts).toBe("number");
  });
});
