/**
 * HTTP server and entrypoint.
 *
 * Routing (canonical URL shape, shared by direct access and the nginx
 * pass-through proxy):
 *   GET  /health          -> {"status":"ok"}
 *   POST /api/<method>    -> API envelope; method is a dotted name, e.g.
 *                            POST /api/auth.login
 *
 * The hub logs one JSON line per request and never logs tokens, passwords,
 * or offers.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { ApiContext, dispatch } from "./api.js";
import { HubConfig, loadConfig } from "./config.js";
import { logError, logInfo, logWarn, setLogLevel } from "./log.js";
import { RateLimiter } from "./rate-limit.js";
import { HubStore } from "./store.js";
import { ApiError } from "./validate.js";

const MAX_BODY_BYTES = 128 * 1024;

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type, authorization",
  "access-control-max-age": "86400",
} as const;

export function createHubServer(ctx: ApiContext): http.Server {
  return http.createServer((req, res) => {
    void handleRequest(ctx, req, res);
  });
}

function clientIp(ctx: ApiContext, req: http.IncomingMessage): string {
  const socketAddr = req.socket.remoteAddress ?? "unknown";
  const normalized = socketAddr.startsWith("::ffff:") ? socketAddr.slice(7) : socketAddr;
  if (!ctx.config.trustProxy) return normalized;
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff !== "string" || xff === "") return normalized;
  // One trusted proxy layer: nginx appends the real client IP last.
  const entries = xff
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries[entries.length - 1] : normalized;
}

function bearerFrom(req: http.IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) return undefined;
  const token = header.slice("Bearer ".length).trim();
  return token.length > 0 ? token : undefined;
}

async function readBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES)
      throw new ApiError(413, "bad_request", `body exceeds ${MAX_BODY_BYTES} bytes`);
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim() === "") return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ApiError(400, "bad_request", "body is not valid JSON");
  }
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    ...CORS_HEADERS,
    ...extraHeaders,
  });
  res.end(body);
}

async function handleRequest(
  ctx: ApiContext,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const startedAt = Date.now();
  const url = new URL(req.url ?? "/", "http://local");
  const pathname = url.pathname.replace(/\/+$/, "") || "/";
  const method = req.method ?? "GET";
  let status = 500;

  try {
    if (method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      status = 204;
      return;
    }

    if (pathname === "/health") {
      if (method !== "GET" && method !== "HEAD") {
        status = 405;
        sendJson(res, 405, {
          ok: false,
          error: { code: "method_not_allowed", message: "use GET" },
        });
        return;
      }
      status = 200;
      sendJson(res, 200, { status: "ok" });
      return;
    }

    const methodPath = pathname.startsWith("/api/") ? pathname.slice("/api/".length) : "";
    const isMethodRoute = /^[a-z0-9]+(\.[a-z0-9_]+)+$/.test(methodPath);

    if (!isMethodRoute) {
      status = 404;
      sendJson(res, 404, { ok: false, error: { code: "not_found", message: "unknown path" } });
      return;
    }
    if (method !== "POST") {
      status = 405;
      sendJson(res, 405, { ok: false, error: { code: "method_not_allowed", message: "use POST" } });
      return;
    }

    const body = await readBody(req);
    const result = await dispatch(ctx, methodPath, body, bearerFrom(req), clientIp(ctx, req));
    status = result.status;
    const headers: Record<string, string> = {};
    if (result.retryAfterSec !== undefined) headers["retry-after"] = String(result.retryAfterSec);
    sendJson(res, result.status, result.body, headers);
  } catch (err) {
    if (err instanceof ApiError) {
      status = err.status;
      sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
    } else {
      status = 500;
      logError("request_error", {
        path: pathname,
        error: err instanceof Error ? err.message : String(err),
      });
      sendJson(res, 500, {
        ok: false,
        error: { code: "internal_error", message: "internal server error" },
      });
    }
  } finally {
    const durationMs = Date.now() - startedAt;
    const fields = { httpMethod: method, path: pathname, status, durationMs };
    if (status >= 500) logError("http_request", fields);
    else if (status >= 400) logWarn("http_request", fields);
    else logInfo("http_request", fields);
  }
}

/** Build the full runtime (config + store + limiter + server). Test entry. */
export function buildHub(config: HubConfig): {
  server: http.Server;
  ctx: ApiContext;
  store: HubStore;
} {
  const store = new HubStore(config.dbPath);
  const ctx: ApiContext = { store, config, limiter: new RateLimiter(10, 60_000) };
  const server = createHubServer(ctx);
  return { server, ctx, store };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const level = process.env.HUB_LOG_LEVEL;
  if (level === "debug" || level === "warn" || level === "error") setLogLevel(level);
  const { server, store } = buildHub(config);

  // Periodic expired-session sweep; unref so it never blocks shutdown.
  const sweep = setInterval(() => store.sweepExpiredSessions(), 10 * 60 * 1000);
  sweep.unref();

  server.listen(config.port, config.host, () => {
    const addr = server.address() as AddressInfo;
    logInfo("server_ready", { host: config.host, port: addr.port, dbPath: config.dbPath });
  });

  const shutdown = (signal: string) => {
    logInfo("server_shutdown", { signal });
    server.close(() => process.exit(0));
    // Force-exit if connections linger.
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

// Run only when executed directly (node dist/server.js), not when imported.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
