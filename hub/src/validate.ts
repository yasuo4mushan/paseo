/**
 * Input validation helpers. All failures throw ApiError, which the server
 * layer converts to `{ok:false, error:{code, message}}` responses.
 */

import type { Offer } from "./types.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const badRequest = (message: string) => new ApiError(400, "bad_request", message);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requireObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function requireString(
  body: Record<string, unknown>,
  field: string,
  opts: { min?: number; max?: number } = {},
): string {
  const value = body[field];
  const min = opts.min ?? 1;
  const max = opts.max ?? 1024;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  if (value.length < min || value.length > max) {
    throw badRequest(`${field} length must be between ${min} and ${max}`);
  }
  return value;
}

export function optionalString(
  body: Record<string, unknown>,
  field: string,
  opts: { max?: number } = {},
): string | undefined {
  const value = body[field];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw badRequest(`${field} must be a string`);
  const max = opts.max ?? 1024;
  if (value.length < 1 || value.length > max) {
    throw badRequest(`${field} length must be between 1 and ${max}`);
  }
  return value;
}

export const USERNAME_RE = /^[a-z0-9_-]{3,32}$/;

export function validateUsername(username: string): string {
  if (!USERNAME_RE.test(username)) {
    throw badRequest("username must be 3-32 chars of [a-z0-9_-]");
  }
  return username;
}

export function validatePassword(password: string): string {
  if (password.length < 8 || password.length > 1024) {
    throw badRequest("password must be 8-1024 chars");
  }
  return password;
}

// ---- offer validation ----------------------------------------------------

/**
 * `host:port` shape: host is a hostname, IPv4, or bracketed IPv6; port is
 * 1-65535. One colon separates them (bracketed IPv6 keeps its inner colons).
 */
export function isValidEndpoint(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > 253 || endpoint.includes(" ")) return false;
  const lastColon = endpoint.lastIndexOf(":");
  if (lastColon <= 0 || lastColon === endpoint.length - 1) return false;
  const host = endpoint.slice(0, lastColon);
  const port = endpoint.slice(lastColon + 1);
  if (!/^[0-9]{1,5}$/.test(port)) return false;
  const portNum = Number.parseInt(port, 10);
  if (portNum < 1 || portNum > 65535) return false;
  if (host.startsWith("[") && host.endsWith("]")) {
    return host.length > 2 && host.slice(1, -1).includes(":");
  }
  return /^[a-zA-Z0-9._-]+$/.test(host);
}

/** Strictly decode base64/base64url (with or without padding), else undefined. */
function decodeBase64Key(encoded: string): Buffer | undefined {
  const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const decoded = Buffer.from(padded, "base64");
  // Buffer.from is lenient with garbage input; a round-trip comparison
  // rejects anything that did not decode from the full string.
  if (decoded.length === 0) return undefined;
  const roundTrip = decoded.toString("base64").replace(/=+$/, "");
  if (roundTrip !== normalized.replace(/=+$/, "")) return undefined;
  return decoded;
}

const offerInvalid = (detail: string) =>
  new ApiError(400, "devices.offer_invalid", `offer invalid: ${detail}`);

function offerString(body: Record<string, unknown>, field: string, max: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw offerInvalid(`${field} must be a 1-${max} char string`);
  }
  return value;
}

export function parseOffer(raw: unknown): Offer {
  if (!isRecord(raw)) throw offerInvalid("offer must be an object");
  const serverId = offerString(raw, "serverId", 256);
  const daemonPublicKeyB64 = offerString(raw, "daemonPublicKeyB64", 128);
  const endpoint = offerString(raw, "endpoint", 253);
  const useTlsRaw = raw.useTls;

  if (useTlsRaw !== undefined && typeof useTlsRaw !== "boolean") {
    throw offerInvalid("useTls must be a boolean");
  }
  if (!isValidEndpoint(endpoint)) {
    throw offerInvalid("endpoint must be host:port with port 1-65535");
  }
  // Strictly decode, then require exactly 32 bytes (libsodium box public key).
  const keyBytes = decodeBase64Key(daemonPublicKeyB64);
  if (!keyBytes) {
    throw offerInvalid("daemonPublicKeyB64 is not valid base64");
  }
  if (keyBytes.length !== 32) {
    throw offerInvalid(`daemonPublicKeyB64 must decode to 32 bytes, got ${keyBytes.length}`);
  }

  const offer: Offer = { serverId, daemonPublicKeyB64, endpoint };
  if (useTlsRaw !== undefined) offer.useTls = useTlsRaw;
  return offer;
}
