/**
 * auth.wx-phone tests. The WeChat API is mocked by a local http server the
 * hub's WxPhoneService is pointed at (wxaApiBase) — no real credentials, no
 * network.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { call, randomPhone, startHub, type HubOptions, type TestHub } from "./helpers/hub.js";

interface RecordedRequest {
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown>;
}

interface MockBehavior {
  /** Response per stable_token call, in order; last entry repeats. */
  tokens: { token: string; expiresInSec?: number }[];
  /** Map from access_token to its getuserphonenumber response; fallback under "". */
  phoneResponses: Record<
    string,
    { errcode?: number; errmsg?: string; phone_info?: Record<string, unknown> }
  >;
}

class WxMock {
  readonly requests: RecordedRequest[] = [];
  private tokenCalls = 0;
  readonly server: http.Server;

  constructor(private behavior: MockBehavior) {
    this.server = http.createServer((req, res) => {
      void this.handle(req, res);
    });
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://wx-mock");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body =
      chunks.length > 0 ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) ?? {}) : {};
    this.requests.push({ path: url.pathname, query: url.searchParams, body });

    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/cgi-bin/stable_token") {
      const next = this.behavior.tokens[Math.min(this.tokenCalls, this.behavior.tokens.length - 1)];
      this.tokenCalls += 1;
      res.end(
        JSON.stringify({
          errcode: 0,
          errmsg: "ok",
          access_token: next.token,
          expires_in: next.expiresInSec ?? 7200,
        }),
      );
      return;
    }
    if (url.pathname === "/wxa/business/getuserphonenumber") {
      const token = url.searchParams.get("access_token") ?? "";
      const response = this.behavior.phoneResponses[token] ??
        this.behavior.phoneResponses[""] ?? { errcode: -1 };
      res.end(JSON.stringify(response));
      return;
    }
    res.end(JSON.stringify({ errcode: -1, errmsg: "unknown mock path" }));
  }

  get tokenCallCount(): number {
    return this.tokenCalls;
  }

  tokenRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path === "/cgi-bin/stable_token");
  }

  phoneRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.path === "/wxa/business/getuserphonenumber");
  }

  listen(): Promise<string> {
    return new Promise((resolve) => {
      this.server.listen(0, "127.0.0.1", () => {
        const addr = this.server.address() as AddressInfo;
        resolve(`http://127.0.0.1:${addr.port}`);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.server.close(() => resolve());
      this.server.closeAllConnections();
    });
  }
}

function okMock(phone = randomPhone()): MockBehavior {
  return {
    tokens: [{ token: "TOKEN_A" }],
    phoneResponses: {
      TOKEN_A: {
        errcode: 0,
        errmsg: "ok",
        phone_info: { phoneNumber: `+86${phone}`, purePhoneNumber: phone, countryCode: 86 },
      },
    },
  };
}

async function startWxHub(
  behavior: MockBehavior,
  hubOverrides: HubOptions = {},
): Promise<{ hub: TestHub; mock: WxMock; mockUrl: string }> {
  const mock = new WxMock(behavior);
  const mockUrl = await mock.listen();
  const hub = await startHub({
    wxaAppid: "wx-test-appid",
    wxaSecret: "test-secret",
    wxaApiBase: mockUrl,
    ...hubOverrides,
  });
  return { hub, mock, mockUrl };
}

describe("auth.wx-phone gating", () => {
  it("returns 501 auth.wx_disabled when HUB_WXA_APPID/HUB_WXA_SECRET are unset", async () => {
    const hub = await startHub();
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "any-code" });
      expect(res.status).toBe(501);
      expect(res.json.error?.code).toBe("auth.wx_disabled");
    } finally {
      await hub.close();
    }
  });

  it("returns 501 when only the appid is configured", async () => {
    const hub = await startHub({ wxaAppid: "wx-test-appid" });
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "any-code" });
      expect(res.status).toBe(501);
      expect(res.json.error?.code).toBe("auth.wx_disabled");
    } finally {
      await hub.close();
    }
  });

  it("rejects a missing code with 400 bad_request", async () => {
    const { hub, mock } = await startWxHub(okMock());
    try {
      const res = await call(hub.url, "auth.wx-phone", {});
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("bad_request");
      // Nothing reached WeChat.
      expect(mock.requests).toHaveLength(0);
    } finally {
      await hub.close();
      await mock.close();
    }
  });
});

describe("auth.wx-phone happy path", () => {
  it("creates the account on first login and reuses it on the second", async () => {
    const phone = randomPhone();
    const { hub, mock } = await startWxHub(okMock(phone));
    try {
      const first = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      expect(first.status).toBe(200);
      const data = first.json.data as {
        token: string;
        phone: string;
        account: { id: string; phone: string };
      };
      expect(data.phone).toBe(phone);
      expect(data.account.phone).toBe(phone);

      const me = await call(hub.url, "auth.me", {}, data.token);
      expect(me.status).toBe(200);
      expect((me.json.data as { account: { id: string } }).account.id).toBe(data.account.id);

      // Same phone again: same account, fresh token.
      const second = await call(hub.url, "auth.wx-phone", { code: "code-2" });
      expect(second.status).toBe(200);
      const data2 = second.json.data as { token: string; account: { id: string } };
      expect(data2.account.id).toBe(data.account.id);
      expect(data2.token).not.toBe(data.token);
    } finally {
      await hub.close();
      await mock.close();
    }
  });

  it("caches the access_token across requests (one stable_token call)", async () => {
    const { hub, mock } = await startWxHub(okMock());
    try {
      await call(hub.url, "auth.wx-phone", { code: "code-a" });
      await call(hub.url, "auth.wx-phone", { code: "code-b" });
      expect(mock.tokenCallCount).toBe(1);
      // Both phone calls carried the same cached token.
      expect(mock.phoneRequests().map((r) => r.query.get("access_token"))).toEqual([
        "TOKEN_A",
        "TOKEN_A",
      ]);
      // The getPhoneNumber body carries only the code.
      expect(mock.phoneRequests()[0]?.body).toEqual({ code: "code-a" });
    } finally {
      await hub.close();
      await mock.close();
    }
  });

  it("refreshes the token once and retries when WeChat rejects it (40001)", async () => {
    const phone = randomPhone();
    const behavior: MockBehavior = {
      tokens: [{ token: "TOKEN_STALE" }, { token: "TOKEN_FRESH" }],
      phoneResponses: {
        TOKEN_STALE: { errcode: 40001, errmsg: "invalid credential" },
        TOKEN_FRESH: {
          errcode: 0,
          errmsg: "ok",
          phone_info: { purePhoneNumber: phone, countryCode: 86 },
        },
      },
    };
    const { hub, mock } = await startWxHub(behavior);
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      expect(res.status).toBe(200);
      expect((res.json.data as { phone: string }).phone).toBe(phone);
      // One stale fetch + one forced refresh.
      expect(mock.tokenCallCount).toBe(2);
      const refresh = mock.tokenRequests()[1]?.body as Record<string, unknown>;
      expect(refresh.force_refresh).toBe(true);
    } finally {
      await hub.close();
      await mock.close();
    }
  });
});

describe("auth.wx-phone failures", () => {
  it("maps errcode 40029 to 401 auth.wx_code_invalid", async () => {
    const behavior = okMock();
    behavior.phoneResponses.TOKEN_A = { errcode: 40029, errmsg: "invalid code" };
    const { hub, mock } = await startWxHub(behavior);
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "used-code" });
      expect(res.status).toBe(401);
      expect(res.json.error?.code).toBe("auth.wx_code_invalid");
    } finally {
      await hub.close();
      await mock.close();
    }
  });

  it("maps other WeChat errcodes to 502 auth.wx_upstream", async () => {
    const behavior = okMock();
    behavior.phoneResponses.TOKEN_A = { errcode: 45011, errmsg: "api minute-quota reach limit" };
    const { hub, mock } = await startWxHub(behavior);
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      expect(res.status).toBe(502);
      expect(res.json.error?.code).toBe("auth.wx_upstream");
    } finally {
      await hub.close();
      await mock.close();
    }
  });

  it("returns 502 auth.wx_upstream when WeChat is unreachable", async () => {
    // Point the client at a port with no listener.
    const hub = await startHub({
      wxaAppid: "wx-test-appid",
      wxaSecret: "test-secret",
      wxaApiBase: "http://127.0.0.1:1",
    });
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      expect(res.status).toBe(502);
      expect(res.json.error?.code).toBe("auth.wx_upstream");
    } finally {
      await hub.close();
    }
  });

  it("rejects a non-mainland number with 400 auth.invalid_phone", async () => {
    const behavior = okMock();
    behavior.phoneResponses.TOKEN_A = {
      errcode: 0,
      errmsg: "ok",
      phone_info: { phoneNumber: "+15551234567", purePhoneNumber: "15551234567", countryCode: 1 },
    };
    const { hub, mock } = await startWxHub(behavior);
    try {
      const res = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      expect(res.status).toBe(400);
      expect(res.json.error?.code).toBe("auth.invalid_phone");
    } finally {
      await hub.close();
      await mock.close();
    }
  });
});

describe("wx-created accounts vs password login", () => {
  it("cannot password-login until a password is set via auth.password.change", async () => {
    const phone = randomPhone();
    const { hub, mock } = await startWxHub(okMock(phone));
    try {
      const wxLogin = await call(hub.url, "auth.wx-phone", { code: "code-1" });
      const token = (wxLogin.json.data as { token: string }).token;

      // The placeholder password is unknowable: password login fails.
      const guess = await call(hub.url, "auth.login", { phone, password: "whatever123" });
      expect(guess.status).toBe(401);

      // Set a real password (no oldPassword needed: none is set).
      const change = await call(
        hub.url,
        "auth.password.change",
        { newPassword: "realpassword456" },
        token,
      );
      expect(change.status).toBe(200);

      // The wx token survives the change; password login now works.
      const me = await call(hub.url, "auth.me", {}, token);
      expect(me.status).toBe(200);
      const login = await call(hub.url, "auth.login", { phone, password: "realpassword456" });
      expect(login.status).toBe(200);
    } finally {
      await hub.close();
      await mock.close();
    }
  });
});

describe("auth.wx-phone rate limiting", () => {
  it("shares the credential limiter: 11th call per IP in a minute is 429", async () => {
    const { hub, mock } = await startWxHub(okMock(), { limitMax: 10, limitWindowMs: 60_000 });
    try {
      let last: Awaited<ReturnType<typeof call>> | undefined;
      for (let i = 0; i < 11; i++) {
        last = await call(hub.url, "auth.wx-phone", { code: `code-${i}` });
      }
      expect(last?.status).toBe(429);
      expect(last?.json.error?.code).toBe("rate_limited");
      expect(Number(last?.headers.get("retry-after"))).toBeGreaterThan(0);
    } finally {
      await hub.close();
      await mock.close();
    }
  });
});
