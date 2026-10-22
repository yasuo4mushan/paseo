import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, registerAndLogin, startHub, type TestHub } from "./helpers/hub.js";

let hub: TestHub;

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
});

describe("auth.register", () => {
  it("creates an account and returns id/username/createdAt", async () => {
    const res = await call(hub.url, "auth.register", {
      username: "alice",
      password: "password123",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const account = (
      res.json.data as { account: { id: string; username: string; createdAt: string } }
    ).account;
    expect(account.id).toMatch(/^acc_/);
    expect(account.username).toBe("alice");
    expect(account.createdAt).toBeTruthy();
    // Never leak the hash or password.
    expect(JSON.stringify(res.json)).not.toContain("passwordHash");
    expect(JSON.stringify(res.json)).not.toContain("password123");
  });

  it("rejects a taken username with 409 auth.username_taken", async () => {
    const res = await call(hub.url, "auth.register", {
      username: "alice",
      password: "password456",
    });
    expect(res.status).toBe(409);
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("auth.username_taken");
  });

  it("rejects invalid usernames with 400 bad_request", async () => {
    for (const username of ["Alice", "ab", "a".repeat(33), "has space", "中文"]) {
      const res = await call(hub.url, "auth.register", { username, password: "password123" });
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("bad_request");
    }
  });

  it("rejects short passwords with 400 bad_request", async () => {
    const res = await call(hub.url, "auth.register", { username: "shortpw", password: "1234567" });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });

  it("rejects a non-object body", async () => {
    const res = await call(hub.url, "auth.register", "not-an-object");
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });
});

describe("auth.login", () => {
  it("returns a token and account", async () => {
    const res = await call(hub.url, "auth.login", { username: "alice", password: "password123" });
    expect(res.status).toBe(200);
    const data = res.json.data as { token: string; account: { username: string } };
    expect(data.token).toMatch(/\./); // <sessionId>.<key>
    expect(data.account.username).toBe("alice");
    // The stored session must not contain the raw key material.
    const tokenKey = data.token.split(".")[1];
    expect(JSON.stringify(hub.store)).not.toContain(tokenKey);
  });

  it("rejects a wrong password with 401 auth.invalid_credentials", async () => {
    const res = await call(hub.url, "auth.login", { username: "alice", password: "wrongpass99" });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.invalid_credentials");
  });

  it("gives the same error for an unknown user (no username probing)", async () => {
    const res = await call(hub.url, "auth.login", {
      username: "ghost-user",
      password: "whatever1",
    });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.invalid_credentials");
  });
});

describe("auth.me", () => {
  it("returns the account for a valid token", async () => {
    const token = await registerAndLogin(hub.url, "me-user");
    const res = await call(hub.url, "auth.me", {}, token);
    expect(res.status).toBe(200);
    expect((res.json.data as { account: { username: string } }).account.username).toBe("me-user");
  });

  it("rejects missing, malformed, and forged tokens with 401 auth.token_invalid", async () => {
    for (const token of [undefined, "garbage", "aaaa.bbbb"]) {
      const res = await call(hub.url, "auth.me", {}, token);
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe("auth.token_invalid");
    }
  });
});

describe("auth.logout", () => {
  it("revokes the token; subsequent auth.me fails", async () => {
    const token = await registerAndLogin(hub.url, "logout-user");
    const out = await call(hub.url, "auth.logout", {}, token);
    expect(out.status).toBe(200);
    expect(resOk(out.json)).toBe(true);

    const me = await call(hub.url, "auth.me", {}, token);
    expect(me.status).toBe(401);
    expect(me.json.error?.code).toBe("auth.token_invalid");
  });

  it("keeps other sessions alive", async () => {
    const tokenA = await registerAndLogin(hub.url, "multi-session");
    const tokenB = await call(hub.url, "auth.login", {
      username: "multi-session",
      password: "password123",
    }).then((r) => (r.json.data as { token: string }).token);
    await call(hub.url, "auth.logout", {}, tokenA);
    const me = await call(hub.url, "auth.me", {}, tokenB);
    expect(me.status).toBe(200);
  });
});

function resOk(json: { ok: boolean }): boolean {
  return json.ok === true;
}
