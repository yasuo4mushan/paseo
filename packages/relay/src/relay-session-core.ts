/**
 * Transport-agnostic relay session core.
 *
 * Owns the pairing/buffering semantics shared by the Cloudflare Durable Object
 * adapter (cloudflare-adapter.ts) and the self-hostable Node server
 * (node-server.ts). It operates on a minimal socket interface plus a pluggable
 * socket registry, and never touches transport-specific APIs.
 *
 * The relay only forwards opaque E2EE ciphertext between daemon and client
 * sockets; see SECURITY.md for the trust model. It deliberately performs no
 * authentication: serverId is a public routing id and pairing secrets travel
 * inside the encrypted channel.
 */

import type { ConnectionRole, RelaySessionAttachment } from "./types.js";

export type RelayProtocolVersion = "1" | "2";

export const LEGACY_RELAY_VERSION: RelayProtocolVersion = "1";
export const CURRENT_RELAY_VERSION: RelayProtocolVersion = "2";

/**
 * Largest message the relay will forward. Mirrors
 * MAX_RELAY_WEBSOCKET_MESSAGE_BYTES in @aaswitch/protocol, duplicated here so
 * the relay package stays installable without workspace dependencies.
 */
export const MAX_RELAY_FRAME_BYTES = 32 * 1024 * 1024;

export function resolveRelayVersion(rawValue: string | null): RelayProtocolVersion | null {
  if (rawValue == null) return LEGACY_RELAY_VERSION;
  const value = rawValue.trim();
  if (!value) return LEGACY_RELAY_VERSION;
  if (value === LEGACY_RELAY_VERSION || value === CURRENT_RELAY_VERSION) {
    return value;
  }
  return null;
}

/**
 * A frame as the relay sees it: text or binary bytes, never inspected.
 * The Cloudflare runtime produces `string | ArrayBuffer`; Node's `ws` produces
 * `Buffer`, which is covered by Uint8Array.
 */
export type RelayFrame = string | ArrayBuffer | Uint8Array;

/**
 * Minimal socket surface the core needs. Both Cloudflare hibernation sockets
 * and Node `ws` sockets satisfy it structurally.
 */
export interface RelayCoreSocket {
  /**
   * Sends one frame verbatim. Typed as unknown rather than RelayFrame so the
   * DOM WebSocket signature (`string | Blob | BufferSource`) stays structurally
   * assignable under every lib generation.
   */
  send(data: unknown): void;
  close(code?: number, reason?: string): void;
}

/**
 * Socket registry the core queries. The Durable Object implementation is backed
 * by the hibernation state API (source of truth after the isolate wakes); the
 * Node implementation keeps in-memory tag sets.
 */
export interface RelaySocketRegistry {
  /** Register a live socket under `tags` with its attachment. */
  register(socket: RelayCoreSocket, attachment: RelaySessionAttachment, tags: string[]): void;
  /** Live sockets currently carrying `tag`. */
  byTag(tag: string): RelayCoreSocket[];
  /** Persisted attachment for a socket, or null/unknown shape if none. */
  attachmentOf(socket: RelayCoreSocket): unknown;
}

export interface RelaySessionCoreOptions {
  /**
   * Log prefix. The Cloudflare adapter keeps the historical "[Relay DO]"
   * default because e2e suites match on these lines.
   */
  logPrefix?: string;
}

export interface RelayConnectionParams {
  role: ConnectionRole;
  serverId: string;
}

export interface RelayV2ConnectionParams extends RelayConnectionParams {
  connectionId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

/**
 * Session core for one (version, serverId) pair — the equivalent of one
 * Durable Object instance.
 *
 * v1 sockets connect in two shapes:
 * - role=server: daemon socket
 * - role=client: app/client socket
 *
 * v2 sockets connect in three shapes:
 * - role=server (no connectionId): daemon control socket (one per serverId)
 * - role=server&connectionId=...: daemon per-connection data socket
 * - role=client&connectionId=...: app/client socket (many per connectionId)
 */
export class RelaySessionCore {
  private registry: RelaySocketRegistry;
  private logPrefix: string;
  private pendingFrames = new Map<string, Array<RelayFrame>>();

  constructor(registry: RelaySocketRegistry, options: RelaySessionCoreOptions = {}) {
    this.registry = registry;
    this.logPrefix = options.logPrefix ?? "[Relay DO]";
  }

  private hasServerDataSocket(connectionId: string): boolean {
    try {
      return this.registry.byTag(`server:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private hasClientSocket(connectionId: string): boolean {
    try {
      return this.registry.byTag(`client:${connectionId}`).length > 0;
    } catch {
      return false;
    }
  }

  private closeExistingServerSockets(args: {
    isServerControl: boolean;
    isServerData: boolean;
    resolvedConnectionId: string;
  }): void {
    if (args.isServerControl) {
      for (const ws of this.registry.byTag("server-control")) {
        ws.close(1008, "Replaced by new connection");
      }
    } else if (args.isServerData) {
      for (const ws of this.registry.byTag(`server:${args.resolvedConnectionId}`)) {
        ws.close(1008, "Replaced by new connection");
      }
    }
  }

  // COMPAT(relay-json-ping): Old daemons (< v0.1.76) send JSON {type:"ping"} on the control
  // socket and rely on a JSON {type:"pong"} reply to keep controlLastSeenAt fresh. New daemons
  // use WebSocket protocol pings (auto-answered at the edge, DO stays hibernated). Remove this
  // handler once the supported-daemon floor is >= v0.1.76 (target: 2026-11-13).
  private handleControlKeepalive(ws: RelayCoreSocket, message: string): void {
    try {
      const parsed: unknown = JSON.parse(message);
      const parsedRecord = isRecord(parsed) ? parsed : null;
      if (parsedRecord?.type !== "ping") return;
      // Logged so the daemon-side e2e idle test can assert no JSON ping reached the DO
      // (which would indicate a regression to app-level pings that wake the DO).
      console.log(`${this.logPrefix} legacy_json_ping_received`);
      try {
        ws.send(JSON.stringify({ type: "pong", ts: Date.now() }));
      } catch {
        // ignore
      }
    } catch {
      // ignore non-JSON control payloads
    }
  }

  /**
   * Public for adapters/tests; normally triggered by acceptV2Connection when
   * a client connects.
   */
  nudgeOrResetControlForConnection(connectionId: string): void {
    // If the daemon's control WS becomes half-open, the relay can't reliably detect it via ws.send errors
    // (the platform may accept writes even if the other side is no longer reading).
    //
    // Instead, observe whether the daemon reacts by opening the per-connection server-data socket.
    // If it doesn't, nudge with a sync message; if still no reaction, force-close the control
    // socket(s) so the daemon reconnects.
    const initialDelayMs = 10_000;
    const secondDelayMs = 5_000;

    const firstTimer = setTimeout(() => {
      if (!this.hasClientSocket(connectionId)) return;
      if (this.hasServerDataSocket(connectionId)) return;

      // First nudge: send a full sync list.
      this.notifyControls({ type: "sync", connectionIds: this.listConnectedConnectionIds() });

      const secondTimer = setTimeout(() => {
        if (!this.hasClientSocket(connectionId)) return;
        if (this.hasServerDataSocket(connectionId)) return;

        // Still nothing: assume control is stuck and force a reconnect.
        for (const ws of this.registry.byTag("server-control")) {
          try {
            ws.close(1011, "Control unresponsive");
          } catch {
            // ignore
          }
        }
      }, secondDelayMs);
      secondTimer.unref?.();
    }, initialDelayMs);
    firstTimer.unref?.();
  }

  private bufferFrame(connectionId: string, message: RelayFrame): void {
    const existing = this.pendingFrames.get(connectionId) ?? [];
    existing.push(message);
    // Prevent unbounded memory growth if a daemon never connects.
    if (existing.length > 200) {
      existing.splice(0, existing.length - 200);
    }
    this.pendingFrames.set(connectionId, existing);
  }

  private flushFrames(connectionId: string, serverWs: RelayCoreSocket): void {
    const frames = this.pendingFrames.get(connectionId);
    if (!frames || frames.length === 0) return;
    this.pendingFrames.delete(connectionId);
    for (const frame of frames) {
      try {
        serverWs.send(frame);
      } catch {
        // If we can't flush, re-buffer and let the daemon re-establish.
        this.bufferFrame(connectionId, frame);
        break;
      }
    }
  }

  private listConnectedConnectionIds(): string[] {
    const out = new Set<string>();
    for (const ws of this.registry.byTag("client")) {
      try {
        const attachmentRaw = this.registry.attachmentOf(ws);
        const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
        if (
          attachment?.role === "client" &&
          typeof attachment.connectionId === "string" &&
          attachment.connectionId
        ) {
          out.add(attachment.connectionId);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out);
  }

  private notifyControls(message: unknown): void {
    const text = JSON.stringify(message);
    for (const ws of this.registry.byTag("server-control")) {
      try {
        ws.send(text);
      } catch {
        // If the control socket is dead, close it so the daemon can reconnect.
        try {
          ws.close(1011, "Control send failed");
        } catch {
          // ignore
        }
      }
    }
  }

  acceptV1Connection(socket: RelayCoreSocket, params: RelayConnectionParams): void {
    const { role, serverId } = params;

    for (const ws of this.registry.byTag(role)) {
      ws.close(1008, "Replaced by new connection");
    }

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: LEGACY_RELAY_VERSION,
      connectionId: null,
      createdAt: Date.now(),
    };
    this.registry.register(socket, attachment, [role]);

    console.log(`${this.logPrefix} v1:${role} connected to session ${serverId}`);
  }

  acceptV2Connection(socket: RelayCoreSocket, params: RelayV2ConnectionParams): void {
    const { role, serverId } = params;

    // If a client didn't provide a connectionId, the relay assigns one for routing.
    const resolvedConnectionId =
      role === "client" && !params.connectionId
        ? `conn_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`
        : params.connectionId;

    const isServerControl = role === "server" && !resolvedConnectionId;
    const isServerData = role === "server" && !!resolvedConnectionId;

    // Close any existing server-side connection with the same identity.
    // - server-control: single per serverId
    // - server-data: single per connectionId
    // - client: many sockets per connectionId are allowed
    this.closeExistingServerSockets({ isServerControl, isServerData, resolvedConnectionId });

    const tags: string[] = [];
    if (role === "client") {
      tags.push("client", `client:${resolvedConnectionId}`);
    } else if (isServerControl) {
      tags.push("server-control");
    } else {
      tags.push("server", `server:${resolvedConnectionId}`);
    }

    const attachment: RelaySessionAttachment = {
      serverId,
      role,
      version: CURRENT_RELAY_VERSION,
      connectionId: resolvedConnectionId || null,
      createdAt: Date.now(),
    };
    this.registry.register(socket, attachment, tags);

    let roleSuffix = "";
    if (isServerControl) {
      roleSuffix = "(control)";
    } else if (isServerData) {
      roleSuffix = `(data:${resolvedConnectionId})`;
    } else if (role === "client") {
      roleSuffix = `(${resolvedConnectionId})`;
    }
    console.log(`${this.logPrefix} v2:${role}${roleSuffix} connected to session ${serverId}`);

    if (role === "client") {
      this.notifyControls({ type: "connected", connectionId: resolvedConnectionId });
      this.nudgeOrResetControlForConnection(resolvedConnectionId);
    }

    if (isServerControl) {
      // Send current connection list so the daemon can attach existing connections.
      try {
        socket.send(
          JSON.stringify({ type: "sync", connectionIds: this.listConnectedConnectionIds() }),
        );
      } catch {
        // ignore
      }
    }

    if (isServerData && resolvedConnectionId) {
      this.flushFrames(resolvedConnectionId, socket);
    }
  }

  /**
   * Called when a WebSocket message is received.
   */
  webSocketMessage(ws: RelayCoreSocket, message: RelayFrame): void {
    const attachmentRaw = this.registry.attachmentOf(ws);
    if (!isRecord(attachmentRaw)) {
      console.error(`${this.logPrefix} Message from WebSocket without attachment`);
      return;
    }
    const attachment = attachmentRaw;

    const version = getString(attachment, "version") ?? LEGACY_RELAY_VERSION;

    if (version === LEGACY_RELAY_VERSION) {
      const targetRole = attachment.role === "server" ? "client" : "server";
      const targets = this.registry.byTag(targetRole);
      for (const target of targets) {
        try {
          target.send(message);
        } catch (error) {
          console.error(`${this.logPrefix} Failed to forward to ${targetRole}:`, error);
        }
      }
      return;
    }

    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");
    if (!connectionId) {
      // Control channel: support simple app-level keepalive.
      if (typeof message === "string") {
        this.handleControlKeepalive(ws, message);
      }
      return;
    }

    if (role === "client") {
      const servers = this.registry.byTag(`server:${connectionId}`);
      if (servers.length === 0) {
        this.bufferFrame(connectionId, message);
        return;
      }
      for (const target of servers) {
        try {
          target.send(message);
        } catch (error) {
          console.error(
            `${this.logPrefix} Failed to forward client->server(${connectionId}):`,
            error,
          );
        }
      }
      return;
    }

    // server data socket -> client
    const targets = this.registry.byTag(`client:${connectionId}`);
    for (const target of targets) {
      try {
        target.send(message);
      } catch (error) {
        console.error(
          `${this.logPrefix} Failed to forward server->client(${connectionId}):`,
          error,
        );
      }
    }
  }

  /**
   * Called when a WebSocket closes. The socket must already be deregistered
   * (mirrors Durable Object semantics where `getWebSockets` omits closed
   * sockets by the time `webSocketClose` fires).
   */
  webSocketClose(ws: RelayCoreSocket, code: number, reason: string): void {
    const attachmentRaw = this.registry.attachmentOf(ws);
    if (!isRecord(attachmentRaw)) return;
    const attachment = attachmentRaw;

    const version = getString(attachment, "version") ?? LEGACY_RELAY_VERSION;
    const role = getString(attachment, "role");
    const connectionId = getString(attachment, "connectionId");
    const serverId = getString(attachment, "serverId");
    console.log(
      `${this.logPrefix} v${version}:${role ?? "unknown"}${connectionId ? `(${connectionId})` : ""} disconnected from session ${serverId ?? "unknown"} (${code}: ${reason})`,
    );

    if (version === LEGACY_RELAY_VERSION) {
      return;
    }

    if (role === "client" && connectionId) {
      const remainingClientSockets = this.registry
        .byTag(`client:${connectionId}`)
        .some((socket) => socket !== ws);
      if (remainingClientSockets) {
        return;
      }

      this.pendingFrames.delete(connectionId);
      // Last socket for this session closed: now clean up matching server-data socket.
      for (const serverWs of this.registry.byTag(`server:${connectionId}`)) {
        try {
          serverWs.close(1001, "Client disconnected");
        } catch {
          // ignore
        }
      }
      this.notifyControls({ type: "disconnected", connectionId });
      return;
    }

    if (role === "server" && connectionId) {
      // Force the client to reconnect and re-handshake when the daemon side drops.
      for (const clientWs of this.registry.byTag(`client:${connectionId}`)) {
        try {
          clientWs.close(1012, "Server disconnected");
        } catch {
          // ignore
        }
      }
    }
  }

  /**
   * Called on WebSocket error.
   */
  webSocketError(ws: RelayCoreSocket, error: unknown): void {
    const attachmentRaw = this.registry.attachmentOf(ws);
    const attachment = isRecord(attachmentRaw) ? attachmentRaw : null;
    const role = attachment ? getString(attachment, "role") : undefined;
    console.error(`${this.logPrefix} WebSocket error for ${role ?? "unknown"}:`, error);
  }
}
