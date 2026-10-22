/**
 * JSON file store with atomic writes.
 *
 * State mutates synchronously in memory (single-threaded process, so mutations
 * never interleave); every mutation is followed by `persist()`, which chains
 * writes so exactly one write is in flight. Each write goes to a temp file in
 * the target directory, fsyncs, then renames into place — a crash leaves either
 * the old or the new file, never a half-written one.
 *
 * The store file is created with mode 0600 and re-chmodded on load.
 */

import { randomBytes } from "node:crypto";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { AccountRecord, DeviceRecord, HubState, Offer, SessionRecord } from "./types.js";

export function emptyState(): HubState {
  return { version: 1, accounts: [], sessions: [], devices: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defensive parse: tolerate hand-edited or partially-shaped files. */
function parseState(raw: string): HubState {
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed)) throw new Error("store file is not a JSON object");
  const state = emptyState();
  for (const account of Array.isArray(parsed.accounts) ? parsed.accounts : []) {
    if (isRecord(account) && typeof account.id === "string") {
      state.accounts.push(account as unknown as AccountRecord);
    }
  }
  for (const session of Array.isArray(parsed.sessions) ? parsed.sessions : []) {
    if (isRecord(session) && typeof session.id === "string") {
      state.sessions.push(session as unknown as SessionRecord);
    }
  }
  for (const device of Array.isArray(parsed.devices) ? parsed.devices : []) {
    if (isRecord(device) && typeof device.deviceId === "string") {
      state.devices.push(device as unknown as DeviceRecord);
    }
  }
  return state;
}

export class HubStore {
  private state: HubState;
  private writeChain: Promise<void> = Promise.resolve();
  private dirEnsured = false;

  constructor(readonly dbPath: string) {
    this.state = this.load();
    this.sweepExpiredSessions();
  }

  private load(): HubState {
    let raw: string;
    try {
      raw = fsSync.readFileSync(this.dbPath, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
      throw err;
    }
    const state = parseState(raw);
    // Best effort: tighten permissions if the file was created elsewhere.
    try {
      fsSync.chmodSync(this.dbPath, 0o600);
    } catch {
      // chmod is a hardening nicety, not a correctness requirement
    }
    return state;
  }

  /** Drop expired sessions. Runs at load, on auth hits, and on a timer. */
  sweepExpiredSessions(): void {
    const now = Date.now();
    const before = this.state.sessions.length;
    this.state.sessions = this.state.sessions.filter((s) => Date.parse(s.expiresAt) > now);
    if (this.state.sessions.length !== before) {
      void this.persist();
    }
  }

  // ---- reads -------------------------------------------------------------

  findAccountByUsername(username: string): AccountRecord | undefined {
    return this.state.accounts.find((a) => a.username === username);
  }

  findAccountById(id: string): AccountRecord | undefined {
    return this.state.accounts.find((a) => a.id === id);
  }

  findSession(id: string): SessionRecord | undefined {
    return this.state.sessions.find((s) => s.id === id);
  }

  findDevice(deviceId: string): DeviceRecord | undefined {
    return this.state.devices.find((d) => d.deviceId === deviceId);
  }

  listDevicesByAccount(accountId: string): DeviceRecord[] {
    return this.state.devices
      .filter((d) => d.accountId === accountId)
      .sort(
        (a, b) => a.createdAt.localeCompare(b.createdAt) || a.deviceId.localeCompare(b.deviceId),
      );
  }

  // ---- mutations ---------------------------------------------------------
  // Each mutates in memory synchronously and returns the persist promise so
  // callers can await durability before responding.

  addAccount(record: AccountRecord): Promise<void> {
    this.state.accounts.push(record);
    return this.persist();
  }

  addSession(record: SessionRecord): Promise<void> {
    this.state.sessions.push(record);
    return this.persist();
  }

  removeSession(id: string): Promise<void> {
    this.state.sessions = this.state.sessions.filter((s) => s.id !== id);
    return this.persist();
  }

  /**
   * Register (or re-register) a device for an account. Unique by
   * (accountId, name): an existing name updates the record in place and keeps
   * the original deviceId, so daemon restarts are idempotent.
   */
  upsertDevice(
    accountId: string,
    input: { name: string; os: string; agent?: string; offer: Offer },
  ): { record: DeviceRecord; updated: boolean; persist: Promise<void> } {
    const now = new Date().toISOString();
    const existing = this.state.devices.find(
      (d) => d.accountId === accountId && d.name === input.name,
    );
    if (existing) {
      existing.os = input.os;
      existing.agent = input.agent;
      existing.offer = input.offer;
      existing.updatedAt = now;
      existing.lastSeenAt = now;
      return { record: existing, updated: true, persist: this.persist() };
    }
    const record: DeviceRecord = {
      deviceId: `dev_${randomBytes(12).toString("base64url")}`,
      accountId,
      name: input.name,
      os: input.os,
      agent: input.agent,
      offer: input.offer,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
    };
    this.state.devices.push(record);
    return { record, updated: false, persist: this.persist() };
  }

  /** Heartbeat: bump lastSeenAt, optionally replacing the offer. */
  touchDevice(
    deviceId: string,
    offer?: Offer,
  ): { record: DeviceRecord; persist: Promise<void> } | undefined {
    const device = this.findDevice(deviceId);
    if (!device) return undefined;
    const now = new Date().toISOString();
    device.lastSeenAt = now;
    if (offer) {
      device.offer = offer;
      device.updatedAt = now;
    }
    return { record: device, persist: this.persist() };
  }

  removeDevice(deviceId: string): Promise<boolean> {
    const before = this.state.devices.length;
    this.state.devices = this.state.devices.filter((d) => d.deviceId !== deviceId);
    if (this.state.devices.length === before) return Promise.resolve(false);
    return this.persist().then(() => true);
  }

  // ---- persistence -------------------------------------------------------

  /** Serialize writes; resolves when this generation has been flushed. */
  persist(): Promise<void> {
    this.writeChain = this.writeChain.then(
      () => this.writeState(),
      () => this.writeState(),
    );
    return this.writeChain;
  }

  private async writeState(): Promise<void> {
    const json = `${JSON.stringify(this.state, null, 2)}\n`;
    const dir = path.dirname(this.dbPath);
    if (!this.dirEnsured) {
      await fs.mkdir(dir, { recursive: true, mode: 0o700 });
      this.dirEnsured = true;
    }
    const tmp = `${this.dbPath}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
    const fh = await fs.open(tmp, "w", 0o600);
    try {
      await fh.writeFile(json, "utf8");
      await fh.sync();
    } finally {
      await fh.close();
    }
    await fs.rename(tmp, this.dbPath);
  }
}
