/**
 * Cloudflare Durable Objects adapter for the relay.
 *
 * This module provides a Durable Object class that can be deployed to
 * Cloudflare Workers. It uses WebSocket hibernation for cost efficiency.
 *
 * Each session gets its own Durable Object instance, identified by session ID.
 *
 * Wrangler config:
 * ```jsonc
 * {
 *   "durable_objects": {
 *     "bindings": [{ "name": "RELAY", "class_name": "RelayDurableObject" }]
 *   },
 *   "migrations": [{ "tag": "v1", "new_classes": ["RelayDurableObject"] }]
 * }
 * ```
 *
 * Session/pairing semantics live in relay-session-core.ts; this adapter only
 * owns Cloudflare-specific plumbing (WebSocketPair, hibernation state,
 * attachments, responses).
 */

import { createCutoverProxy } from "./cutover-proxy.js";
import {
  RelaySessionCore,
  resolveRelayVersion,
  type RelayCoreSocket,
  type RelaySocketRegistry,
} from "./relay-session-core.js";
import type { ConnectionRole } from "./types.js";

interface WebSocketPair {
  0: WebSocket;
  1: WebSocket;
}

interface DurableObjectState {
  acceptWebSocket(ws: WebSocket, tags?: string[]): void;
  getWebSockets(tag?: string): WebSocket[];
}

interface WebSocketWithAttachment extends WebSocket {
  serializeAttachment(value: unknown): void;
  deserializeAttachment(): unknown;
}

function hasAttachmentMethods(ws: WebSocket): ws is WebSocketWithAttachment {
  // Type-safe check for attachment methods - required for Cloudflare WebSocket hibernation API
  // Use Reflect to check for methods without type assertions
  return (
    "serializeAttachment" in ws &&
    "deserializeAttachment" in ws &&
    typeof Reflect.get(ws, "serializeAttachment") === "function" &&
    typeof Reflect.get(ws, "deserializeAttachment") === "function"
  );
}

function deserializeAttachment(ws: WebSocket): unknown {
  if (!hasAttachmentMethods(ws)) return null;
  try {
    return ws.deserializeAttachment();
  } catch {
    return null;
  }
}

function serializeAttachment(ws: WebSocket, value: unknown): void {
  if (!hasAttachmentMethods(ws)) {
    throw new Error("WebSocket does not support attachments");
  }
  ws.serializeAttachment(value);
}

function getGlobalWebSocketPair(): (new () => WebSocketPair) | undefined {
  // Access WebSocketPair from global scope (Cloudflare Workers runtime)
  // Use Reflect to access global property without type assertions
  const WebSocketPair = Reflect.get(globalThis, "WebSocketPair") as unknown;
  if (typeof WebSocketPair === "function") {
    return WebSocketPair as new () => WebSocketPair;
  }
  return undefined;
}

interface Env {
  RELAY: DurableObjectNamespace;
  PASEO_RELAY_UPSTREAM?: string;
}

interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

interface DurableObjectId {
  toString(): string;
}

interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

/**
 * Bridges the Durable Object hibernation state API onto the transport-agnostic
 * socket registry the session core queries. `getWebSockets` remains the source
 * of truth so sockets survive isolate hibernation.
 */
function createDurableObjectRegistry(state: DurableObjectState): RelaySocketRegistry {
  return {
    register(socket, attachment, tags) {
      state.acceptWebSocket(socket as WebSocket, tags);
      serializeAttachment(socket as WebSocket, attachment);
    },
    byTag(tag) {
      return state.getWebSockets(tag) as RelayCoreSocket[];
    },
    attachmentOf(socket) {
      return deserializeAttachment(socket as WebSocket);
    },
  };
}

/**
 * Durable Object that handles WebSocket relay for a single session.
 *
 * v1 WebSockets connect in two shapes:
 * - role=server: daemon socket
 * - role=client: app/client socket
 *
 * v2 WebSockets connect in three shapes:
 * - role=server (no connectionId): daemon control socket (one per serverId)
 * - role=server&connectionId=...: daemon per-connection data socket (one per connectionId)
 * - role=client&connectionId=...: app/client socket (many per connectionId)
 */
interface CFResponseInit extends ResponseInit {
  webSocket?: WebSocket;
}

export class RelayDurableObject {
  private state: DurableObjectState;
  private core: RelaySessionCore;

  constructor(state: DurableObjectState) {
    this.state = state;
    this.core = new RelaySessionCore(createDurableObjectRegistry(state));
  }

  private createWebSocketPair(): [WebSocket, WebSocket] {
    const WebSocketPairCtor = getGlobalWebSocketPair();
    if (!WebSocketPairCtor) {
      throw new Error("WebSocketPair not available in global scope");
    }
    const pair: WebSocketPair = new WebSocketPairCtor();
    return [pair[0], pair[1]];
  }

  private requireWebSocketUpgrade(request: Request): Response | null {
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }
    return null;
  }

  private asSwitchingProtocolsResponse(client: WebSocket): Response {
    return new Response(null, {
      status: 101,
      webSocket: client,
    } as CFResponseInit);
  }

  /**
   * Public so the adapter tests can drive the nudge timeline directly; the
   * session core triggers it itself whenever a v2 client connects.
   */
  nudgeOrResetControlForConnection(connectionId: string): void {
    this.core.nudgeOrResetControlForConnection(connectionId);
  }

  private fetchV1(request: Request, role: ConnectionRole, serverId: string): Response {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    for (const ws of this.state.getWebSockets(role)) {
      ws.close(1008, "Replaced by new connection");
    }

    const [client, server] = this.createWebSocketPair();
    this.core.acceptV1Connection(server, { role, serverId });

    return this.asSwitchingProtocolsResponse(client);
  }

  private fetchV2(
    request: Request,
    role: ConnectionRole,
    serverId: string,
    connectionId: string,
  ): Response {
    const upgradeError = this.requireWebSocketUpgrade(request);
    if (upgradeError) return upgradeError;

    const [client, server] = this.createWebSocketPair();
    this.core.acceptV2Connection(server, { role, serverId, connectionId });

    return this.asSwitchingProtocolsResponse(client);
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const roleRaw = url.searchParams.get("role");
    const role = roleRaw === "server" || roleRaw === "client" ? roleRaw : null;
    const serverId = url.searchParams.get("serverId");
    const connectionIdRaw = url.searchParams.get("connectionId");
    const connectionId = typeof connectionIdRaw === "string" ? connectionIdRaw.trim() : "";
    const version = resolveRelayVersion(url.searchParams.get("v"));

    if (!role || (role !== "server" && role !== "client")) {
      return new Response("Missing or invalid role parameter", { status: 400 });
    }

    if (!serverId) {
      return new Response("Missing serverId parameter", { status: 400 });
    }

    if (!version) {
      return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
    }

    if (version === "1") {
      return this.fetchV1(request, role, serverId);
    }

    return this.fetchV2(request, role, serverId, connectionId);
  }

  /**
   * Called when a WebSocket message is received (wakes from hibernation).
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.core.webSocketMessage(ws, message);
  }

  /**
   * Called when a WebSocket closes (wakes from hibernation).
   */
  webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean): void {
    this.core.webSocketClose(ws, code, reason);
  }

  /**
   * Called on WebSocket error.
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    this.core.webSocketError(ws, error);
  }
}

/**
 * Worker entry point that routes requests to the appropriate Durable Object.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.PASEO_RELAY_UPSTREAM) {
      return createCutoverProxy(env.PASEO_RELAY_UPSTREAM).fetch(request);
    }

    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    // Relay endpoint
    if (url.pathname === "/ws") {
      const serverId = url.searchParams.get("serverId");
      if (!serverId) {
        return new Response("Missing serverId parameter", { status: 400 });
      }

      const version = resolveRelayVersion(url.searchParams.get("v"));
      if (!version) {
        return new Response("Invalid v parameter (expected 1 or 2)", { status: 400 });
      }

      // Route to a version-isolated Durable Object instance.
      const id = env.RELAY.idFromName(`relay-v${version}:${serverId}`);
      const stub = env.RELAY.get(id);

      const normalizedUrl = new URL(request.url);
      normalizedUrl.searchParams.set("v", version);
      const normalizedRequest = new Request(normalizedUrl.toString(), request);
      return stub.fetch(normalizedRequest);
    }

    return new Response("Not found", { status: 404 });
  },
};
