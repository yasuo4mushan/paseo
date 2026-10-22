import { beforeEach, describe, expect, it, vi } from "vitest";

// hub-client 依赖 Taro 的 request 与 storage；测试用内存 Map + 可编程 request mock。
const { storage, requestMock } = vi.hoisted(() => {
  const storage = new Map<string, string>();
  const requestMock = vi.fn();
  return { storage, requestMock };
});

vi.mock("@tarojs/taro", () => ({
  default: {
    getStorageSync: (key: string) => storage.get(key) ?? "",
    setStorageSync: (key: string, value: string) => {
      storage.set(key, value);
    },
    removeStorageSync: (key: string) => {
      storage.delete(key);
    },
    request: (...args: unknown[]) => requestMock(...args),
  },
}));

import {
  DEFAULT_HUB_BASE,
  HubApiError,
  clearSession,
  getAccount,
  getHubBase,
  getToken,
  hasSession,
  hub,
  hubErrorMessage,
  isAuthExpired,
  normalizeHubBase,
  resetHubBase,
  setHubBase,
} from "../src/hub/hub-client";
import { parseHubAccount, parseHubDevice, parseHubDevices } from "../src/hub/hub-types";
import { buildRelayUriFromOffer, parseRelayOffer } from "../src/connection/relay-offer";

const SAMPLE_KEY_RAW = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=";

function ok(data: unknown) {
  return { statusCode: 200, data: { ok: true, data } };
}

function fail(code: string, message = "boom") {
  return { statusCode: 200, data: { ok: false, error: { code, message } } };
}

beforeEach(() => {
  storage.clear();
  requestMock.mockReset();
});

describe("hub 会话与地址存取", () => {
  it("默认 hub 地址，无 token 时 hasSession 为 false", () => {
    expect(getHubBase()).toBe(DEFAULT_HUB_BASE);
    expect(hasSession()).toBe(false);
    expect(getToken()).toBe(null);
    expect(getAccount()).toBe(null);
  });

  it("normalizeHubBase 去尾斜杠并拒绝非 http(s) 输入", () => {
    expect(normalizeHubBase("https://a.com/api/")).toBe("https://a.com/api");
    expect(normalizeHubBase(" http://b.com ")).toBe("http://b.com");
    expect(() => normalizeHubBase("ws://c.com")).toThrow();
    expect(() => normalizeHubBase("c.com/api")).toThrow();
  });

  it("setHubBase 自定义地址后可读取并恢复默认", () => {
    setHubBase("http://10.0.0.5:8788/api/");
    expect(getHubBase()).toBe("http://10.0.0.5:8788/api");
    resetHubBase();
    expect(getHubBase()).toBe(DEFAULT_HUB_BASE);
  });

  it("clearSession 只清会话不动 hub 地址", () => {
    setHubBase("http://10.0.0.5:8788/api");
    storage.set("aaswitch_hub_token", "t1");
    clearSession();
    expect(hasSession()).toBe(false);
    expect(getHubBase()).toBe("http://10.0.0.5:8788/api");
  });
});

describe("hub.login / register / logout", () => {
  it("登录成功保存 token 与账号", async () => {
    requestMock.mockResolvedValue(
      ok({ token: "tok-1", account: { id: "u1", username: "alice" } }),
    );
    const result = await hub.login("alice", "hunter2");
    expect(result.account.username).toBe("alice");
    expect(getToken()).toBe("tok-1");
    expect(getAccount()).toEqual({ id: "u1", username: "alice" });
    expect(hasSession()).toBe(true);

    const call = requestMock.mock.calls[0][0] as { url: string; method: string; data: unknown };
    expect(call.url).toBe(`${DEFAULT_HUB_BASE}/auth.login`);
    expect(call.method).toBe("POST");
    expect(call.data).toEqual({ username: "alice", password: "hunter2" });
  });

  it("登录成功后的请求携带 Bearer token", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    requestMock.mockResolvedValue(ok({ account: { id: "u1", username: "alice" } }));
    await hub.me();
    const call = requestMock.mock.calls[0][0] as { header: Record<string, string> };
    expect(call.header.Authorization).toBe("Bearer tok-1");
    expect(hasSession()).toBe(true);
  });

  it("invalid_credentials 映射为中文文案", async () => {
    requestMock.mockResolvedValue(fail("auth.invalid_credentials", "bad credentials"));
    await expect(hub.login("alice", "wrong")).rejects.toMatchObject({
      name: "HubApiError",
      code: "auth.invalid_credentials",
    });
    const err = await hub.login("alice", "wrong").catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("用户名或密码错误");
    expect(isAuthExpired(err)).toBe(false);
  });

  it("真实 hub 的 HTTP 401 + envelope 错误体仍取 error.code（而非 http_error）", async () => {
    // 真实 hub：POST auth.login 密码错误 → HTTP 401 + {ok:false,error:{code:...}}
    requestMock.mockResolvedValue({
      statusCode: 401,
      data: { ok: false, error: { code: "auth.invalid_credentials", message: "invalid username or password" } },
    });
    const err = await hub.login("alice", "wrong").catch((e: unknown) => e);
    expect((err as HubApiError).code).toBe("auth.invalid_credentials");
    expect(hubErrorMessage(err)).toBe("用户名或密码错误");
  });

  it("HTTP 409 username_taken（注册重名）映射中文文案", async () => {
    requestMock.mockResolvedValue({
      statusCode: 409,
      data: { ok: false, error: { code: "auth.username_taken", message: "username is already taken" } },
    });
    const err = await hub.register("alice", "hunter2").catch((e: unknown) => e);
    expect((err as HubApiError).code).toBe("auth.username_taken");
    expect(hubErrorMessage(err)).toBe("用户名已被注册");
  });

  it("HTTP 429 rate_limited（两种 code 形态）映射中文文案", async () => {
    requestMock.mockResolvedValue({
      statusCode: 429,
      data: { ok: false, error: { code: "rate_limited", message: "too many requests" } },
    });
    const err = await hub.login("alice", "hunter2").catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("操作过于频繁，请稍后再试");
  });

  it("未知 code 回退服务端 message", async () => {
    requestMock.mockResolvedValue(fail("hub.some_new_error", "自定义失败原因"));
    const err = await hub.me().catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("自定义失败原因");
  });

  it("register 成功后自动 login 并保存会话", async () => {
    requestMock.mockResolvedValueOnce(ok({ account: { id: "u2", username: "bob" } }));
    requestMock.mockResolvedValueOnce(
      ok({ token: "tok-2", account: { id: "u2", username: "bob" } }),
    );
    const result = await hub.register("bob", "hunter2");
    expect(result.token).toBe("tok-2");
    expect(getAccount()?.username).toBe("bob");
    const registerCall = requestMock.mock.calls[0][0] as { url: string };
    expect(registerCall.url).toBe(`${DEFAULT_HUB_BASE}/auth.register`);
  });

  it("logout 无论服务端成败都清本地会话", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    storage.set(
      "aaswitch_hub_account",
      JSON.stringify({ id: "u1", username: "alice" }),
    );
    requestMock.mockRejectedValue(new Error("network down"));
    await expect(hub.logout()).rejects.toBeInstanceOf(Error);
    expect(hasSession()).toBe(false);
    expect(getAccount()).toBe(null);
  });

  it("网络异常与坏响应统一抛 HubApiError", async () => {
    requestMock.mockRejectedValue(new Error("timeout"));
    const err = await hub.devices().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HubApiError);
    expect((err as HubApiError).code).toBe("hub.network_error");

    requestMock.mockResolvedValue({ statusCode: 500, data: "oops" });
    const err500 = await hub.devices().catch((e: unknown) => e);
    expect((err500 as HubApiError).code).toBe("hub.http_error");

    requestMock.mockResolvedValue(ok({ account: "not-an-object" }));
    const errShape = await hub.me().catch((e: unknown) => e);
    expect((errShape as HubApiError).code).toBe("hub.bad_response");
  });

  it("auth.unauthorized 自动清会话且 isAuthExpired 为 true", async () => {
    storage.set("aaswitch_hub_token", "tok-expired");
    requestMock.mockResolvedValue(fail("auth.unauthorized", "expired"));
    const err = await hub.devices().catch((e: unknown) => e);
    expect(isAuthExpired(err)).toBe(true);
    expect(hasSession()).toBe(false);
  });

  it("真实 hub 的 auth.token_invalid（401）同样视为会话失效并自动清会话", async () => {
    storage.set("aaswitch_hub_token", "tok-expired");
    requestMock.mockResolvedValue({
      statusCode: 401,
      data: { ok: false, error: { code: "auth.token_invalid", message: "missing token" } },
    });
    const err = await hub.devices().catch((e: unknown) => e);
    expect(isAuthExpired(err)).toBe(true);
    expect(hubErrorMessage(err)).toBe("登录已过期，请重新登录");
    expect(hasSession()).toBe(false);
  });
});

describe("devices.list 解析", () => {
  it("解析在线/离线设备，形态不对的条目丢弃", async () => {
    requestMock.mockResolvedValue(
      ok({
        devices: [
          {
            deviceId: "dev-1",
            name: "MacBook Pro",
            os: "darwin",
            online: true,
            lastSeenAt: "2026-10-22T06:00:00.000Z",
            offer: {
              serverId: "srv_1",
              daemonPublicKeyB64: SAMPLE_KEY_RAW,
              endpoint: "relay.example:80",
              useTls: false,
            },
          },
          { deviceId: "dev-2", name: "Linux Box", os: "linux", online: false, offer: null },
          { name: "缺 deviceId 的坏条目" },
          "not an object",
        ],
      }),
    );
    const devices = await hub.devices();
    expect(devices).toHaveLength(2);
    expect(devices[0].offer?.daemonPublicKeyB64).toBe(SAMPLE_KEY_RAW);
    expect(devices[0].offer?.endpoint).toBe("relay.example:80");
    expect(devices[1].offer).toBe(null);
    expect(devices[1].online).toBe(false);
  });

  it("hub offer → relay:// URI → offer 往返一致（设备连接路径）", () => {
    const offer = {
      serverId: "srv_1",
      daemonPublicKeyB64: SAMPLE_KEY_RAW,
      endpoint: "relay.example:80",
      useTls: true,
      password: "pw1",
    };
    expect(parseRelayOffer(buildRelayUriFromOffer(offer))).toEqual(offer);
  });
});

describe("hub-types 防御式解析", () => {
  it("parseHubAccount 拒绝缺字段", () => {
    expect(parseHubAccount({ id: "u1" })).toBe(null);
    expect(parseHubAccount({ id: "u1", username: "alice" })).toEqual({
      id: "u1",
      username: "alice",
    });
  });

  it("parseHubDevice 容错 name/os/lastSeenAt 缺省", () => {
    const device = parseHubDevice({ deviceId: "d1", online: "yes" });
    expect(device).not.toBe(null);
    expect(device?.name).toBe("d1");
    expect(device?.os).toBe("");
    expect(device?.lastSeenAt).toBe("");
  });

  it("parseHubDevices 对非数组输入返回空列表", () => {
    expect(parseHubDevices(null)).toEqual([]);
    expect(parseHubDevices({ devices: "nope" })).toEqual([]);
  });
});
