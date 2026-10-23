import { describe, expect, test } from "vitest";
import type { HubAccountStatus } from "@getpaseo/protocol/messages";
import { resolveHubOnboardingGate } from "./hub-onboarding-gate";

function status(overrides: Partial<HubAccountStatus> = {}): HubAccountStatus {
  return {
    configured: true,
    loggedIn: false,
    baseUrl: "https://hub.example.cn",
    phone: null,
    deviceName: "mac-studio",
    deviceId: null,
    registered: false,
    relayEnabled: true,
    lastError: null,
    ...overrides,
  };
}

const BASE = {
  platformEligible: true,
  hubSupported: true,
  connected: true,
  dismissedThisSession: false,
  statusWaitExpired: false,
} as const;

describe("resolveHubOnboardingGate (t29)", () => {
  test("not logged in routes to onboarding", () => {
    expect(resolveHubOnboardingGate({ ...BASE, status: status() })).toBe("onboarding");
  });

  test("logged in passes through to the app", () => {
    expect(
      resolveHubOnboardingGate({
        ...BASE,
        status: status({ loggedIn: true, phone: "13800138000" }),
      }),
    ).toBe("pass");
  });

  test("a session skip passes through and re-arms after logout", () => {
    // Skipped this session.
    expect(
      resolveHubOnboardingGate({
        ...BASE,
        status: status(),
        dismissedThisSession: true,
      }),
    ).toBe("pass");
    // Logout clears the dismissal (the store's rearm) — onboarding shows again.
    expect(resolveHubOnboardingGate({ ...BASE, status: status() })).toBe("onboarding");
  });

  test("native platform never gates", () => {
    expect(resolveHubOnboardingGate({ ...BASE, platformEligible: false, status: status() })).toBe(
      "ineligible",
    );
  });

  test("an old host without hubAccountRpc passes through", () => {
    expect(resolveHubOnboardingGate({ ...BASE, hubSupported: false, status: null })).toBe("pass");
  });

  test("pending while host features and status load", () => {
    expect(resolveHubOnboardingGate({ ...BASE, hubSupported: null, status: null })).toBe("pending");
    expect(resolveHubOnboardingGate({ ...BASE, connected: false, status: null })).toBe("pending");
    expect(resolveHubOnboardingGate({ ...BASE, status: null })).toBe("pending");
  });

  test("the bounded status wait expires into pass so startup is never blocked", () => {
    expect(
      resolveHubOnboardingGate({
        ...BASE,
        status: null,
        statusWaitExpired: true,
      }),
    ).toBe("pass");
    expect(
      resolveHubOnboardingGate({
        ...BASE,
        connected: false,
        status: null,
        statusWaitExpired: true,
      }),
    ).toBe("pass");
  });

  test("skip still passes after the wait expired (never traps the user)", () => {
    expect(
      resolveHubOnboardingGate({
        ...BASE,
        status: status(),
        dismissedThisSession: true,
        statusWaitExpired: true,
      }),
    ).toBe("pass");
  });
});
