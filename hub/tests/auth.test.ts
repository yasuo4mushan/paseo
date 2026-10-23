import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hashPassword, mintSession } from "../src/auth.js";
import { call, randomPhone, registerAndLogin, startHub, type TestHub } from "./helpers/hub.js";

let hub: TestHub;

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
});

describe("auth.register (phone)", () => {
  it("creates an account and returns id/phone/createdAt", async () => {
    const res = await call(hub.url, "auth.register", {
      phone: "13812345678",
      password: "password123",
    });
    expect(res.status).toBe(200);
    expect(res.json.ok).toBe(true);
    const account = (res.json.data as { account: { id: string; phone: string; createdAt: string } })
      .account;
    expect(account.id).toMatch(/^acc_/);
    expect(account.phone).toBe("13812345678");
    expect(account.createdAt).toBeTruthy();
    // Never leak the hash or password.
    expect(JSON.stringify(res.json)).not.toContain("passwordHash");
    expect(JSON.stringify(res.json)).not.toContain("password123");
  });

  it("normalizes +86 / 86 / formatted input to the 11-digit national form", async () => {
    for (const [input, normalized] of [
      ["+8613912345678", "13912345678"],
      ["8613912345679", "13912345679"],
      ["+86 139 1234-5680", "13912345680"],
    ] as const) {
      const res = await call(hub.url, "auth.register", { phone: input, password: "password123" });
      expect(res.status, input).toBe(200);
      expect((res.json.data as { account: { phone: string } }).account.phone).toBe(normalized);
    }
  });

  it("rejects invalid phones with 400 auth.invalid_phone", async () => {
    for (const phone of [
      "12345678901", // second digit not 3-9
      "1381234567", // 10 digits
      "138123456789", // 12 digits
      "+1 555 123 4567", // non-CN number
      "1381234567a", // non-digit
      "手机号13812345678", // text around it
    ]) {
      const res = await call(hub.url, "auth.register", { phone, password: "password123" });
      expect(res.status, phone).toBe(400);
      expect(res.json.error?.code).toBe("auth.invalid_phone");
    }
  });

  it("rejects a non-string phone with 400 bad_request", async () => {
    const res = await call(hub.url, "auth.register", {
      phone: 13812345678,
      password: "x".repeat(8),
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });

  it("no longer accepts username-based registration", async () => {
    const res = await call(hub.url, "auth.register", {
      username: "alice",
      password: "password123",
    });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });

  it("rejects a registered phone with 409 auth.phone_taken (after normalization)", async () => {
    const phone = randomPhone();
    await call(hub.url, "auth.register", { phone, password: "password123" });
    const res = await call(hub.url, "auth.register", {
      phone: `+86${phone}`,
      password: "password456",
    });
    expect(res.status).toBe(409);
    expect(res.json.error?.code).toBe("auth.phone_taken");
  });

  it("rejects short passwords with 400 bad_request", async () => {
    const res = await call(hub.url, "auth.register", { phone: randomPhone(), password: "1234567" });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });

  it("rejects a non-object body", async () => {
    const res = await call(hub.url, "auth.register", "not-an-object");
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });
});

describe("auth.login (phone)", () => {
  const phone = "13800001111";

  beforeAll(async () => {
    await call(hub.url, "auth.register", { phone, password: "password123" });
  });

  it("returns a token and account with the normalized phone", async () => {
    const res = await call(hub.url, "auth.login", {
      phone: `+86${phone}`,
      password: "password123",
    });
    expect(res.status).toBe(200);
    const data = res.json.data as { token: string; account: { phone: string } };
    expect(data.token).toMatch(/\./); // <sessionId>.<key>
    expect(data.account.phone).toBe(phone);
    // The stored session must not contain the raw key material.
    const tokenKey = data.token.split(".")[1];
    expect(JSON.stringify(hub.store)).not.toContain(tokenKey);
  });

  it("rejects a wrong password with 401 auth.invalid_credentials", async () => {
    const res = await call(hub.url, "auth.login", { phone, password: "wrongpass99" });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.invalid_credentials");
  });

  it("gives the same error for an unknown phone (no phone probing)", async () => {
    const res = await call(hub.url, "auth.login", { phone: "13999999999", password: "whatever1" });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.invalid_credentials");
  });

  it("rejects a malformed phone with 400 auth.invalid_phone", async () => {
    const res = await call(hub.url, "auth.login", { phone: "12345", password: "password123" });
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("auth.invalid_phone");
  });
});

describe("auth.me", () => {
  it("returns the account for a valid token", async () => {
    const phone = randomPhone();
    const token = await registerAndLogin(hub.url, phone);
    const res = await call(hub.url, "auth.me", {}, token);
    expect(res.status).toBe(200);
    expect((res.json.data as { account: { phone: string } }).account.phone).toBe(phone);
  });

  it("rejects missing, malformed, and forged tokens with 401 auth.token_invalid", async () => {
    for (const token of [undefined, "garbage", "aaaa.bbbb"]) {
      const res = await call(hub.url, "auth.me", {}, token);
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe("auth.token_invalid");
    }
  });
});

describe("auth.password.change", () => {
  it("requires a bearer token", async () => {
    const res = await call(hub.url, "auth.password.change", {
      oldPassword: "password123",
      newPassword: "newpassword456",
    });
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.token_invalid");
  });

  it("rejects a wrong old password with 401 auth.invalid_credentials", async () => {
    const token = await registerAndLogin(hub.url);
    const res = await call(
      hub.url,
      "auth.password.change",
      {
        oldPassword: "wrong-old-pass",
        newPassword: "newpassword456",
      },
      token,
    );
    expect(res.status).toBe(401);
    expect(res.json.error?.code).toBe("auth.invalid_credentials");
  });

  it("changes the password: old one dies, new one works, same phone", async () => {
    const phone = randomPhone();
    await call(hub.url, "auth.register", { phone, password: "password123" });
    const token = (
      (await call(hub.url, "auth.login", { phone, password: "password123" })).json.data as {
        token: string;
      }
    ).token;

    const change = await call(
      hub.url,
      "auth.password.change",
      {
        oldPassword: "password123",
        newPassword: "newpassword456",
      },
      token,
    );
    expect(change.status).toBe(200);
    expect((change.json.data as { ok: boolean }).ok).toBe(true);

    const oldLogin = await call(hub.url, "auth.login", { phone, password: "password123" });
    expect(oldLogin.status).toBe(401);

    const newLogin = await call(hub.url, "auth.login", { phone, password: "newpassword456" });
    expect(newLogin.status).toBe(200);
  });

  it("keeps the current session but revokes every other session", async () => {
    const phone = randomPhone();
    await call(hub.url, "auth.register", { phone, password: "password123" });
    const login = async () =>
      (
        (await call(hub.url, "auth.login", { phone, password: "password123" })).json.data as {
          token: string;
        }
      ).token;
    const changer = await login();
    const otherA = await login();
    const otherB = await login();

    const res = await call(
      hub.url,
      "auth.password.change",
      {
        oldPassword: "password123",
        newPassword: "newpassword456",
      },
      changer,
    );
    expect(res.status).toBe(200);

    // Current token survives …
    const me = await call(hub.url, "auth.me", {}, changer);
    expect(me.status).toBe(200);
    // … every other token is revoked.
    for (const token of [otherA, otherB]) {
      const dead = await call(hub.url, "auth.me", {}, token);
      expect(dead.status).toBe(401);
      expect(dead.json.error?.code).toBe("auth.token_invalid");
    }
  });

  it("rejects an invalid new password with 400 bad_request", async () => {
    const token = await registerAndLogin(hub.url);
    const res = await call(
      hub.url,
      "auth.password.change",
      {
        oldPassword: "password123",
        newPassword: "short",
      },
      token,
    );
    expect(res.status).toBe(400);
    expect(res.json.error?.code).toBe("bad_request");
  });
});

describe("auth.logout", () => {
  it("revokes the token; subsequent auth.me fails", async () => {
    const token = await registerAndLogin(hub.url);
    const out = await call(hub.url, "auth.logout", {}, token);
    expect(out.status).toBe(200);
    expect((out.json.data as { ok: boolean }).ok).toBe(true);

    const me = await call(hub.url, "auth.me", {}, token);
    expect(me.status).toBe(401);
    expect(me.json.error?.code).toBe("auth.token_invalid");
  });

  it("keeps other sessions alive", async () => {
    const phone = randomPhone();
    await call(hub.url, "auth.register", { phone, password: "password123" });
    const tokenA = (
      (await call(hub.url, "auth.login", { phone, password: "password123" })).json.data as {
        token: string;
      }
    ).token;
    const tokenB = (
      (await call(hub.url, "auth.login", { phone, password: "password123" })).json.data as {
        token: string;
      }
    ).token;
    await call(hub.url, "auth.logout", {}, tokenA);
    const me = await call(hub.url, "auth.me", {}, tokenB);
    expect(me.status).toBe(200);
  });
});

describe("legacy username-era data", () => {
  it("boots on an old hub.json: sessions and devices keep working", async () => {
    const secret = randomBytes(32);
    const now = new Date().toISOString();
    const { token, record } = mintSession(secret, "acc_legacy1", 60 * 60 * 1000);
    const seedDb = (dbPath: string) => {
      writeFileSync(
        dbPath,
        JSON.stringify(
          {
            version: 1,
            accounts: [
              {
                id: "acc_legacy1",
                username: "alice",
                passwordHash: hashPassword("password123"),
                createdAt: now,
              },
            ],
            sessions: [record],
            devices: [
              {
                deviceId: "dev_legacy",
                accountId: "acc_legacy1",
                name: "old-box",
                os: "darwin",
                offer: {
                  serverId: "srv_legacy",
                  daemonPublicKeyB64: randomBytes(32).toString("base64"),
                  endpoint: "relay.example.com:443",
                },
                createdAt: now,
                updatedAt: now,
                lastSeenAt: now,
              },
            ],
          },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    };

    const legacy = await startHub({ tokenSecret: secret, seedDb });
    try {
      // Legacy session still authenticates and sees its devices.
      const list = await call(legacy.url, "devices.list", {}, token);
      expect(list.status).toBe(200);
      expect((list.json.data as { devices: unknown[] }).devices).toHaveLength(1);

      // New phone accounts register and work alongside the legacy row.
      const fresh = await call(legacy.url, "auth.register", {
        phone: "13800002222",
        password: "password123",
      });
      expect(fresh.status).toBe(200);

      // The legacy account has no phone, so it can no longer log in.
      const legacyLogin = await call(legacy.url, "auth.login", {
        username: "alice",
        password: "password123",
      });
      expect(legacyLogin.status).toBe(400);
    } finally {
      await legacy.close();
    }
  });
});
