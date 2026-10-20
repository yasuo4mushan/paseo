/**
 * Self-hostable pure Node relay server.
 *
 * Implements the same wire protocol as the Cloudflare Worker
 * (cloudflare-adapter.ts) so a daemon/client pair cannot tell the two apart:
 * same /health and /ws routes, same query-parameter validation, same pairing
 * and buffering semantics via the shared RelaySessionCore. This is the
 * self-hosting path for networks where the hosted Cloudflare relay has no
 * nearby edge — see docs/server-domestication.md §4.2 route B.
 *
 * Like the Worker, this server performs no authentication: serverId is a
 * public routing id, pairing secrets travel in the URI/encrypted channel, and
 * the relay only ever sees ciphertext (SECURITY.md).
 *
 * Run: `node dist/node-server.js`
 * Env: PORT (default 6790), HOST (default 0.0.0.0)
 * TLS is expected to be terminated in front (nginx/caddy) for wss://.
 */

import http from "node:http";
import { realpathSync } from "node:fs";
import type { Duplex } from "node:stream";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  MAX_RELAY_FRAME_BYTES,
  RelaySessionCore,
  resolveRelayVersion,
  type RelayCoreSocket,
  type RelayFrame,
  type RelayProtocolVersion,
  type RelaySocketRegistry,
} from "./relay-session-core.js";
import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

const DEFAULT_PORT = 6790;
const DEFAULT_HOST = "0.0.0.0";

/**
 * In-memory tag/attachment registry backing one session core. Mirrors what the
 * Durable Object hibernation state provides on Cloudflare.
 */
class NodeSocketRegistry implements RelaySocketRegistry {
  private socketsByTag = new Map<string, Set<RelayCoreSocket>>();
  private attachments = new WeakMap<RelayCoreSocket, RelaySessionAttachment>();
  private allSockets = new Set<RelayCoreSocket>();

  register(socket: RelayCoreSocket, attachment: RelaySessionAttachment, tags: string[]): void {
    this.allSockets.add(socket);
    this.attachments.set(socket, attachment);
    for (const tag of tags) {
      let tagged = this.socketsByTag.get(tag);
      if (!tagged) {
        tagged = new Set();
        this.socketsByTag.set(tag, tagged);
      }
      tagged.add(socket);
    }
  }

  byTag(tag: string): RelayCoreSocket[] {
    const tagged = this.socketsByTag.get(tag);
    if (!tagged) return [];
    return Array.from(tagged);
  }

  attachmentOf(socket: RelayCoreSocket): unknown {
    return this.attachments.get(socket) ?? null;
  }

  remove(socket: RelayCoreSocket): void {
    this.allSockets.delete(socket);
    for (const tagged of this.socketsByTag.values()) {
      tagged.delete(socket);
    }
  }

  get size(): number {
    return this.allSockets.size;
  }
}

interface RelaySession {
  registry: NodeSocketRegistry;
  core: RelaySessionCore;
}

export interface NodeRelayServerOptions {
  host?: string;
  port?: number;
}

export interface NodeRelayServerHandle {
  server: http.Server;
  wss: WebSocketServer;
  host: string;
  port: number;
  /** Closes all sockets and stops listening. Resolves once shut down. */
  close(): Promise<void>;
}

function normalizeBinaryFrame(data: WebSocket.RawData): RelayFrame {
  if (Array.isArray(data)) {
    return Buffer.concat(data);
  }
  return data;
}

function respondAndDestroy(socket: Duplex, status: number, body: string): void {
  const statusText = http.STATUS_CODES[status] ?? "";
  socket.write(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Content-Type: text/plain\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      body,
  );
  socket.destroy();
}

/**
 * Validates /ws parameters against the worker + Durable Object contract.
 * Returns an error message when the request must be rejected, null otherwise.
 */
function validateWsParams(url: URL): string | null {
  // Worker-level checks (cloudflare-adapter.ts worker fetch).
  const serverId = url.searchParams.get("serverId");
  if (!serverId) {
    return "Missing serverId parameter";
  }
  if (!resolveRelayVersion(url.searchParams.get("v"))) {
    return "Invalid v parameter (expected 1 or 2)";
  }
  // Durable Object-level checks.
  const roleRaw = url.searchParams.get("role");
  if (roleRaw !== "server" && roleRaw !== "client") {
    return "Missing or invalid role parameter";
  }
  return null;
}

/**
 * Creates and starts a Node relay server. `port: 0` binds an ephemeral port;
 * the resolved port is available on the returned handle.
 */
export function createNodeRelayServer(
  options: NodeRelayServerOptions = {},
): Promise<NodeRelayServerHandle> {
  const host = options.host ?? DEFAULT_HOST;

  // One session core per (version, serverId), matching the worker's
  // idFromName(`relay-v{version}:{serverId}`) Durable Object isolation.
  const sessions = new Map<string, RelaySession>();

  const sessionFor = (version: RelayProtocolVersion, serverId: string): RelaySession => {
    const key = `relay-v${version}:${serverId}`;
    let session = sessions.get(key);
    if (!session) {
      const registry = new NodeSocketRegistry();
      session = {
        registry,
        core: new RelaySessionCore(registry, { logPrefix: "[Relay]" }),
      };
      sessions.set(key, session);
    }
    return session;
  };

  const dropIfEmpty = (version: RelayProtocolVersion, serverId: string): void => {
    const key = `relay-v${version}:${serverId}`;
    const session = sessions.get(key);
    if (session && session.registry.size === 0) {
      sessions.delete(key);
    }
  };

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_RELAY_FRAME_BYTES,
  });

  const server = http.createServer((request, response) => {
    const respond = (status: number, body: string): void => {
      response.writeHead(status, {
        "Content-Type": "text/plain",
        "Content-Length": String(Buffer.byteLength(body)),
      });
      response.end(body);
    };

    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname === "/health") {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "Content-Length": String(Buffer.byteLength('{"status":"ok"}')),
      });
      response.end('{"status":"ok"}');
      return;
    }

    if (url.pathname === "/ws") {
      // Mirrors the Durable Object's requireWebSocketUpgrade: parameter
      // validation happens first, then the upgrade expectation.
      const validationError = validateWsParams(url);
      if (validationError) {
        respond(400, validationError);
        return;
      }
      respond(426, "Expected WebSocket upgrade");
      return;
    }

    respond(404, "Not found");
  });

  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url ?? "/", "http://localhost");

    if (url.pathname !== "/ws") {
      respondAndDestroy(socket, 404, "Not found");
      return;
    }

    const validationError = validateWsParams(url);
    if (validationError) {
      respondAndDestroy(socket, 400, validationError);
      return;
    }

    const serverId = url.searchParams.get("serverId");
    if (!serverId) {
      respondAndDestroy(socket, 400, "Missing serverId parameter");
      return;
    }
    const version = resolveRelayVersion(url.searchParams.get("v"));
    if (!version) {
      respondAndDestroy(socket, 400, "Invalid v parameter (expected 1 or 2)");
      return;
    }
    const roleRaw = url.searchParams.get("role");
    const role: ConnectionRole = roleRaw === "client" ? "client" : "server";
    const connectionIdRaw = url.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";

    const session = sessionFor(version, serverId);

    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => {
        const frame = isBinary ? normalizeBinaryFrame(data) : data.toString("utf8");
        session.core.webSocketMessage(ws, frame);
      });

      ws.on("close", (code, reason) => {
        // Durable Object semantics: the closing socket is already absent from
        // getWebSockets when webSocketClose fires. Remove before delegating.
        session.registry.remove(ws);
        session.core.webSocketClose(ws, code, reason.toString("utf8"));
        dropIfEmpty(version, serverId);
      });

      ws.on("error", (error) => {
        session.core.webSocketError(ws, error);
      });

      if (version === "1") {
        session.core.acceptV1Connection(ws, { role, serverId });
      } else {
        session.core.acceptV2Connection(ws, { role, serverId, connectionId });
      }
    });
  });

  return new Promise<NodeRelayServerHandle>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, host, () => {
      const address = server.address();
      const port =
        address && typeof address === "object" ? address.port : (options.port ?? DEFAULT_PORT);

      const close = async (): Promise<void> => {
        for (const client of wss.clients) {
          try {
            client.close(1001, "Relay shutting down");
          } catch {
            // ignore
          }
        }
        // Force-terminate stragglers that don't complete the close handshake.
        const grace = setTimeout(() => {
          for (const client of wss.clients) {
            client.terminate();
          }
        }, 1_000);
        grace.unref?.();
        await new Promise<void>((resolveClose) => {
          wss.close(() => resolveClose());
        });
        clearTimeout(grace);
        await new Promise<void>((resolveClose) => {
          server.close(() => resolveClose());
        });
        sessions.clear();
      };

      resolve({
        server,
        wss,
        host,
        port,
        close,
      });
    });
  });
}

function parsePortEnv(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const port = parsePortEnv(process.env.PORT) ?? DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;

  const handle = await createNodeRelayServer({ host, port });
  console.log(`[Relay] node relay listening on ${handle.host}:${handle.port}`);

  const shutdown = (signal: string) => {
    console.log(`[Relay] ${signal} received, shutting down`);
    handle
      .close()
      .catch((error) => {
        console.error("[Relay] shutdown error:", error);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

if (isMainModule()) {
  void main();
}
