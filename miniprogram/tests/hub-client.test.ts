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
  normalizePhoneInput,
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
  it("手机号登录成功保存 token 与账号；+86 前缀归一化后发送", async () => {
    requestMock.mockResolvedValue(
      ok({ token: "tok-1", account: { id: "u1", phone: "13800138000" } }),
    );
    const result = await hub.login("+86 138 0013 8000", "hunter2abc");
    expect(result.account.phone).toBe("13800138000");
    expect(getToken()).toBe("tok-1");
    expect(getAccount()).toEqual({ id: "u1", phone: "13800138000" });
    expect(hasSession()).toBe(true);

    const call = requestMock.mock.calls[0][0] as { url: string; method: string; data: unknown };
    expect(call.url).toBe(`${DEFAULT_HUB_BASE}/auth.login`);
    expect(call.method).toBe("POST");
    expect(call.data).toEqual({ phone: "13800138000", password: "hunter2abc" });
  });

  it("normalizePhoneInput 归一化 +86/86/分隔符并拒绝非法输入", () => {
    expect(normalizePhoneInput("13800138000")).toBe("13800138000");
    expect(normalizePhoneInput("+8613800138000")).toBe("13800138000");
    expect(normalizePhoneInput("8613800138000")).toBe("13800138000");
    expect(normalizePhoneInput("138-0013(8000)")).toBe("13800138000");
    expect(() => normalizePhoneInput("1380013800")).toThrow("手机号");
    expect(() => normalizePhoneInput("12800138000")).toThrow("手机号");
    expect(() => normalizePhoneInput("hello")).toThrow("手机号");
  });

  it("非法手机号登录前即抛中文错误（不发请求）", async () => {
    await expect(hub.login("12345", "hunter2abc")).rejects.toThrow("手机号格式不正确");
    expect(requestMock).not.toHaveBeenCalled();
  });

  it("登录成功后的请求携带 Bearer token", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    requestMock.mockResolvedValue(ok({ account: { id: "u1", phone: "13800138000" } }));
    await hub.me();
    const call = requestMock.mock.calls[0][0] as { header: Record<string, string> };
    expect(call.header.Authorization).toBe("Bearer tok-1");
    expect(hasSession()).toBe(true);
  });

  it("invalid_credentials 映射为中文文案", async () => {
    requestMock.mockResolvedValue(fail("auth.invalid_credentials", "bad credentials"));
    await expect(hub.login("13800138000", "wrong12345")).rejects.toMatchObject({
      name: "HubApiError",
      code: "auth.invalid_credentials",
    });
    const err = await hub.login("13800138000", "wrong12345").catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("手机号或密码错误");
    expect(isAuthExpired(err)).toBe(false);
  });

  it("真实 hub 的 HTTP 401 + envelope 错误体仍取 error.code（而非 http_error）", async () => {
    // 真实 hub：POST auth.login 密码错误 → HTTP 401 + {ok:false,error:{code:...}}
    requestMock.mockResolvedValue({
      statusCode: 401,
      data: {
        ok: false,
        error: { code: "auth.invalid_credentials", message: "invalid phone or password" },
      },
    });
    const err = await hub.login("13800138000", "wrong12345").catch((e: unknown) => e);
    expect((err as HubApiError).code).toBe("auth.invalid_credentials");
    expect(hubErrorMessage(err)).toBe("手机号或密码错误");
  });

  it("auth.invalid_phone / auth.phone_taken 映射中文文案", async () => {
    expect(hubErrorMessage(new HubApiError("auth.invalid_phone", "bad phone"))).toBe(
      "手机号格式不正确，请输入 11 位大陆手机号",
    );
    requestMock.mockResolvedValue({
      statusCode: 409,
      data: {
        ok: false,
        error: { code: "auth.phone_taken", message: "phone number is already registered" },
      },
    });
    const err = await hub.register("13800138000", "hunter2abc").catch((e: unknown) => e);
    expect((err as HubApiError).code).toBe("auth.phone_taken");
    expect(hubErrorMessage(err)).toBe("该手机号已注册");
  });

  it("HTTP 429 rate_limited（两种 code 形态）映射中文文案", async () => {
    requestMock.mockResolvedValue({
      statusCode: 429,
      data: { ok: false, error: { code: "rate_limited", message: "too many requests" } },
    });
    const err = await hub.login("13800138000", "hunter2abc").catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("操作过于频繁，请稍后再试");
  });

  it("未知 code 回退服务端 message", async () => {
    requestMock.mockResolvedValue(fail("hub.some_new_error", "自定义失败原因"));
    const err = await hub.me().catch((e: unknown) => e);
    expect(hubErrorMessage(err)).toBe("自定义失败原因");
  });

  it("register 成功后自动 login 并保存会话", async () => {
    requestMock.mockResolvedValueOnce(ok({ account: { id: "u2", phone: "13900139000" } }));
    requestMock.mockResolvedValueOnce(
      ok({ token: "tok-2", account: { id: "u2", phone: "13900139000" } }),
    );
    const result = await hub.register("13900139000", "hunter2abc");
    expect(result.token).toBe("tok-2");
    expect(getAccount()?.phone).toBe("13900139000");
    const registerCall = requestMock.mock.calls[0][0] as { url: string; data: unknown };
    expect(registerCall.url).toBe(`${DEFAULT_HUB_BASE}/auth.register`);
    expect((registerCall.data as { phone: string }).phone).toBe("13900139000");
  });

  it("changePassword 带旧密码调用 auth.password.change（Bearer）", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    requestMock.mockResolvedValue(ok({ ok: true }));
    await hub.changePassword("newpass12345", "oldpass123");
    const call = requestMock.mock.calls[0][0] as {
      url: string;
      data: Record<string, unknown>;
      header: Record<string, string>;
    };
    expect(call.url).toBe(`${DEFAULT_HUB_BASE}/auth.password.change`);
    expect(call.data).toEqual({ oldPassword: "oldpass123", newPassword: "newpass12345" });
    expect(call.header.Authorization).toBe("Bearer tok-1");
  });

  it("changePassword 免旧密码形态（微信未设密账号）不发送 oldPassword", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    requestMock.mockResolvedValue(ok({ ok: true }));
    await hub.changePassword("firstpass123");
    const call = requestMock.mock.calls[0][0] as { data: Record<string, unknown> };
    expect(call.data).toEqual({ newPassword: "firstpass123" });
  });

  it("changePassword 401 时视为会话失效并自动清会话", async () => {
    storage.set("aaswitch_hub_token", "tok-expired");
    requestMock.mockResolvedValue({
      statusCode: 401,
      data: { ok: false, error: { code: "auth.token_invalid", message: "missing token" } },
    });
    await expect(hub.changePassword("newpass12345", "oldpass123")).rejects.toBeInstanceOf(
      HubApiError,
    );
    expect(hasSession()).toBe(false);
  });

  it("wxPhoneLogin 成功保存会话并解析 passwordSet=false", async () => {
    requestMock.mockResolvedValue(
      ok({
        token: "tok-wx",
        phone: "13700137000",
        account: { id: "uwx", phone: "13700137000", passwordSet: false },
      }),
    );
    const result = await hub.wxPhoneLogin("wx-code-1");
    expect(result.phone).toBe("13700137000");
    expect(result.account.passwordSet).toBe(false);
    expect(getToken()).toBe("tok-wx");
    expect(getAccount()?.passwordSet).toBe(false);
    const call = requestMock.mock.calls[0][0] as { url: string; data: unknown };
    expect(call.url).toBe(`${DEFAULT_HUB_BASE}/auth.wx-phone`);
    expect(call.data).toEqual({ code: "wx-code-1" });
  });

  it("wx 错误码映射中文文案（code 失效 / 未启用 / 上游异常）", () => {
    expect(hubErrorMessage(new HubApiError("auth.wx_code_invalid", "x"))).toBe(
      "微信授权已失效，请重试",
    );
    expect(hubErrorMessage(new HubApiError("auth.wx_disabled", "x"))).toBe("微信登录暂未开放");
    expect(hubErrorMessage(new HubApiError("auth.wx_upstream", "x"))).toBe(
      "微信服务暂时不可用，请稍后再试",
    );
  });

  it("probeWxLogin：code_invalid → 启用；wx_disabled / not_found / 网络异常 → 隐藏", async () => {
    requestMock.mockResolvedValue({
      statusCode: 401,
      data: { ok: false, error: { code: "auth.wx_code_invalid", message: "bad code" } },
    });
    await expect(hub.probeWxLogin()).resolves.toBe(true);

    requestMock.mockResolvedValue({
      statusCode: 501,
      data: { ok: false, error: { code: "auth.wx_disabled", message: "disabled" } },
    });
    await expect(hub.probeWxLogin()).resolves.toBe(false);

    requestMock.mockResolvedValue({
      statusCode: 404,
      data: { ok: false, error: { code: "not_found", message: "unknown method" } },
    });
    await expect(hub.probeWxLogin()).resolves.toBe(false);

    requestMock.mockRejectedValue(new Error("network down"));
    await expect(hub.probeWxLogin()).resolves.toBe(false);
  });

  it("logout 无论服务端成败都清本地会话", async () => {
    storage.set("aaswitch_hub_token", "tok-1");
    storage.set("aaswitch_hub_account", JSON.stringify({ id: "u1", phone: "13800138000" }));
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
  it("parseHubAccount：手机号账号 + passwordSet 防御式解析", () => {
    // 现行 hub 契约：{id, phone, createdAt}；passwordSet 仅未设密时下发 false
    expect(parseHubAccount({ id: "u1", phone: "13800138000", createdAt: "t" })).toEqual({
      id: "u1",
      phone: "13800138000",
    });
    expect(parseHubAccount({ id: "u1", phone: "13800138000", passwordSet: false })).toEqual({
      id: "u1",
      phone: "13800138000",
      passwordSet: false,
    });
    expect(parseHubAccount({ id: "u1", phone: "13800138000", passwordSet: true })).toEqual({
      id: "u1",
      phone: "13800138000",
    });
    // 缺 id 仍拒绝；phone 缺失时账号保留（兼容旧数据）
    expect(parseHubAccount({ phone: "13800138000" })).toBe(null);
    expect(parseHubAccount({ id: "u1" })).toEqual({ id: "u1" });
    expect(parseHubAccount("nope")).toBe(null);
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
