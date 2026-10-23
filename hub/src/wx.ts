/**
 * WeChat mini-program server API client for phone-number login (auth.wx-phone).
 *
 * Protocol (official docs, developers.weixin.qq.com):
 *   1. `POST /cgi-bin/stable_token` — exchange (appid, secret) for an
 *      access_token, `expires_in` 7200s. The stable variant never invalidates
 *      previously issued tokens, which is why it's preferred over
 *      `/cgi-bin/token` for a single-instance server with an in-process cache.
 *   2. `POST /wxa/business/getuserphonenumber?access_token=...` with body
 *      `{code}` — the dynamic code from the mini-program `getPhoneNumber`
 *      button (valid 5 minutes, single use, NOT the wx.login code). Returns
 *      `{errcode, errmsg, phone_info:{phoneNumber, purePhoneNumber, countryCode}}`.
 *
 * Zero runtime dependencies: hand-rolled node:http/https with optional
 * HTTP-proxy support (HUB_HTTPS_PROXY) via CONNECT tunneling.
 */

import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { HubConfig } from "./config.js";
import { ApiError, PHONE_RE } from "./validate.js";

export const WX_API_BASE = "https://api.weixin.qq.com";

const DEFAULT_TIMEOUT_MS = 10_000;
/** Refresh the cached access_token this long before its real expiry. */
const TOKEN_REFRESH_MARGIN_MS = 5 * 60_000;
/** errcodes meaning the access_token itself is bad → force refresh, retry once. */
const TOKEN_ERRCODES = new Set([40001, 42001]);

export interface WxPhoneOptions {
  appid: string;
  secret: string;
  /** API base override; tests point this at a local http mock server. */
  apiBase?: string;
  /** HTTP proxy URL (`HUB_HTTPS_PROXY`, e.g. `http://127.0.0.1:7897`); https targets only. */
  proxyUrl?: string;
  timeoutMs?: number;
}

interface HttpResult {
  status: number;
  body: string;
}

interface StableTokenResponse {
  errcode?: number;
  errmsg?: string;
  access_token?: string;
  expires_in?: number;
}

interface GetPhoneResponse {
  errcode?: number;
  errmsg?: string;
  phone_info?: {
    phoneNumber?: string;
    purePhoneNumber?: string;
    countryCode?: number | string;
  };
}

const wxUpstream = (message: string) => new ApiError(502, "auth.wx_upstream", message);

// ---- transport ---------------------------------------------------------------

function nodeRequest(
  mod: typeof http | typeof https,
  options: http.RequestOptions,
  body: string,
  timeoutMs: number,
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = mod.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
      res.on("error", reject);
    });
    req.setTimeout(timeoutMs, () =>
      req.destroy(new Error(`request timed out after ${timeoutMs}ms`)),
    );
    req.on("error", reject);
    req.end(body);
  });
}

/** Open a CONNECT tunnel through an HTTP proxy for one https target. */
function connectTunnel(proxy: URL, host: string, port: number, timeoutMs: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: proxy.hostname,
      port: proxy.port ? Number(proxy.port) : 80,
      method: "CONNECT",
      path: `${host}:${port}`,
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`proxy CONNECT failed with ${res.statusCode}`));
        return;
      }
      resolve(socket);
    });
    req.once("error", reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error("proxy CONNECT timed out")));
    req.end();
  });
}

async function postJson(
  target: URL,
  payload: unknown,
  opts: { proxyUrl?: string; timeoutMs: number },
): Promise<HttpResult> {
  const body = JSON.stringify(payload);
  const headers = {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(body),
  };
  const isHttps = target.protocol === "https:";
  const port = target.port ? Number(target.port) : isHttps ? 443 : 80;

  // Direct request (no proxy, or http test target where proxying is pointless).
  if (!opts.proxyUrl || !isHttps) {
    const mod = isHttps ? https : http;
    return nodeRequest(
      mod,
      {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers,
        agent: false,
      },
      body,
      opts.timeoutMs,
    );
  }

  const proxy = new URL(opts.proxyUrl);
  const socket = await connectTunnel(proxy, target.hostname, port, opts.timeoutMs);
  try {
    return await nodeRequest(
      https,
      {
        hostname: target.hostname,
        port,
        path: `${target.pathname}${target.search}`,
        method: "POST",
        headers,
        agent: false,
        createConnection: () => tlsConnect({ socket, servername: target.hostname }),
      },
      body,
      opts.timeoutMs,
    );
  } finally {
    socket.destroy();
  }
}

// ---- service -----------------------------------------------------------------

/** Calls the WeChat server APIs to exchange a getPhoneNumber code for a phone. */
export class WxPhoneService {
  private readonly base: string;
  private readonly timeoutMs: number;
  private token: { value: string; expiresAt: number } | null = null;

  constructor(private readonly opts: WxPhoneOptions) {
    this.base = opts.apiBase ?? WX_API_BASE;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Exchange a mini-program getPhoneNumber `code` for the user's phone.
   * On a token-expiry errcode the cached token is force-refreshed and the
   * call retried exactly once.
   */
  async getPhoneNumber(code: string): Promise<string> {
    const first = await this.callGetPhone(await this.accessToken(false), code);
    let res = first;
    if (res.errcode !== undefined && TOKEN_ERRCODES.has(res.errcode)) {
      res = await this.callGetPhone(await this.accessToken(true), code);
    }
    if (res.errcode === 40029) {
      throw new ApiError(401, "auth.wx_code_invalid", "wx phone code is invalid or already used");
    }
    if (res.errcode !== 0 && res.errcode !== undefined) {
      throw wxUpstream(`WeChat getPhoneNumber failed (${res.errcode}: ${res.errmsg ?? "?"})`);
    }
    const info = res.phone_info;
    const national = info?.purePhoneNumber ?? info?.phoneNumber;
    const country = Number(info?.countryCode ?? 86);
    if (country !== 86) {
      throw new ApiError(
        400,
        "auth.invalid_phone",
        "WeChat returned a non-mainland-China phone number (+86 only)",
      );
    }
    if (!national || !PHONE_RE.test(national)) {
      throw new ApiError(400, "auth.invalid_phone", "WeChat returned an unparseable phone number");
    }
    return national;
  }

  private async callGetPhone(token: string, code: string): Promise<GetPhoneResponse> {
    const url = new URL("/wxa/business/getuserphonenumber", this.base);
    url.searchParams.set("access_token", token);
    const result = await this.wxPost(url, { code });
    if (result.status !== 200) throw wxUpstream(`WeChat API HTTP ${result.status}`);
    return this.parseJson<GetPhoneResponse>(result.body);
  }

  /** Cached stable_token; `force` bypasses the cache and forces re-issuance. */
  private async accessToken(force: boolean): Promise<string> {
    if (!force && this.token && Date.now() < this.token.expiresAt) return this.token.value;
    const url = new URL("/cgi-bin/stable_token", this.base);
    const result = await this.wxPost(url, {
      grant_type: "client_credential",
      appid: this.opts.appid,
      secret: this.opts.secret,
      force_refresh: force,
    });
    if (result.status !== 200) throw wxUpstream(`WeChat stable_token HTTP ${result.status}`);
    const parsed = this.parseJson<StableTokenResponse>(result.body);
    if (parsed.errcode !== undefined && parsed.errcode !== 0) {
      throw wxUpstream(`WeChat stable_token failed (${parsed.errcode}: ${parsed.errmsg ?? "?"})`);
    }
    if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
      throw wxUpstream("WeChat stable_token returned no access_token");
    }
    const ttlMs = (Number(parsed.expires_in) || 7200) * 1000 - TOKEN_REFRESH_MARGIN_MS;
    this.token = { value: parsed.access_token, expiresAt: Date.now() + ttlMs };
    return parsed.access_token;
  }

  private transportOpts(): { proxyUrl?: string; timeoutMs: number } {
    return { proxyUrl: this.opts.proxyUrl, timeoutMs: this.timeoutMs };
  }

  /** postJson wrapper: any transport failure (DNS, refused, timeout) → 502. */
  private async wxPost(url: URL, payload: unknown): Promise<HttpResult> {
    try {
      return await postJson(url, payload, this.transportOpts());
    } catch (err) {
      if (err instanceof ApiError) throw err;
      throw wxUpstream(
        `WeChat API request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private parseJson<T>(body: string): T {
    try {
      return JSON.parse(body) as T;
    } catch {
      throw wxUpstream("WeChat API returned a non-JSON body");
    }
  }
}

/**
 * Build the service from hub config. Enabled only when BOTH HUB_WXA_APPID and
 * HUB_WXA_SECRET are set — otherwise auth.wx-phone answers 501 auth.wx_disabled.
 * `apiBase` is a test-only override pointing at a local mock.
 */
export function wxServiceFromConfig(
  config: Pick<HubConfig, "wxaAppid" | "wxaSecret" | "httpsProxy">,
  apiBase?: string,
): WxPhoneService | undefined {
  if (!config.wxaAppid || !config.wxaSecret) return undefined;
  return new WxPhoneService({
    appid: config.wxaAppid,
    secret: config.wxaSecret,
    proxyUrl: config.httpsProxy,
    ...(apiBase !== undefined ? { apiBase } : {}),
  });
}
