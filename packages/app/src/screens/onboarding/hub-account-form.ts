/**
 * t29 onboarding login/register form view-model: client-side validation, phone
 * normalization, and hub error-code → i18n key mapping. The wording parity is
 * with the miniprogram's t27 mapping (`miniprogram/src/hub/hub-client.ts`) —
 * the zh-CN resources carry the same Chinese copy.
 */

export interface HubAccountFormValues {
  phone: string;
  password: string;
}

export interface HubAccountFormValidation {
  /** i18n key under `hubOnboarding.errors` for the phone field, or null. */
  phoneError: string | null;
  /** i18n key under `hubOnboarding.errors` for the password field, or null. */
  passwordError: string | null;
}

/** Mainland China phone number: 11 digits starting 1[3-9] (same rule as the hub). */
export const CHINA_PHONE_PATTERN = /^1[3-9]\d{9}$/;

/** Strips spaces, dashes, and parentheses; accepts +86 / 86 prefixes. */
export function normalizePhoneInput(input: string): string {
  const compact = input.replace(/[\s\-()]/g, "");
  if (compact.startsWith("+86")) return compact.slice(3);
  if (compact.startsWith("86") && compact.length === 13) return compact.slice(2);
  return compact;
}

function resolvePhoneError(phone: string): string | null {
  if (!phone) return "phoneRequired";
  return CHINA_PHONE_PATTERN.test(phone) ? null : "invalidPhone";
}

function resolvePasswordError(password: string): string | null {
  if (!password) return "passwordRequired";
  return password.length < 8 ? "passwordTooShort" : null;
}

export function validateHubAccountForm(values: HubAccountFormValues): HubAccountFormValidation {
  return {
    phoneError: resolvePhoneError(normalizePhoneInput(values.phone)),
    passwordError: resolvePasswordError(values.password),
  };
}

export function isHubAccountFormSubmittable(values: HubAccountFormValues): boolean {
  const validation = validateHubAccountForm(values);
  return validation.phoneError === null && validation.passwordError === null;
}

/** Keys under `hubOnboarding.errors` used for hub rpc_error codes. */
const RPC_ERROR_KEYS: Record<string, string> = {
  "auth.invalid_credentials": "invalidCredentials",
  "auth.invalid_phone": "invalidPhone",
  "auth.invalid_password": "passwordTooShort",
  "auth.phone_taken": "phoneTaken",
  "auth.unauthorized": "sessionExpired",
  "auth.token_invalid": "sessionExpired",
  "auth.wx_disabled": "wxUnavailable",
  "auth.wx_code_invalid": "wxUnavailable",
  "auth.wx_upstream": "wxUnavailable",
  rate_limited: "rateLimited",
  "hub.rate_limited": "rateLimited",
  "hub.invalid_request": "invalidRequest",
  "hub.internal_error": "internalError",
  "hub.url_invalid": "urlInvalid",
};

/** The wire error code carried by DaemonRpcError (`payload.code`), if any. */
export function getHubRpcErrorCode(error: unknown): string | null {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return null;
}

/**
 * Resolves the i18n key (under `hubOnboarding.errors`) for a hub RPC error, or
 * null when no mapping exists — callers then fall back to the raw message.
 */
export function hubAccountErrorKey(error: unknown): string | null {
  const code = getHubRpcErrorCode(error);
  if (code === null) return null;
  const key = RPC_ERROR_KEYS[code];
  return key === undefined ? null : key;
}
