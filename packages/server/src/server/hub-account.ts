import os from "node:os";
import type pino from "pino";

import type { HubAccountStatus } from "@getpaseo/protocol/messages";
import { normalizeHubBaseUrl } from "./config.js";
import {
  readPersistedConfig,
  savePersistedConfig,
  type PersistedConfig,
} from "./persisted-config.js";

/**
 * aaswitch Hub account integration (t13). The daemon registers this machine as
 * a device under the signed-in account so the miniprogram can list and connect
 * to it. The hub API contract (t12): `POST <base>/api/<method>` with JSON body,
 * responses `{ok:true,data}` / `{ok:false,error:{code,message}}`, bearer-token
 * auth. Registration is idempotent per account+device name; `devices.register`
 * returns the durable `deviceId` which heartbeats must echo.
 */

const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
const DEFAULT_BACKOFF_BASE_MS = 2_000;
const MAX_BACKOFF_MS = 60_000;
const API_TIMEOUT_MS = 10_000;
const UNREGISTER_TIMEOUT_MS = 3_000;

export interface HubDeviceOffer {
  serverId: string;
  daemonPublicKeyB64: string;
  endpoint: string;
  useTls: boolean;
}

export class HubApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "HubApiError";
  }
}

type FetchLike = typeof fetch;

interface HubApiCallOptions {
  baseUrl: string;
  method: string;
  body?: unknown;
  token?: string;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export async function callHubApi<T = unknown>(options: HubApiCallOptions): Promise<T> {
  const fetchImpl = options.fetchImpl ?? fetch;
  // Callers paste hub URLs with trailing slashes or an explicit `/api` path;
  // every request targets `<origin>/api/<method>` regardless.
  const baseUrl = normalizeHubBaseUrl(options.baseUrl);
  if (!baseUrl) {
    throw new HubApiError("Hub base URL is invalid", "hub.url_invalid");
  }
  let response: Response;
  try {
    response = await fetchImpl(`${baseUrl}/api/${options.method}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      },
      body: JSON.stringify(options.body ?? {}),
      signal: AbortSignal.timeout(options.timeoutMs ?? API_TIMEOUT_MS),
    });
  } catch (error) {
    throw new HubApiError(error instanceof Error ? error.message : String(error), "network_error");
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Proxy errors can return HTML; fall through to the status-based error.
  }

  const record = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  if (response.ok && record.ok === true) {
    return record.data as T;
  }

  const error = (record.error && typeof record.error === "object" ? record.error : {}) as Record<
    string,
    unknown
  >;
  const code = typeof error.code === "string" ? error.code : `http_${response.status}`;
  const message = typeof error.message === "string" ? error.message : `Hub request failed`;
  const retryAfterHeader = response.headers.get("retry-after");
  const retryAfterSeconds = retryAfterHeader ? Number(retryAfterHeader) : Number.NaN;
  throw new HubApiError(
    message,
    code,
    response.status,
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 0
      ? retryAfterSeconds * 1000
      : undefined,
  );
}

export interface HubAccountLoginResult {
  token: string;
  account: { id: string; phone: string };
}

export async function hubLogin(input: {
  baseUrl: string;
  phone: string;
  password: string;
  fetchImpl?: FetchLike;
}): Promise<HubAccountLoginResult> {
  return callHubApi<HubAccountLoginResult>({
    baseUrl: input.baseUrl,
    method: "auth.login",
    body: { phone: input.phone, password: input.password },
    fetchImpl: input.fetchImpl,
  });
}

export async function hubRegisterAccount(input: {
  baseUrl: string;
  phone: string;
  password: string;
  fetchImpl?: FetchLike;
}): Promise<{ account: { id: string; phone: string } }> {
  return callHubApi<{ account: { id: string; phone: string } }>({
    baseUrl: input.baseUrl,
    method: "auth.register",
    body: { phone: input.phone, password: input.password },
    fetchImpl: input.fetchImpl,
  });
}

/**
 * Change the signed-in account's hub password via `auth.password.change` using
 * the stored session token. Accounts created through WeChat one-click login
 * that never set a password (hub-side passwordSet=false) omit `oldPassword`.
 */
export async function hubChangePassword(input: {
  baseUrl: string;
  token: string;
  oldPassword?: string;
  newPassword: string;
  fetchImpl?: FetchLike;
}): Promise<void> {
  await callHubApi({
    baseUrl: input.baseUrl,
    method: "auth.password.change",
    body: {
      ...(input.oldPassword ? { oldPassword: input.oldPassword } : {}),
      newPassword: input.newPassword,
    },
    token: input.token,
    fetchImpl: input.fetchImpl,
  });
}

interface RelayConfigSnapshot {
  enabled: boolean;
  publicEndpoint: string;
  publicUseTls: boolean;
}

export interface HubAccountManager {
  status(): HubAccountStatus;
  applyCredentials(input: {
    baseUrl: string;
    token: string;
    phone: string;
    deviceName?: string;
  }): Promise<void>;
  /**
   * Change the hub account password using the stored session token. The token
   * itself survives (the hub only revokes the account's other sessions).
   */
  changePassword(input: { oldPassword?: string; newPassword: string }): Promise<void>;
  logout(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

interface CreateHubAccountManagerOptions {
  paseoHome: string;
  logger?: pino.Logger;
  serverId: string;
  daemonPublicKeyB64: string;
  getRelayConfig: () => RelayConfigSnapshot | null;
  initial: {
    baseUrl: string | null;
    token: string | null;
    phone: string | null;
    deviceName: string | null;
  };
  heartbeatIntervalMs?: number;
  backoffBaseMs?: number;
  fetchImpl?: FetchLike;
}

function offerToString(offer: HubDeviceOffer): string {
  return JSON.stringify(offer);
}

function errorToMessage(error: unknown): string {
  if (error instanceof HubApiError) {
    return `${error.code}: ${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export function createHubAccountManager(
  options: CreateHubAccountManagerOptions,
): HubAccountManager {
  const log = options.logger?.child({ module: "hub-account" });
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
  const fetchImpl = options.fetchImpl ?? fetch;

  let baseUrl = options.initial.baseUrl;
  let token = options.initial.token;
  let phone = options.initial.phone;
  let deviceName = options.initial.deviceName;
  let deviceId: string | null = null;
  let registeredOffer: string | null = null;
  let registered = false;
  let lastError: string | null = null;
  let failures = 0;
  let generation = 0;
  let timer: NodeJS.Timeout | null = null;

  function isConfigured(): boolean {
    return Boolean(baseUrl && token);
  }

  function clearTimer(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleTick(delayMs: number): void {
    clearTimer();
    timer = setTimeout(() => {
      void runTick();
    }, delayMs);
    timer.unref?.();
  }

  function buildOffer(): HubDeviceOffer | null {
    const relay = options.getRelayConfig();
    if (!relay || !relay.enabled || !relay.publicEndpoint) {
      return null;
    }
    return {
      serverId: options.serverId,
      daemonPublicKeyB64: options.daemonPublicKeyB64,
      endpoint: relay.publicEndpoint,
      useTls: relay.publicUseTls,
    };
  }

  async function callApi<T>(method: string, body: unknown, timeoutMs?: number): Promise<T> {
    return callHubApi<T>({
      baseUrl: baseUrl!,
      method,
      body,
      token: token ?? undefined,
      fetchImpl,
      timeoutMs,
    });
  }

  async function persistHub(
    edit: (hub: NonNullable<PersistedConfig["hub"]>) => PersistedConfig["hub"],
  ): Promise<void> {
    const config = readPersistedConfig(options.paseoHome, { defaultsIfMissing: true });
    savePersistedConfig(options.paseoHome, { ...config, hub: edit(config.hub ?? {}) }, log);
  }

  /** Best-effort unregister; never throws, bounded by a short timeout. */
  async function unregisterDevice(): Promise<void> {
    if (!deviceId || !isConfigured()) return;
    try {
      await callApi("devices.unregister", { deviceId }, UNREGISTER_TIMEOUT_MS);
      log?.info({ deviceId }, "Unregistered device from hub");
    } catch (error) {
      log?.warn({ err: error, deviceId }, "Best-effort hub unregister failed");
    }
  }

  async function runTick(): Promise<void> {
    const tickGeneration = generation;
    if (!isConfigured()) {
      registered = false;
      registeredOffer = null;
      return;
    }

    const offer = buildOffer();
    if (!offer) {
      // Relay disabled: drop the registration so the hub does not list a dead
      // endpoint, then idle until relay is enabled again.
      await handleRelayUnavailable(tickGeneration);
      return;
    }

    try {
      await syncRegistration(offer, tickGeneration);
      if (tickGeneration !== generation) return;
      scheduleTick(heartbeatIntervalMs);
    } catch (error) {
      handleTickFailure(error, tickGeneration);
    }
  }

  async function handleRelayUnavailable(tickGeneration: number): Promise<void> {
    if (registered || deviceId) {
      await unregisterDevice();
      if (tickGeneration !== generation) return;
      registered = false;
      registeredOffer = null;
    }
    scheduleTick(heartbeatIntervalMs);
  }

  async function syncRegistration(offer: HubDeviceOffer, tickGeneration: number): Promise<void> {
    const offerChanged = registeredOffer !== offerToString(offer);
    if (!deviceId || offerChanged) {
      const data = await callApi<{ deviceId: string }>("devices.register", {
        name: deviceName ?? os.hostname(),
        os: process.platform,
        offer,
      });
      if (tickGeneration !== generation) return;
      const nextDeviceId = data?.deviceId;
      if (typeof nextDeviceId !== "string" || nextDeviceId.length === 0) {
        throw new HubApiError("devices.register returned no deviceId", "devices.offer_invalid");
      }
      const deviceIdChanged = deviceId !== null && deviceId !== nextDeviceId;
      deviceId = nextDeviceId;
      await persistHub((hub) => ({ ...hub, deviceId: nextDeviceId }));
      if (tickGeneration !== generation) return;
      registered = true;
      registeredOffer = offerToString(offer);
      lastError = null;
      failures = 0;
      log?.info(
        { deviceId, offerChanged, deviceIdChanged, endpoint: offer.endpoint },
        "Registered device with hub",
      );
      return;
    }

    await callApi("devices.heartbeat", { deviceId, offer });
    if (tickGeneration !== generation) return;
    registered = true;
    lastError = null;
    failures = 0;
  }

  function handleTickFailure(error: unknown, tickGeneration: number): void {
    if (tickGeneration !== generation) return;
    const apiError = error instanceof HubApiError ? error : null;
    lastError = errorToMessage(error);
    if (apiError?.code === "auth.token_invalid") {
      // The token is dead. Stop the loop instead of hammering the hub; the
      // stored credentials stay so the user sees the error and can re-login.
      registered = false;
      registeredOffer = null;
      log?.warn({ err: error }, "Hub token rejected; device registration paused");
      return;
    }
    failures += 1;
    const backoffMs = Math.min(backoffBaseMs * 2 ** (failures - 1), MAX_BACKOFF_MS);
    const delayMs = apiError?.retryAfterMs ? Math.max(apiError.retryAfterMs, backoffMs) : backoffMs;
    log?.warn({ err: error, failures, delayMs }, "Hub registration tick failed; backing off");
    scheduleTick(delayMs);
  }

  return {
    status(): HubAccountStatus {
      return {
        configured: Boolean(baseUrl),
        loggedIn: Boolean(token),
        baseUrl,
        phone,
        deviceName: deviceName ?? os.hostname(),
        deviceId,
        registered,
        relayEnabled: options.getRelayConfig()?.enabled === true,
        lastError,
      };
    },

    async applyCredentials(input) {
      const normalizedBaseUrl = normalizeHubBaseUrl(input.baseUrl);
      if (!normalizedBaseUrl) {
        throw new HubApiError("Hub base URL is invalid", "hub.url_invalid");
      }
      baseUrl = normalizedBaseUrl;
      token = input.token;
      phone = input.phone;
      if (input.deviceName?.trim()) {
        deviceName = input.deviceName.trim();
      }
      registered = false;
      registeredOffer = null;
      deviceId = null;
      lastError = null;
      failures = 0;
      await persistHub((hub) => ({
        ...hub,
        baseUrl: normalizedBaseUrl,
        token: input.token,
        phone: input.phone,
        ...(deviceName ? { deviceName } : {}),
      }));
      log?.info({ baseUrl: normalizedBaseUrl }, "Applied hub credentials");
      generation += 1;
      scheduleTick(0);
    },

    async changePassword(input) {
      if (!isConfigured()) {
        throw new HubApiError("Not signed in to the hub", "auth.unauthorized");
      }
      // The stored token survives a password change; the hub revokes the
      // account's other sessions.
      await callApi("auth.password.change", {
        ...(input.oldPassword ? { oldPassword: input.oldPassword } : {}),
        newPassword: input.newPassword,
      });
      log?.info("Changed hub account password");
    },

    async logout() {
      if (isConfigured()) {
        try {
          await callApi("auth.logout", {});
        } catch (error) {
          log?.warn({ err: error }, "Best-effort hub logout failed");
        }
        await unregisterDevice();
      }
      generation += 1;
      clearTimer();
      registered = false;
      registeredOffer = null;
      deviceId = null;
      token = null;
      phone = null;
      lastError = null;
      failures = 0;
      // Keep baseUrl and deviceName so the next login only needs credentials.
      await persistHub((hub) => ({
        ...hub,
        token: undefined,
        phone: undefined,
        deviceId: undefined,
      }));
    },

    start() {
      if (!isConfigured()) {
        log?.info("Hub account not configured; device registration idle");
        return;
      }
      generation += 1;
      scheduleTick(0);
    },

    async stop() {
      generation += 1;
      clearTimer();
      await unregisterDevice();
      registered = false;
      registeredOffer = null;
    },
  };
}
