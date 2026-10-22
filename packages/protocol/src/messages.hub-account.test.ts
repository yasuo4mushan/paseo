import { describe, expect, test } from "vitest";

import {
  HubAccountLoginRequestSchema,
  HubAccountLoginResponseSchema,
  HubAccountLogoutRequestSchema,
  HubAccountLogoutResponseSchema,
  HubAccountRegisterRequestSchema,
  HubAccountRegisterResponseSchema,
  HubAccountStatusRequestSchema,
  HubAccountStatusResponseSchema,
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
          username: "alice",
          deviceName: "mac-studio",
          deviceId: "dev-1",
          registered: true,
          relayEnabled: true,
          lastError: null,
        },
      },
    });
    expect(response.payload.status.deviceId).toBe("dev-1");
  });

  test("parses login and register requests", () => {
    expect(
      HubAccountLoginRequestSchema.parse({
        type: "hub.login.request",
        requestId: "req-2",
        baseUrl: "http://hub.example.cn",
        username: "alice",
        password: "secret",
      }),
    ).toMatchObject({ type: "hub.login.request", username: "alice" });

    expect(
      HubAccountRegisterRequestSchema.parse({
        type: "hub.register.request",
        requestId: "req-3",
        baseUrl: "http://hub.example.cn",
        username: "alice",
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
        username: "alice",
        password: "secret",
      }).success,
    ).toBe(true);

    // baseUrl stays optional on both: the zero-config flow sends credentials
    // only and lets the daemon use its resolved hub address.
    expect(
      HubAccountLoginRequestSchema.safeParse({
        type: "hub.login.request",
        requestId: "req-3c",
        username: "alice",
        password: "secret",
      }).success,
    ).toBe(true);
    expect(
      HubAccountRegisterRequestSchema.safeParse({
        type: "hub.register.request",
        requestId: "req-3d",
        username: "alice",
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
        username: "alice",
        password: "",
      }).success,
    ).toBe(false);
  });

  test("parses login, register, and logout responses", () => {
    expect(
      HubAccountLoginResponseSchema.parse({
        type: "hub.login.response",
        payload: { requestId: "req-5", accountId: "acc-1", username: "alice" },
      }).payload.accountId,
    ).toBe("acc-1");
    expect(
      HubAccountRegisterResponseSchema.parse({
        type: "hub.register.response",
        payload: { requestId: "req-6", accountId: "acc-1", username: "alice" },
      }).payload.username,
    ).toBe("alice");
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
