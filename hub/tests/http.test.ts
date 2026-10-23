import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { call, startHub, type TestHub } from "./helpers/hub.js";

let hub: TestHub;

beforeAll(async () => {
  hub = await startHub();
});

afterAll(async () => {
  await hub.close();
});

describe("GET /health", () => {
  it("returns {status:ok} without the API envelope", async () => {
    const res = await fetch(`${hub.url}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });
  });

  it("rejects POST with 405", async () => {
    const res = await fetch(`${hub.url}/health`, { method: "POST" });
    expect(res.status).toBe(405);
    const body = (await res.json()) as { ok: boolean; error: { code: string } };
    expect(body.error.code).toBe("method_not_allowed");
  });
});

describe("routing", () => {
  it("serves methods only under /api/ (canonical contract)", async () => {
    const bare = await fetch(`${hub.url}/auth.login`, {
      method: "POST",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(bare.status).toBe(404);
    expect(((await bare.json()) as { error: { code: string } }).error.code).toBe("not_found");
  });

  it("404s for an unknown method with the error envelope", async () => {
    const res = await call(hub.url, "no.such_method");
    expect(res.status).toBe(404);
    expect(res.json.ok).toBe(false);
    expect(res.json.error?.code).toBe("not_found");
    expect(typeof res.json.error?.message).toBe("string");
  });

  it("405s on GET to a method route", async () => {
    const res = await fetch(`${hub.url}/api/auth.login`);
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "method_not_allowed",
    );
  });

  it("204 for CORS preflight", async () => {
    const res = await fetch(`${hub.url}/api/auth.login`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("authorization");
  });

  it("rejects invalid JSON bodies with 400 bad_request", async () => {
    const res = await fetch(`${hub.url}/api/auth.login`, {
      method: "POST",
      body: "{broken",
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
  });
});

describe("rate limiting (auth.login / auth.register / auth.wx-phone, 10 per IP per minute)", () => {
  let limited: TestHub;

  beforeAll(async () => {
    limited = await startHub({ limitMax: 10, limitWindowMs: 60_000 });
  });

  afterAll(async () => {
    await limited.close();
  });

  it("blocks the 11th credentialed request with 429 rate_limited", async () => {
    let last: Awaited<ReturnType<typeof call>>;
    for (let i = 0; i < 11; i++) {
      last = await call(limited.url, "auth.login", {
        phone: "13800009999",
        password: "wrongpass1",
      });
    }
    expect(last!.status).toBe(429);
    expect(last!.json.error?.code).toBe("rate_limited");
  });

  it("still serves non-credentialed routes while blocked", async () => {
    const res = await fetch(`${limited.url}/health`);
    expect(res.status).toBe(200);
  });

  it("sets a Retry-After header on 429", async () => {
    const res = await call(limited.url, "auth.login", {
      phone: "13800009999",
      password: "wrongpass1",
    });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});
