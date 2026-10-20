import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import { Buffer } from "node:buffer";
import { WebSocket } from "ws";
import { createNodeRelayServer, type NodeRelayServerHandle } from "./node-server.js";
import { createClientChannel, createDaemonChannel, type Transport } from "./encrypted-channel.js";
import type { TransportMessage } from "./encrypted-channel.js";
import { exportPublicKey, generateKeyPair } from "./crypto.js";

let relay: NodeRelayServerHandle;
let relayPort: number;

function uniqueServerId(): string {
  return `srv_${crypto.randomUUID()}`;
}

function uniqueConnectionId(): string {
  return `clt_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

interface WsTarget {
  serverId: string;
  role: "server" | "client";
  v?: "1" | "2";
  connectionId?: string;
}

function wsUrl(params: WsTarget): string {
  return wsUrlOn(relayPort, params);
}

function wsUrlOn(port: number, params: WsTarget): string {
  const url = new URL(`ws://127.0.0.1:${port}/ws`);
  url.searchParams.set("serverId", params.serverId);
  url.searchParams.set("role", params.role);
  url.searchParams.set("v", params.v ?? "2");
  if (params.connectionId) {
    url.searchParams.set("connectionId", params.connectionId);
  }
  return url.toString();
}

interface ReceivedMessage {
  data: Buffer;
  isBinary: boolean;
}

/**
 * Opens a socket with the message/close listeners attached before the open
 * event fires. The relay sends the control sync frame during the upgrade, so
 * listeners attached after `open` can miss it (the real daemon also wires
 * listeners pre-open).
 */
function connectSocket(
  url: string,
  timeoutMs = 5000,
): Promise<{ ws: WebSocket; nextMessage: (timeoutMs?: number) => Promise<ReceivedMessage> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const queued: ReceivedMessage[] = [];
    const waiters: Array<{ resolve: (m: ReceivedMessage) => void; timer: NodeJS.Timeout }> = [];

    ws.on("message", (data, isBinary) => {
      const message: ReceivedMessage = {
        data: Array.isArray(data) ? Buffer.concat(data) : (data as Buffer),
        isBinary,
      };
      const waiter = waiters.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      queued.push(message);
    });

    const nextMessage = (waitTimeoutMs = 5000): Promise<ReceivedMessage> =>
      new Promise((resolveMessage, rejectMessage) => {
        const buffered = queued.shift();
        if (buffered) {
          resolveMessage(buffered);
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((entry) => entry.timer === timer);
          if (index >= 0) waiters.splice(index, 1);
          rejectMessage(new Error("Timed out waiting for message"));
        }, waitTimeoutMs);
        waiters.push({ resolve: resolveMessage, timer });
      });

    const openTimer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`Timed out opening ${url}`));
    }, timeoutMs);
    ws.once("open", () => {
      clearTimeout(openTimer);
      resolve({ ws, nextMessage });
    });
    ws.once("error", (error) => {
      clearTimeout(openTimer);
      reject(error);
    });
  });
}

interface CloseEvent {
  code: number;
  reason: string;
}

function nextClose(ws: WebSocket, timeoutMs = 5000): Promise<CloseEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for close")), timeoutMs);
    ws.once("close", (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString("utf8") });
    });
  });
}

function closeQuietly(ws: WebSocket | null | undefined): void {
  if (!ws) return;
  try {
    ws.close();
  } catch {
    // ignore
  }
}

/** Reads control-channel JSON notifications. */
async function readJson(
  nextMessage: (timeoutMs?: number) => Promise<ReceivedMessage>,
  timeoutMs?: number,
): Promise<Record<string, unknown>> {
  const message = await nextMessage(timeoutMs);
  return JSON.parse(message.data.toString("utf8")) as Record<string, unknown>;
}

function rawRequest(
  port: number,
  path: string,
  upgrade: boolean,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = net.connect(port, "127.0.0.1", () => {
      const headers = upgrade
        ? "Upgrade: websocket\r\nConnection: Upgrade\r\n"
        : "Connection: close\r\n";
      request.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\n${headers}\r\n`);
    });
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("error", () => {
      // Post-shutdown probes fail to connect entirely; report status 0.
      resolve({ status: 0, body: "" });
    });
    request.on("close", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      const status = Number.parseInt(raw.split(" ")[1] ?? "0", 10);
      const bodyStart = raw.indexOf("\r\n\r\n");
      resolve({ status, body: bodyStart >= 0 ? raw.slice(bodyStart + 4) : "" });
    });
    // Safety net so a hung request cannot stall the suite.
    setTimeout(() => {
      request.destroy();
      reject(new Error("raw request timed out"));
    }, 5000).unref?.();
  });
}

beforeAll(async () => {
  relay = await createNodeRelayServer({ host: "127.0.0.1", port: 0 });
  relayPort = relay.port;
});

afterAll(async () => {
  await relay.close();
});

describe("node relay HTTP surface", () => {
  it("serves /health with status ok", async () => {
    const response = await fetch(`http://127.0.0.1:${relayPort}/health`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });

  it("returns 404 for unknown paths on plain requests", async () => {
    const response = await rawRequest(relayPort, "/nope", false);
    expect(response.status).toBe(404);
    expect(response.body).toBe("Not found");
  });

  it("returns 404 for unknown paths on upgrade requests", async () => {
    const response = await rawRequest(relayPort, "/nope", true);
    expect(response.status).toBe(404);
    expect(response.body).toBe("Not found");
  });

  it("rejects /ws without serverId", async () => {
    const response = await rawRequest(relayPort, "/ws?role=server&v=2", false);
    expect(response.status).toBe(400);
    expect(response.body).toBe("Missing serverId parameter");
  });

  it("rejects /ws with invalid v", async () => {
    const response = await rawRequest(relayPort, "/ws?serverId=srv_x&role=server&v=nope", false);
    expect(response.status).toBe(400);
    expect(response.body).toBe("Invalid v parameter (expected 1 or 2)");
  });

  it("rejects /ws without role", async () => {
    const response = await rawRequest(relayPort, "/ws?serverId=srv_x&v=2", false);
    expect(response.status).toBe(400);
    expect(response.body).toBe("Missing or invalid role parameter");
  });

  it("rejects upgrade /ws requests with missing parameters", async () => {
    const response = await rawRequest(relayPort, "/ws?v=2&role=server", true);
    expect(response.status).toBe(400);
    expect(response.body).toBe("Missing serverId parameter");
  });

  it("rejects upgrade /ws requests with an invalid version", async () => {
    const response = await rawRequest(relayPort, "/ws?serverId=srv_x&role=server&v=3", true);
    expect(response.status).toBe(400);
    expect(response.body).toBe("Invalid v parameter (expected 1 or 2)");
  });

  it("rejects valid /ws params without a WebSocket upgrade", async () => {
    const response = await rawRequest(relayPort, "/ws?serverId=srv_x&role=server&v=2", false);
    expect(response.status).toBe(426);
    expect(response.body).toBe("Expected WebSocket upgrade");
  });
});

describe("node relay v1 forwarding", () => {
  it("relays frames between v1 server and client sockets in both directions", async () => {
    const serverId = uniqueServerId();
    const server = await connectSocket(wsUrl({ serverId, role: "server", v: "1" }));
    const client = await connectSocket(wsUrl({ serverId, role: "client", v: "1" }));

    client.ws.send("hello-from-client");
    expect((await server.nextMessage()).data.toString("utf8")).toBe("hello-from-client");

    server.ws.send("hello-from-server");
    expect((await client.nextMessage()).data.toString("utf8")).toBe("hello-from-server");

    client.ws.send(Buffer.from([1, 2, 3]));
    const binaryMessage = await server.nextMessage();
    expect(binaryMessage.isBinary).toBe(true);
    expect(binaryMessage.data).toEqual(Buffer.from([1, 2, 3]));

    closeQuietly(server.ws);
    closeQuietly(client.ws);
  });

  it("replaces an existing v1 server socket with close 1008", async () => {
    const serverId = uniqueServerId();
    const first = await connectSocket(wsUrl({ serverId, role: "server", v: "1" }));
    const closeEvent = nextClose(first.ws);

    const second = await connectSocket(wsUrl({ serverId, role: "server", v: "1" }));

    expect(await closeEvent).toEqual({ code: 1008, reason: "Replaced by new connection" });
    closeQuietly(second.ws);
  });

  it("keeps v1 and v2 traffic isolated for the same serverId", async () => {
    const serverId = uniqueServerId();
    const v1Server = await connectSocket(wsUrl({ serverId, role: "server", v: "1" }));
    const v2Control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(v2Control.nextMessage); // drain sync

    const v1Client = await connectSocket(wsUrl({ serverId, role: "client", v: "1" }));
    v1Client.ws.send("v1-only");

    await expect(v2Control.nextMessage(300)).rejects.toThrow("Timed out");
    expect((await v1Server.nextMessage()).data.toString("utf8")).toBe("v1-only");

    closeQuietly(v1Client.ws);
    closeQuietly(v1Server.ws);
    closeQuietly(v2Control.ws);
  });
});

describe("node relay v2 sessions", () => {
  it("sends the current connection list to a newly connected control socket", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));

    const sync = await readJson(control.nextMessage);
    expect(sync.type).toBe("sync");
    expect(sync.connectionIds).toEqual([connectionId]);

    closeQuietly(control.ws);
    closeQuietly(client.ws);
  });

  it("notifies the control socket when a client connects and forwards frames via the data socket", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();

    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    const connected = await readJson(control.nextMessage);
    expect(connected).toEqual({ type: "connected", connectionId });

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));

    client.ws.send("client-frame");
    expect((await data.nextMessage()).data.toString("utf8")).toBe("client-frame");

    data.ws.send(Buffer.from([9, 9]));
    const binaryMessage = await client.nextMessage();
    expect(binaryMessage.isBinary).toBe(true);
    expect(binaryMessage.data).toEqual(Buffer.from([9, 9]));

    closeQuietly(data.ws);
    closeQuietly(control.ws);
    closeQuietly(client.ws);
  });

  it("assigns a connectionId when a v2 client connects without one", async () => {
    const serverId = uniqueServerId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    await connectSocket(wsUrl({ serverId, role: "client" }));
    const connected = await readJson(control.nextMessage);
    expect(String(connected.connectionId)).toMatch(/^conn_/);

    closeQuietly(control.ws);
  });

  it("buffers client frames until the daemon data socket connects, then flushes in order", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();

    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected

    client.ws.send("early-1");
    client.ws.send("early-2");
    client.ws.send(Buffer.from([7, 7, 7]));

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));

    expect((await data.nextMessage()).data.toString("utf8")).toBe("early-1");
    expect((await data.nextMessage()).data.toString("utf8")).toBe("early-2");
    const binaryMessage = await data.nextMessage();
    expect(binaryMessage.isBinary).toBe(true);
    expect(binaryMessage.data).toEqual(Buffer.from([7, 7, 7]));

    closeQuietly(data.ws);
    closeQuietly(control.ws);
    closeQuietly(client.ws);
  });

  it("replaces an existing control socket with close 1008", async () => {
    const serverId = uniqueServerId();
    const first = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(first.nextMessage); // drain sync
    const closeEvent = nextClose(first.ws);

    const second = await connectSocket(wsUrl({ serverId, role: "server" }));

    expect(await closeEvent).toEqual({ code: 1008, reason: "Replaced by new connection" });
    closeQuietly(second.ws);
  });

  it("replaces an existing server data socket for the same connectionId with close 1008", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected

    const first = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));
    const closeEvent = nextClose(first.ws);

    const second = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));

    expect(await closeEvent).toEqual({ code: 1008, reason: "Replaced by new connection" });
    closeQuietly(second.ws);
    closeQuietly(control.ws);
    closeQuietly(client.ws);
  });

  it("closes the data socket and notifies control when the last client socket disconnects", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));
    const dataClose = nextClose(data.ws);
    const disconnected = readJson(control.nextMessage);

    client.ws.close();

    expect(await dataClose).toEqual({ code: 1001, reason: "Client disconnected" });
    expect(await disconnected).toEqual({ type: "disconnected", connectionId });

    closeQuietly(control.ws);
    closeQuietly(data.ws);
  });

  it("keeps the data socket while another client socket for the connection remains", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const clientA = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected
    const clientB = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));
    const dataClose = nextClose(data.ws, 1500);

    clientA.ws.close();
    await expect(dataClose).rejects.toThrow("Timed out");

    // The remaining client still receives frames.
    data.ws.send("still-alive");
    expect((await clientB.nextMessage()).data.toString("utf8")).toBe("still-alive");

    closeQuietly(data.ws);
    closeQuietly(control.ws);
    closeQuietly(clientB.ws);
  });

  it("closes client sockets with 1012 when the daemon data socket drops", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));
    const clientClose = nextClose(client.ws);

    data.ws.close();

    expect(await clientClose).toEqual({ code: 1012, reason: "Server disconnected" });

    closeQuietly(control.ws);
    closeQuietly(data.ws);
  });

  it("answers legacy JSON keepalive pings on the control socket", async () => {
    const serverId = uniqueServerId();
    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    control.ws.send(JSON.stringify({ type: "ping" }));
    const pong = await readJson(control.nextMessage);
    expect(pong.type).toBe("pong");
    expect(typeof pong.ts).toBe("number");

    // Non-JSON and non-ping control payloads are ignored without closing.
    control.ws.send("not-json");
    control.ws.send(JSON.stringify({ type: "something-else" }));
    await expect(control.nextMessage(300)).rejects.toThrow("Timed out");

    closeQuietly(control.ws);
  });
});

describe("node relay E2EE channels", () => {
  function toArrayBuffer(buffer: Buffer): ArrayBuffer {
    return buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength,
    ) as ArrayBuffer;
  }

  function wsTransport(ws: WebSocket): Transport {
    const transport: Transport = {
      send: (data) => {
        ws.send(data);
      },
      close: (code, reason) => ws.close(code, reason),
      onmessage: null,
      onclose: null,
      onerror: null,
    };
    ws.on("message", (data, isBinary) => {
      const message: TransportMessage = isBinary
        ? {
            data: toArrayBuffer(Array.isArray(data) ? Buffer.concat(data) : (data as Buffer)),
            isBinary: true,
          }
        : { data: data.toString("utf8"), isBinary: false };
      transport.onmessage?.(message);
    });
    ws.on("close", (code, reason) => transport.onclose?.(code, reason.toString("utf8")));
    ws.on("error", (error) =>
      transport.onerror?.(error instanceof Error ? error : new Error(String(error))),
    );
    return transport;
  }

  async function waitForCondition(
    predicate: () => boolean,
    timeoutMs = 5000,
    intervalMs = 25,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error("Timed out waiting for condition");
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  it("runs a full daemon/client encrypted handshake and exchange through the relay", async () => {
    const serverId = uniqueServerId();
    const connectionId = uniqueConnectionId();
    const daemonKeyPair = generateKeyPair();
    const daemonPublicKeyB64 = exportPublicKey(daemonKeyPair.publicKey);

    const control = await connectSocket(wsUrl({ serverId, role: "server" }));
    await readJson(control.nextMessage); // drain sync

    const client = await connectSocket(wsUrl({ serverId, role: "client", connectionId }));
    await readJson(control.nextMessage); // drain connected

    const data = await connectSocket(wsUrl({ serverId, role: "server", connectionId }));

    const daemonTransport = wsTransport(data.ws);
    const clientTransport = wsTransport(client.ws);

    const daemonReceived: Array<string | ArrayBuffer> = [];
    const clientReceived: Array<string | ArrayBuffer> = [];

    const daemonChannelPromise = createDaemonChannel(daemonTransport, daemonKeyPair, {
      onmessage: (message) => daemonReceived.push(message),
    });
    const clientChannel = await createClientChannel(clientTransport, daemonPublicKeyB64, {
      onmessage: (message) => clientReceived.push(message),
    });
    const daemonChannel = await daemonChannelPromise;

    await clientChannel.send("secret-to-daemon");
    await waitForCondition(() => daemonReceived.includes("secret-to-daemon"));
    expect(clientReceived).toEqual([]);

    await daemonChannel.send("secret-to-client");
    await waitForCondition(() => clientReceived.includes("secret-to-client"));

    clientChannel.close();
    daemonChannel.close();
    closeQuietly(control.ws);
  });
});

describe("node relay shutdown", () => {
  it("stops listening after close()", async () => {
    const handle = await createNodeRelayServer({ host: "127.0.0.1", port: 0 });
    const socket = await connectSocket(
      wsUrlOn(handle.port, { serverId: uniqueServerId(), role: "server", v: "1" }),
    );

    // Attach before close(): the close event can fire while close() awaits.
    const closed = nextClose(socket.ws, 5000);
    await handle.close();
    expect((await closed).code).toBe(1001);

    const probe = await rawRequest(handle.port, "/health", false);
    expect(probe.status).toBe(0);
  });
});
