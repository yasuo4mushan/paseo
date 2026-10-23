/**
 * Method dispatch. Every method is `POST /<method>` (or `/api/<method>` behind
 * the nginx strip prefix) with a JSON body; responses use the envelope
 * `{ok:true, data}` or `{ok:false, error:{code, message}}`.
 *
 * Method naming follows the repo's dotted-namespace convention
 * (docs/rpc-namespacing.md), adapted to request/response-over-HTTP.
 */

import { randomBytes } from "node:crypto";
import { hashPassword, keyHashMatches, mintSession, parseToken, verifyPassword } from "./auth.js";
import type { HubConfig } from "./config.js";
import { logInfo } from "./log.js";
import { RateLimiter } from "./rate-limit.js";
import type { HubStore } from "./store.js";
import type { AccountPublic, AccountRecord, DevicePublic } from "./types.js";
import { WxPhoneService } from "./wx.js";
import {
  ApiError,
  normalizePhone,
  parseOffer,
  requireObject,
  requireString,
  validatePassword,
} from "./validate.js";

export interface ApiContext {
  store: HubStore;
  config: HubConfig;
  limiter: RateLimiter;
  /** Present only when HUB_WXA_APPID + HUB_WXA_SECRET are configured. */
  wx: WxPhoneService | undefined;
}

interface AuthContext {
  accountId: string;
  /** Session row id, so auth.logout can revoke exactly this session. */
  sessionId: string;
}

export interface MethodDef {
  /** Requires a valid bearer token. */
  auth: boolean;
  /** Counted against the credential rate limit (10/IP/min). */
  credentialed?: boolean;
  handler: (ctx: ApiContext, body: unknown, auth: AuthContext | null) => Promise<unknown> | unknown;
}

function accountPublic(
  account: Pick<AccountRecord, "id" | "phone" | "createdAt" | "passwordSet">,
): AccountPublic {
  return {
    id: account.id,
    phone: account.phone,
    createdAt: account.createdAt,
    passwordSet: account.passwordSet ?? true,
  };
}

function devicePublic(
  device: {
    deviceId: string;
    name: string;
    os: string;
    agent?: string;
    offer: DevicePublic["offer"];
    lastSeenAt: string;
    createdAt: string;
    updatedAt: string;
  },
  onlineTtlMs: number,
): DevicePublic {
  return {
    deviceId: device.deviceId,
    name: device.name,
    os: device.os,
    ...(device.agent !== undefined ? { agent: device.agent } : {}),
    offer: device.offer,
    online: Date.now() - Date.parse(device.lastSeenAt) < onlineTtlMs,
    lastSeenAt: device.lastSeenAt,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

/** Resolve a bearer token to an account id, or null. Sweeps expired rows. */
export function authenticate(ctx: ApiContext, bearer: string | undefined): AuthContext | null {
  if (!bearer) return null;
  const parsed = parseToken(bearer);
  if (!parsed) return null;
  const session = ctx.store.findSession(parsed.sessionId);
  if (!session) return null;
  if (Date.parse(session.expiresAt) <= Date.now()) {
    void ctx.store.removeSession(session.id);
    return null;
  }
  if (!keyHashMatches(ctx.config.tokenSecret, parsed.key, session.keyHash)) return null;
  return { accountId: session.accountId, sessionId: session.id };
}

export const methods: Record<string, MethodDef> = {
  // ---- auth --------------------------------------------------------------

  "auth.register": {
    auth: false,
    credentialed: true,
    handler: async (ctx, raw) => {
      const body = requireObject(raw, "body");
      const phone = normalizePhone(requireString(body, "phone", { max: 32 }));
      const password = validatePassword(requireString(body, "password", { max: 1024 }));
      if (ctx.store.findAccountByPhone(phone)) {
        throw new ApiError(409, "auth.phone_taken", "phone number is already registered");
      }
      const account = {
        id: `acc_${randomBytes(12).toString("base64url")}`,
        phone,
        passwordHash: hashPassword(password),
        passwordSet: true,
        createdAt: new Date().toISOString(),
      };
      await ctx.store.addAccount(account);
      logInfo("account_register", { accountId: account.id });
      return { account: accountPublic(account) };
    },
  },

  "auth.login": {
    auth: false,
    credentialed: true,
    handler: async (ctx, raw) => {
      const body = requireObject(raw, "body");
      const phone = normalizePhone(requireString(body, "phone", { max: 32 }));
      const password = requireString(body, "password", { max: 1024 });
      const account = ctx.store.findAccountByPhone(phone);
      // Same error for unknown phone and wrong password: no phone probing.
      if (!account || !verifyPassword(password, account.passwordHash)) {
        throw new ApiError(401, "auth.invalid_credentials", "invalid phone or password");
      }
      const { token, record } = mintSession(
        ctx.config.tokenSecret,
        account.id,
        ctx.config.tokenTtlMs,
      );
      await ctx.store.addSession(record);
      logInfo("account_login", { accountId: account.id });
      return { token, account: accountPublic(account) };
    },
  },

  /**
   * Set a new password. The current session survives; every other session of
   * the account is revoked. For wx-phone-created accounts (no password set
   * yet) `oldPassword` is not required — token possession proves phone
   * ownership there.
   */
  "auth.password.change": {
    auth: true,
    handler: async (ctx, raw, auth) => {
      const body = requireObject(raw, "body");
      const account = ctx.store.findAccountById(auth!.accountId);
      if (!account) throw new ApiError(401, "auth.token_invalid", "account no longer exists");
      const newPassword = validatePassword(requireString(body, "newPassword", { max: 1024 }));
      if (account.passwordSet !== false) {
        const oldPassword = requireString(body, "oldPassword", { max: 1024 });
        if (!verifyPassword(oldPassword, account.passwordHash)) {
          throw new ApiError(401, "auth.invalid_credentials", "old password is incorrect");
        }
      }
      await ctx.store.setAccountPassword(account, hashPassword(newPassword));
      await ctx.store.revokeSessionsExcept(auth!.accountId, auth!.sessionId);
      logInfo("account_password_change", { accountId: auth!.accountId });
      return { ok: true };
    },
  },

  /**
   * WeChat mini-program one-click phone login. `code` is the dynamic token
   * from the `open-type="getPhoneNumber"` button (NOT a wx.login code): valid
   * 5 minutes, single use. The hub exchanges it with WeChat for the phone
   * number, then finds or creates the account (random password placeholder
   * until the user sets one via auth.password.change).
   */
  "auth.wx-phone": {
    auth: false,
    credentialed: true,
    handler: async (ctx, raw) => {
      if (!ctx.wx) {
        throw new ApiError(
          501,
          "auth.wx_disabled",
          "WeChat login is not configured (set HUB_WXA_APPID and HUB_WXA_SECRET)",
        );
      }
      const body = requireObject(raw, "body");
      const code = requireString(body, "code", { max: 512 });
      const phone = await ctx.wx.getPhoneNumber(code);
      let account = ctx.store.findAccountByPhone(phone);
      let created = false;
      if (!account) {
        account = {
          id: `acc_${randomBytes(12).toString("base64url")}`,
          phone,
          // Unknowable placeholder: password login stays impossible until the
          // user sets a real password through auth.password.change.
          passwordHash: hashPassword(randomBytes(24).toString("base64url")),
          passwordSet: false,
          createdAt: new Date().toISOString(),
        };
        await ctx.store.addAccount(account);
        created = true;
      }
      const { token, record } = mintSession(
        ctx.config.tokenSecret,
        account.id,
        ctx.config.tokenTtlMs,
      );
      await ctx.store.addSession(record);
      logInfo("wx_phone_login", { accountId: account.id, created });
      return { token, account: accountPublic(account), phone };
    },
  },

  "auth.logout": {
    auth: true,
    handler: async (ctx, _raw, auth) => {
      await ctx.store.removeSession(auth!.sessionId);
      logInfo("account_logout", { accountId: auth!.accountId });
      return { ok: true };
    },
  },

  "auth.me": {
    auth: true,
    handler: (ctx, _raw, auth) => {
      const account = ctx.store.findAccountById(auth!.accountId);
      if (!account) throw new ApiError(401, "auth.token_invalid", "account no longer exists");
      return { account: accountPublic(account) };
    },
  },

  // ---- devices -----------------------------------------------------------

  "devices.register": {
    auth: true,
    handler: async (ctx, raw, auth) => {
      const body = requireObject(raw, "body");
      const name = requireString(body, "name", { max: 128 });
      const os = requireString(body, "os", { max: 64 });
      const agent =
        body.agent === undefined ? undefined : requireString(body, "agent", { max: 64 });
      const offer = parseOffer(body.offer);
      const { record, updated, persist } = ctx.store.upsertDevice(auth!.accountId, {
        name,
        os,
        agent,
        offer,
      });
      await persist;
      logInfo("device_register", {
        accountId: auth!.accountId,
        deviceId: record.deviceId,
        updated,
      });
      return { deviceId: record.deviceId, updated };
    },
  },

  "devices.heartbeat": {
    auth: true,
    handler: async (ctx, raw, auth) => {
      const body = requireObject(raw, "body");
      const deviceId = requireString(body, "deviceId", { max: 64 });
      const offer = body.offer === undefined ? undefined : parseOffer(body.offer);
      const account = auth!.accountId;
      const existing = ctx.store.findDevice(deviceId);
      if (!existing || existing.accountId !== account) {
        throw new ApiError(404, "not_found", "device not found");
      }
      const touched = ctx.store.touchDevice(deviceId, offer);
      if (!touched) throw new ApiError(404, "not_found", "device not found");
      await touched.persist;
      return { ok: true };
    },
  },

  "devices.unregister": {
    auth: true,
    handler: async (ctx, raw, auth) => {
      const body = requireObject(raw, "body");
      const deviceId = requireString(body, "deviceId", { max: 64 });
      const existing = ctx.store.findDevice(deviceId);
      if (!existing || existing.accountId !== auth!.accountId) {
        throw new ApiError(404, "not_found", "device not found");
      }
      await ctx.store.removeDevice(deviceId);
      logInfo("device_unregister", { accountId: auth!.accountId, deviceId });
      return { ok: true };
    },
  },

  "devices.list": {
    auth: true,
    handler: (ctx, _raw, auth) => {
      const devices = ctx.store
        .listDevicesByAccount(auth!.accountId)
        .map((d) => devicePublic(d, ctx.config.onlineTtlMs));
      return { devices };
    },
  },
};

export interface DispatchResult {
  status: number;
  body: { ok: true; data: unknown } | { ok: false; error: { code: string; message: string } };
  retryAfterSec?: number;
}

export const METHOD_NOT_FOUND = new ApiError(404, "not_found", "unknown method");

/**
 * Run one API call. Rate limiting for credentialed methods is enforced here so
 * every entry point shares it.
 */
export async function dispatch(
  ctx: ApiContext,
  method: string,
  rawBody: unknown,
  bearer: string | undefined,
  clientIp: string,
): Promise<DispatchResult> {
  const def = methods[method];
  if (!def) throw METHOD_NOT_FOUND;

  if (def.credentialed) {
    const decision = ctx.limiter.take(clientIp);
    if (!decision.allowed) {
      return {
        status: 429,
        body: {
          ok: false,
          error: { code: "rate_limited", message: "too many requests, retry later" },
        },
        retryAfterSec: decision.retryAfterSec,
      };
    }
  }

  const auth = def.auth ? authenticate(ctx, bearer) : null;
  if (def.auth && !auth) {
    throw new ApiError(401, "auth.token_invalid", "missing, invalid, or expired token");
  }

  const data = await def.handler(ctx, rawBody, auth);
  return { status: 200, body: { ok: true, data } };
}
