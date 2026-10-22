/**
 * Hub HTTP 客户端：账号体系（注册/登录/登出/当前账号）与设备列表。
 *
 * - 传输：`POST <base>/<method>`，JSON body；成功 HTTP 200 `{ok:true,data}`；
 *   失败 `{ok:false,error:{code,message}}` —— 真实 hub 的失败伴随 401/404/409/429
 *   等状态码（见 hub/src/api.ts），错误码以 envelope body 为准，状态码只作降级。
 * - 登录后携带 `Authorization: Bearer <token>`；会话（token + 账号）只存本机
 *   storage；hub 地址可在设置页覆盖（开发期可指向局域网 mock，正式发布必须
 *   是 https，见 README 域名清单）。
 * - 网络失败 / 响应形态异常统一抛 HubApiError，code 见 ERROR_MESSAGE 映射。
 */

import Taro from "@tarojs/taro";
import { parseHubAccount, parseHubDevices, type HubAccount, type HubDevice } from "./hub-types";

export const DEFAULT_HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";

const TOKEN_KEY = "aaswitch_hub_token";
const ACCOUNT_KEY = "aaswitch_hub_account";
const HUB_BASE_KEY = "aaswitch_hub_base";

/** hub 错误码 → 用户可读文案；未匹配的 code 回退到服务端 message。 */
export const ERROR_MESSAGES: Record<string, string> = {
  "auth.invalid_credentials": "用户名或密码错误",
  "auth.invalid_username": "用户名格式不正确（2-32 位字母数字下划线）",
  "auth.invalid_password": "密码至少 6 位",
  "auth.username_taken": "用户名已被注册",
  "auth.unauthorized": "登录已过期，请重新登录",
  "auth.token_invalid": "登录已过期，请重新登录",
  rate_limited: "操作过于频繁，请稍后再试",
  "hub.rate_limited": "操作过于频繁，请稍后再试",
  "hub.invalid_request": "请求参数错误",
  "hub.internal_error": "服务器内部错误",
};

export class HubApiError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "HubApiError";
    this.code = code;
  }
}

export function hubErrorMessage(error: unknown): string {
  if (error instanceof HubApiError) {
    return ERROR_MESSAGES[error.code] ?? (error.message || "请求失败");
  }
  if (error instanceof Error && error.message) return error.message;
  return "请求失败";
}

/** 错误是否表示会话失效（设备页据此清 token 跳登录）。 */
export function isAuthExpired(error: unknown): boolean {
  if (!(error instanceof HubApiError)) return false;
  return error.code === "auth.unauthorized" || error.code.startsWith("auth.token_");
}

// ---------------------------------------------------------------------------
// hub 地址
// ---------------------------------------------------------------------------

export function normalizeHubBase(input: string): string {
  const trimmed = input.trim().replace(/\/+$/, "");
  if (!/^https?:\/\/[^\s/]+/i.test(trimmed)) {
    throw new Error("地址应以 http:// 或 https:// 开头");
  }
  return trimmed;
}

export function getHubBase(): string {
  const stored = Taro.getStorageSync<string>(HUB_BASE_KEY);
  return stored || DEFAULT_HUB_BASE;
}

export function setHubBase(base: string): string {
  const normalized = normalizeHubBase(base);
  if (normalized === DEFAULT_HUB_BASE) {
    Taro.removeStorageSync(HUB_BASE_KEY);
  } else {
    Taro.setStorageSync(HUB_BASE_KEY, normalized);
  }
  return normalized;
}

export function resetHubBase(): void {
  Taro.removeStorageSync(HUB_BASE_KEY);
}

// ---------------------------------------------------------------------------
// 会话存取
// ---------------------------------------------------------------------------

export function hasSession(): boolean {
  return !!Taro.getStorageSync<string>(TOKEN_KEY);
}

export function getToken(): string | null {
  return Taro.getStorageSync<string>(TOKEN_KEY) || null;
}

export function getAccount(): HubAccount | null {
  const raw = Taro.getStorageSync<string>(ACCOUNT_KEY);
  if (!raw) return null;
  try {
    return parseHubAccount(JSON.parse(raw));
  } catch {
    return null;
  }
}

function saveSession(token: string, account: HubAccount): void {
  Taro.setStorageSync(TOKEN_KEY, token);
  Taro.setStorageSync(ACCOUNT_KEY, JSON.stringify(account));
}

/** 清空本地会话（退出登录 / 会话失效时调用；不动 hub 地址）。 */
export function clearSession(): void {
  Taro.removeStorageSync(TOKEN_KEY);
  Taro.removeStorageSync(ACCOUNT_KEY);
}

// ---------------------------------------------------------------------------
// RPC
// ---------------------------------------------------------------------------

interface CallOptions {
  /** 401 / auth.unauthorized 时是否自动清空本地会话（页面再据此跳登录）。 */
  autoClearSession?: boolean;
}

async function call<T>(
  method: string,
  params: Record<string, unknown>,
  parse: (data: unknown) => T | null,
  options: CallOptions = {},
): Promise<T> {
  const token = getToken();
  let response: { statusCode: number; data: unknown };
  try {
    response = await Taro.request<unknown>({
      url: `${getHubBase()}/${method}`,
      method: "POST",
      data: params,
      header: token ? { Authorization: `Bearer ${token}` } : {},
      timeout: 15_000,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new HubApiError("hub.network_error", `无法连接服务器（${detail}）`);
  }

  const body = response.data;
  const envelope =
    typeof body === "object" && body !== null
      ? (body as { ok?: unknown; data?: unknown; error?: unknown })
      : null;
  if (envelope?.ok !== true) {
    const error = envelope?.error as { code?: unknown; message?: unknown } | undefined;
    // 真实 hub 的错误走 HTTP 401/404/409/429 + envelope error（见 hub/src/api.ts）；
    // 只有 body 完全不可读（如网关 HTML 错误页）才降级为 http_error。
    const code =
      typeof error?.code === "string" && error.code
        ? error.code
        : response.statusCode !== 200
          ? "hub.http_error"
          : "hub.unknown_error";
    const message =
      typeof error?.message === "string" && error.message
        ? error.message
        : response.statusCode !== 200
          ? `服务器响应异常（HTTP ${response.statusCode}）`
          : "请求失败";
    if (options.autoClearSession && isAuthExpired(new HubApiError(code, message))) {
      clearSession();
    }
    throw new HubApiError(code, message);
  }
  const parsed = parse(envelope.data);
  if (parsed === null) throw new HubApiError("hub.bad_response", "服务器响应格式异常");
  return parsed;
}

export interface LoginResult {
  token: string;
  account: HubAccount;
}

export const hub = {
  /** 登录并保存会话。 */
  async login(username: string, password: string): Promise<LoginResult> {
    const result = await call<LoginResult>(
      "auth.login",
      { username: username.trim(), password },
      (data) => {
        if (typeof data !== "object" || data === null) return null;
        const record = data as { token?: unknown; account?: unknown };
        if (typeof record.token !== "string" || !record.token) return null;
        const account = parseHubAccount(record.account);
        return account ? { token: record.token, account } : null;
      },
    );
    saveSession(result.token, result.account);
    return result;
  },

  /** 注册（hub 只建账号不发 token），成功后紧接着自动登录。 */
  async register(username: string, password: string): Promise<LoginResult> {
    await call(
      "auth.register",
      { username: username.trim(), password },
      (data) => parseHubAccount((data as { account?: unknown } | null)?.account),
    );
    return this.login(username, password);
  },

  /** 服务端登出；无论成败都清本地会话。 */
  async logout(): Promise<void> {
    try {
      await call("auth.logout", {}, () => true);
    } finally {
      clearSession();
    }
  },

  async me(): Promise<HubAccount> {
    return call(
      "auth.me",
      {},
      (data) => parseHubAccount((data as { account?: unknown } | null)?.account),
      { autoClearSession: true },
    );
  },

  /** 设备列表（含连接 offer；离线设备 offer 可能为 null）。 */
  async devices(): Promise<HubDevice[]> {
    return call("devices.list", {}, parseHubDevices, { autoClearSession: true });
  },
};
