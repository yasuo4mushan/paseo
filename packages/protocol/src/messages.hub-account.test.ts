import { describe, expect, test } from "vitest";

import {
  HubAccountLoginRequestSchema,
  HubAccountLoginResponseSchema,
  HubAccountLogoutRequestSchema,
  HubAccountLogoutResponseSchema,
  HubAccountPasswordChangeRequestSchema,
  HubAccountPasswordChangeResponseSchema,
  HubAccountRegisterRequestSchema,
  HubAccountRegisterResponseSchema,
  HubAccountStatusRequestSchema,
  HubAccountStatusResponseSchema,
  HubDeviceNameSetRequestSchema,
  HubDeviceNameSetResponseSchema,
  ServerInfoStatusPayloadSchema,
} from "./messages.js";

describe("hub account RPC schemas", () => {
  test("parses a status request and response", () => {
    expect(
      HubAccountStatusRequestSchema.parse({ type: "hub.status.request", requestId: "req-1" }),
    ).toEqual({ type: "hub.status.request", requestId: "req-1" });

    const response = HubAccountStatusResponseSchema.parse({
      type: "hub.status.response",
      payload: {
        requestId: "req-1",
        status: {
          configured: true,
          loggedIn: true,
          baseUrl: "http://hub.example.cn",
          phone: "13800138000",
          deviceName: "mac-studio",
          deviceId: "dev-1",
          registered: true,
          relayEnabled: true,
          lastError: null,
        },
      },
    });
    expect(response.payload.status.deviceId).toBe("dev-1");
    expect(response.payload.status.phone).toBe("13800138000");
  });

  test("parses login and register requests", () => {
    expect(
      HubAccountLoginRequestSchema.parse({
        type: "hub.login.request",
        requestId: "req-2",
        baseUrl: "http://hub.example.cn",
        phone: "13800138000",
        password: "secret",
      }),
    ).toMatchObject({ type: "hub.login.request", phone: "13800138000" });

    expect(
      HubAccountRegisterRequestSchema.parse({
        type: "hub.register.request",
        requestId: "req-3",
        baseUrl: "http://hub.example.cn",
        phone: "13800138000",
        password: "secret",
        deviceName: "mac-studio",
      }),
    ).toMatchObject({ deviceName: "mac-studio" });

    // deviceName stays optional.
    expect(
      HubAccountRegisterRequestSchema.safeParse({
        type: "hub.register.request",
        requestId: "req-3b",
        baseUrl: "http://hub.example.cn",
        phone: "13800138000",
        password: "secret",
      }).success,
    ).toBe(true);

    // baseUrl stays optional on both: the zero-config flow sends credentials
    // only and lets the daemon use its resolved hub address.
    expect(
      HubAccountLoginRequestSchema.safeParse({
        type: "hub.login.request",
        requestId: "req-3c",
        phone: "13800138000",
        password: "secret",
      }).success,
    ).toBe(true);
    expect(
      HubAccountRegisterRequestSchema.safeParse({
        type: "hub.register.request",
        requestId: "req-3d",
        phone: "13800138000",
        password: "secret",
      }).success,
    ).toBe(true);
  });

  test("rejects a login request with an empty password", () => {
    expect(
      HubAccountLoginRequestSchema.safeParse({
        type: "hub.login.request",
        requestId: "req-4",
        baseUrl: "http://hub.example.cn",
        phone: "13800138000",
        password: "",
      }).success,
    ).toBe(false);
  });

  test("rejects a legacy username request — the hub is phone-only (t27)", () => {
    // An old client sending `username` fails validation; the daemon surfaces
    // that as an rpc_error. This is the intended understandable failure.
    expect(
      HubAccountLoginRequestSchema.safeParse({
        type: "hub.login.request",
        requestId: "req-4b",
        username: "alice",
        password: "secret",
      }).success,
    ).toBe(false);
  });

  test("parses login, register, and logout responses", () => {
    expect(
      HubAccountLoginResponseSchema.parse({
        type: "hub.login.response",
        payload: { requestId: "req-5", accountId: "acc-1", phone: "13800138000" },
      }).payload.accountId,
    ).toBe("acc-1");
    expect(
      HubAccountRegisterResponseSchema.parse({
        type: "hub.register.response",
        payload: { requestId: "req-6", accountId: "acc-1", phone: "13800138000" },
      }).payload.phone,
    ).toBe("13800138000");
    expect(
      HubAccountLogoutResponseSchema.parse({
        type: "hub.logout.response",
        payload: { requestId: "req-7" },
      }).payload.requestId,
    ).toBe("req-7");
    expect(
      HubAccountLogoutRequestSchema.parse({ type: "hub.logout.request", requestId: "req-7" })
        .requestId,
    ).toBe("req-7");
  });

  test("parses password change requests and responses", () => {
    // With old password (regular accounts).
    expect(
      HubAccountPasswordChangeRequestSchema.parse({
        type: "hub.password.change.request",
        requestId: "req-8",
        oldPassword: "old-secret",
        newPassword: "new-secret",
      }),
    ).toMatchObject({ oldPassword: "old-secret", newPassword: "new-secret" });

    // Without old password (WeChat one-click accounts that never set one).
    const parsed = HubAccountPasswordChangeRequestSchema.parse({
      type: "hub.password.change.request",
      requestId: "req-8b",
      newPassword: "new-secret",
    });
    expect(parsed.oldPassword).toBeUndefined();
    expect(parsed.newPassword).toBe("new-secret");

    // newPassword is required.
    expect(
      HubAccountPasswordChangeRequestSchema.safeParse({
        type: "hub.password.change.request",
        requestId: "req-8c",
      }).success,
    ).toBe(false);

    expect(
      HubAccountPasswordChangeResponseSchema.parse({
        type: "hub.password.change.response",
        payload: { requestId: "req-9" },
      }).payload.requestId,
    ).toBe("req-9");
  });

  test("parses device name set requests and responses (t29)", () => {
    expect(
      HubDeviceNameSetRequestSchema.parse({
        type: "hub.device.name.set.request",
        requestId: "req-10",
        name: "mac-studio",
      }),
    ).toMatchObject({ type: "hub.device.name.set.request", name: "mac-studio" });

    // name is required and cannot be empty.
    expect(
      HubDeviceNameSetRequestSchema.safeParse({
        type: "hub.device.name.set.request",
        requestId: "req-10b",
        name: "",
      }).success,
    ).toBe(false);
    expect(
      HubDeviceNameSetRequestSchema.safeParse({
        type: "hub.device.name.set.request",
        requestId: "req-10c",
      }).success,
    ).toBe(false);

    expect(
      HubDeviceNameSetResponseSchema.parse({
        type: "hub.device.name.set.response",
        payload: {
          requestId: "req-11",
          status: {
            configured: true,
            loggedIn: true,
            baseUrl: "http://hub.example.cn",
            phone: "13800138000",
            deviceName: "renamed-mac",
            deviceId: "dev-1",
            registered: true,
            relayEnabled: true,
            lastError: null,
          },
        },
      }).payload.status.deviceName,
    ).toBe("renamed-mac");
  });

  test("server_info features accept the hubAccountRpc gate", () => {
    const base = {
      status: "server_info" as const,
      serverId: "srv-1",
      features: {} as Record<string, unknown>,
    };
    expect(
      ServerInfoStatusPayloadSchema.safeParse({ ...base, features: { hubAccountRpc: true } })
        .success,
    ).toBe(true);
    expect(ServerInfoStatusPayloadSchema.safeParse(base).success).toBe(true);
    expect(
      ServerInfoStatusPayloadSchema.parse({ ...base, features: { hubAccountRpc: true } }).features
        ?.hubAccountRpc,
    ).toBe(true);
  });
});
