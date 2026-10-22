/**
 * Password hashing (scrypt) and bearer-token minting.
 *
 * Tokens are `<sessionId>.<key>`: sessionId is a random selector stored in the
 * clear on the session row, key is a random 32-byte secret. Only
 * HMAC-SHA256(HUB_TOKEN_SECRET, key) is stored, so the database alone cannot
 * reconstruct a usable token and sessions stay revocable by row deletion.
 */

import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import type { SessionRecord } from "./types.js";

// scrypt N=16384, r=8, p=1 (16 MiB memory), 16-byte salt, 64-byte key.
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "scrypt",
    SCRYPT_N,
    SCRYPT_R,
    SCRYPT_P,
    SCRYPT_KEYLEN,
    salt.toString("base64"),
    hash.toString("base64"),
  ].join("$");
}

export function verifyPassword(password: string, encoded: string): boolean {
  const parts = encoded.split("$");
  if (parts.length !== 7 || parts[0] !== "scrypt") return false;
  const n = Number.parseInt(parts[1] ?? "", 10);
  const r = Number.parseInt(parts[2] ?? "", 10);
  const p = Number.parseInt(parts[3] ?? "", 10);
  const keylen = Number.parseInt(parts[4] ?? "", 10);
  if (
    !Number.isFinite(n) ||
    !Number.isFinite(r) ||
    !Number.isFinite(p) ||
    !Number.isFinite(keylen)
  ) {
    return false;
  }
  const salt = Buffer.from(parts[5] ?? "", "base64");
  const expected = Buffer.from(parts[6] ?? "", "base64");
  if (n < 1 || r < 1 || p < 1 || keylen < 1 || expected.length !== keylen) return false;
  const actual = scryptSync(password, salt, keylen, { N: n, r, p, maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(actual, expected);
}

export function sessionKeyHash(tokenSecret: Buffer, key: string): string {
  return createHmac("sha256", tokenSecret).update(key, "utf8").digest("hex");
}

export function mintSession(
  tokenSecret: Buffer,
  accountId: string,
  ttlMs: number,
): { token: string; record: SessionRecord } {
  const sessionId = randomBytes(12).toString("base64url");
  const key = randomBytes(32).toString("base64url");
  const now = new Date();
  const record: SessionRecord = {
    id: sessionId,
    keyHash: sessionKeyHash(tokenSecret, key),
    accountId,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
  };
  return { token: `${sessionId}.${key}`, record };
}

/** Split a bearer token into its session-id and key halves. */
export function parseToken(token: string): { sessionId: string; key: string } | undefined {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return undefined;
  return { sessionId: token.slice(0, dot), key: token.slice(dot + 1) };
}

/** Constant-time comparison of a computed HMAC against the stored hex digest. */
export function keyHashMatches(tokenSecret: Buffer, key: string, storedHex: string): boolean {
  const actual = Buffer.from(sessionKeyHash(tokenSecret, key), "hex");
  let expected: Buffer;
  try {
    expected = Buffer.from(storedHex, "hex");
  } catch {
    return false;
  }
  if (actual.length !== expected.length || actual.length === 0) return false;
  return timingSafeEqual(actual, expected);
}
