import { describe, expect, test } from "vitest";
import {
  hubAccountErrorKey,
  isHubAccountFormSubmittable,
  normalizePhoneInput,
  validateHubAccountForm,
} from "./hub-account-form";

describe("normalizePhoneInput (t29)", () => {
  test("strips separators and +86 / 86 prefixes", () => {
    expect(normalizePhoneInput("138 0013 8000")).toBe("13800138000");
    expect(normalizePhoneInput("138-0013-8000")).toBe("13800138000");
    expect(normalizePhoneInput("(138) 0013 8000")).toBe("13800138000");
    expect(normalizePhoneInput("+8613800138000")).toBe("13800138000");
    expect(normalizePhoneInput("8613800138000")).toBe("13800138000");
    expect(normalizePhoneInput("13800138000")).toBe("13800138000");
  });
});

describe("validateHubAccountForm (t29)", () => {
  test("accepts a valid credentials form", () => {
    const validation = validateHubAccountForm({ phone: "13800138000", password: "secret8ch" });
    expect(validation.phoneError).toBeNull();
    expect(validation.passwordError).toBeNull();
    expect(isHubAccountFormSubmittable({ phone: "13800138000", password: "secret8ch" })).toBe(true);
  });

  test("accepts prefixed phone input after normalization", () => {
    const validation = validateHubAccountForm({
      phone: "+86 138 0013 8000",
      password: "secret8ch",
    });
    expect(validation.phoneError).toBeNull();
  });

  test("rejects blank fields", () => {
    const validation = validateHubAccountForm({ phone: "", password: "" });
    expect(validation.phoneError).toBe("phoneRequired");
    expect(validation.passwordError).toBe("passwordRequired");
    expect(isHubAccountFormSubmittable({ phone: "", password: "" })).toBe(false);
  });

  test("rejects a non-mainland phone shape", () => {
    const validation = validateHubAccountForm({ phone: "12345678901", password: "secret8ch" });
    expect(validation.phoneError).toBe("invalidPhone");
  });

  test("rejects a short password", () => {
    const validation = validateHubAccountForm({ phone: "13800138000", password: "short" });
    expect(validation.passwordError).toBe("passwordTooShort");
    expect(isHubAccountFormSubmittable({ phone: "13800138000", password: "short" })).toBe(false);
  });
});

describe("hubAccountErrorKey (t29, t27 wording parity)", () => {
  const cases: Array<[unknown, string | null]> = [
    [{ code: "auth.invalid_credentials" }, "invalidCredentials"],
    [{ code: "auth.invalid_phone" }, "invalidPhone"],
    [{ code: "auth.invalid_password" }, "passwordTooShort"],
    [{ code: "auth.phone_taken" }, "phoneTaken"],
    [{ code: "auth.unauthorized" }, "sessionExpired"],
    [{ code: "auth.token_invalid" }, "sessionExpired"],
    [{ code: "rate_limited" }, "rateLimited"],
    [{ code: "hub.rate_limited" }, "rateLimited"],
    [{ code: "hub.invalid_request" }, "invalidRequest"],
    [{ code: "hub.internal_error" }, "internalError"],
    [{ code: "hub.url_invalid" }, "urlInvalid"],
    [{ code: "auth.wx_upstream" }, "wxUnavailable"],
    [{ code: "something_new" }, null],
    [new Error("plain failure"), null],
    ["not an error object", null],
  ];

  test.each(cases)("maps %j to %s", (error, expected) => {
    expect(hubAccountErrorKey(error)).toBe(expected);
  });

  test("reads the code off a thrown DaemonRpcError-shaped error", () => {
    const rpcError = Object.assign(new Error("bad credentials code=auth.invalid_credentials"), {
      code: "auth.invalid_credentials",
    });
    expect(hubAccountErrorKey(rpcError)).toBe("invalidCredentials");
  });
});
