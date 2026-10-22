/**
 * Wire/data shapes shared across the hub.
 *
 * The hub is a discovery service: it stores accounts, device registrations,
 * and relay connection offers. It never sees end-to-end encrypted payloads —
 * those flow daemon <-> client through the relay as ciphertext.
 */

/** Relay pairing offer, flattened from the daemon's ConnectionOfferV2. */
export interface Offer {
  /** Stable daemon identifier (`srv_<base64url>`), also the relay session id. */
  serverId: string;
  /** Daemon libsodium box public key, base64. Used by clients for E2EE. */
  daemonPublicKeyB64: string;
  /** Relay endpoint, `host:port` form (e.g. `relay.paseo.sh:443`). */
  endpoint: string;
  /** Whether the relay endpoint requires TLS. */
  useTls?: boolean;
}

export interface AccountRecord {
  /** `acc_<base64url>`. Public API exposes this as `account.id`. */
  id: string;
  username: string;
  /**
   * `scrypt$N$r$p$keylen$saltB64$hashB64` — the salt is embedded in the
   * encoding, so no separate salt column exists. Never the plaintext password.
   */
  passwordHash: string;
  createdAt: string;
}

/**
 * Server-side session row. The bearer token is `<sessionId>.<key>`; only
 * `keyHash = HMAC-SHA256(HUB_TOKEN_SECRET, key)` is stored, so a leaked
 * database cannot recover usable tokens.
 */
export interface SessionRecord {
  id: string;
  keyHash: string;
  accountId: string;
  createdAt: string;
  expiresAt: string;
}

export interface DeviceRecord {
  /** `dev_<base64url>`. */
  deviceId: string;
  accountId: string;
  /** Unique per account: re-registering the same name updates the record. */
  name: string;
  os: string;
  agent?: string;
  offer: Offer;
  createdAt: string;
  updatedAt: string;
  lastSeenAt: string;
}

export interface HubState {
  version: 1;
  accounts: AccountRecord[];
  sessions: SessionRecord[];
  devices: DeviceRecord[];
}

export interface AccountPublic {
  id: string;
  username: string;
  createdAt: string;
}

export interface DevicePublic {
  deviceId: string;
  name: string;
  os: string;
  agent?: string;
  offer: Offer;
  /** lastSeenAt is within the online TTL window. */
  online: boolean;
  lastSeenAt: string;
  createdAt: string;
  updatedAt: string;
}
