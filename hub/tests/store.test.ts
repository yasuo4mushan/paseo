import { randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hashPassword, mintSession } from "../src/auth.js";
import { emptyState, HubStore } from "../src/store.js";
import type { Offer } from "../src/types.js";

function tempDbPath(): string {
  // OS temp dirs are cleaned periodically; 0700 keeps the fixture files private.
  const dir = mkdtempSync(path.join(tmpdir(), "aaswitch-store-test-"));
  try {
    chmodSync(dir, 0o700);
  } catch {
    // best effort
  }
  return path.join(dir, "hub.json");
}

function offer(endpoint = "relay.example.com:443"): Offer {
  return {
    serverId: "srv_store",
    daemonPublicKeyB64: randomBytes(32).toString("base64"),
    endpoint,
  };
}

describe("HubStore persistence", () => {
  it("recovers accounts, sessions, and devices in a new instance", async () => {
    const dbPath = tempDbPath();
    const store = new HubStore(dbPath);
    const secret = randomBytes(32);
    await store.addAccount({
      id: "acc_1",
      username: "alice",
      passwordHash: hashPassword("password123"),
      createdAt: new Date().toISOString(),
    });
    const { record } = mintSession(secret, "acc_1", 60_000);
    await store.addSession(record);
    const { persist } = store.upsertDevice("acc_1", { name: "box", os: "darwin", offer: offer() });
    await persist;

    const reopened = new HubStore(dbPath);
    expect(reopened.findAccountByUsername("alice")?.id).toBe("acc_1");
    expect(reopened.findSession(record.id)?.accountId).toBe("acc_1");
    const devices = reopened.listDevicesByAccount("acc_1");
    expect(devices).toHaveLength(1);
    expect(devices[0].offer.endpoint).toBe("relay.example.com:443");
  });

  it("writes atomically: no tmp leftovers, file parses, mode is 0600", async () => {
    const dbPath = tempDbPath();
    const store = new HubStore(dbPath);
    for (let i = 0; i < 5; i++) {
      await store.addAccount({
        id: `acc_${i}`,
        username: `user${i}`,
        passwordHash: hashPassword("password123"),
        createdAt: new Date().toISOString(),
      });
    }
    const dir = path.dirname(dbPath);
    const files = readdirSync(dir);
    expect(files).toEqual(["hub.json"]); // no .tmp- siblings
    expect(() => JSON.parse(readFileSync(dbPath, "utf8"))).not.toThrow();
    expect(statSync(dbPath).mode & 0o777).toBe(0o600);
  });

  it("throws on a corrupted (non-JSON) store file", () => {
    const dbPath = tempDbPath();
    writeFileSync(dbPath, "{not json", { mode: 0o600 });
    expect(() => new HubStore(dbPath)).toThrow();
  });

  it("returns empty state for a missing file", () => {
    const store = new HubStore(tempDbPath());
    expect(store.listDevicesByAccount("acc_x")).toEqual([]);
  });

  it("sweeps expired sessions on reload", async () => {
    const dbPath = tempDbPath();
    const store = new HubStore(dbPath);
    const { record } = mintSession(randomBytes(32), "acc_1", 1); // 1ms ttl
    await store.addSession(record);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reopened = new HubStore(dbPath);
    expect(reopened.findSession(record.id)).toBeUndefined();
  });
});

describe("HubStore.upsertDevice", () => {
  it("is idempotent per (account, name) and keeps the original deviceId", async () => {
    const store = new HubStore(tempDbPath());
    const first = store.upsertDevice("acc_1", {
      name: "box",
      os: "darwin",
      offer: offer("one:443"),
    });
    await first.persist;
    const second = store.upsertDevice("acc_1", {
      name: "box",
      os: "linux",
      offer: offer("two:443"),
    });
    await second.persist;

    expect(second.record.deviceId).toBe(first.record.deviceId);
    expect(second.updated).toBe(true);
    expect(store.listDevicesByAccount("acc_1")).toHaveLength(1);
    expect(store.listDevicesByAccount("acc_1")[0].offer.endpoint).toBe("two:443");
  });

  it("keeps same-name devices from different accounts separate", async () => {
    const store = new HubStore(tempDbPath());
    const a = store.upsertDevice("acc_1", { name: "box", os: "darwin", offer: offer() });
    const b = store.upsertDevice("acc_2", { name: "box", os: "darwin", offer: offer() });
    await Promise.all([a.persist, b.persist]);
    expect(a.record.deviceId).not.toBe(b.record.deviceId);
    expect(store.listDevicesByAccount("acc_1")).toHaveLength(1);
    expect(store.listDevicesByAccount("acc_2")).toHaveLength(1);
  });
});

describe("emptyState", () => {
  it("starts clean with version 1", () => {
    const state = emptyState();
    expect(state.version).toBe(1);
    expect(state.accounts).toEqual([]);
    expect(state.sessions).toEqual([]);
    expect(state.devices).toEqual([]);
  });
});
