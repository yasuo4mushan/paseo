import { describe, expect, it } from "vitest";
import { resolveHostAccountPageState } from "./host-account-page-state";

describe("resolveHostAccountPageState", () => {
  const base = {
    hostExists: true,
    supported: true,
    connected: true,
  };

  it.each([
    ["hostMissing", { ...base, hostExists: false, status: null }],
    ["unsupported", { ...base, supported: false, status: null }],
    ["disconnected", { ...base, connected: false, status: null }],
    ["loading", { ...base, status: null }],
    ["signedIn", { ...base, status: { loggedIn: true } }],
    ["signedOut", { ...base, status: { loggedIn: false } }],
  ] as const)("resolves %s", (expected, input) => {
    expect(resolveHostAccountPageState(input)).toBe(expected);
  });

  it("never renders a credentials form: logged-out is signedOut, not a login state", () => {
    // t30: the signed-out card links into /onboarding; there is no form state.
    expect(resolveHostAccountPageState({ ...base, status: { loggedIn: false } })).toBe("signedOut");
  });
});
