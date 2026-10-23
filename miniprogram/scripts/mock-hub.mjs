/**
 * Mock hub 服务（UI 自动化 / 手动调试用）。
 *
 * 按契约实现最小 Node http 服务：POST <base>/<method>，JSON body，
 * 响应 {ok:true,data} / {ok:false,error:{code,message}}，登录后校验 Bearer token。
 *
 * 固定数据（t27 起手机号版，与真实 hub 契约一致）：
 * - 账号 13800138000 / demo12345（其余凭据返回 auth.invalid_credentials）
 * - 设备 1：在线，带真实可连 relay offer（remoteagent.agentsworkforyou.cn，模拟器实测可通）
 * - 设备 2：离线，offer 为 null
 *
 * t31 动态设备注册：daemon 以 PASEO_HUB_URL/PASEO_HUB_TOKEN 指到本 mock 时，
 * devices.register / devices.heartbeat / devices.list 收纳其注册（进程内，重启即清）。
 * MOCK_STATIC_DEVICES=0 可隐藏上面两台固定设备（隔离 daemon 验收时避免
 * 自动连接逻辑选到固定在线设备）。
 *
 * 用法：node scripts/mock-hub.mjs [port]   （默认 8788，监听 0.0.0.0）
 */

import { createServer } from "node:http";

const PORT = Number(process.argv[2] ?? 8788);

// relay URI relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=... 的解码形态
const REAL_OFFER = {
  serverId: "srv_7aUzzpHz-TlI",
  daemonPublicKeyB64: "C9D/2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk=",
  endpoint: "remoteagent.agentsworkforyou.cn:80",
  useTls: false,
};

const TOKEN = "mock-token-1";
const ACCOUNT = { id: "acc_demo", phone: "13800138000" };
const DEMO_PHONE = "13800138000";
const DEMO_PASS = "demo12345";
let changedPass = DEMO_PASS;

function devices() {
  if (process.env.MOCK_STATIC_DEVICES === "0") return [];
  return [
    {
      deviceId: "dev-mbp",
      name: "Xiang 的 MacBook Pro",
      os: "darwin",
      online: true,
      lastSeenAt: new Date().toISOString(),
      offer: REAL_OFFER,
    },
    {
      deviceId: "dev-linux",
      name: "办公室 Linux 主机",
      os: "linux",
      online: false,
      lastSeenAt: "2026-10-21T02:00:00.000Z",
      offer: null,
    },
  ];
}

// t31：动态注册设备（隔离 daemon；serverId 幂等复用 deviceId）
const dynamicDevices = new Map();
let dynamicSeq = 0;

function upsertDynamicDevice(body) {
  const offer = body?.offer;
  if (!offer || typeof offer.serverId !== "string" || !offer.serverId) return null;
  let device = null;
  for (const candidate of dynamicDevices.values()) {
    if (candidate.offer?.serverId === offer.serverId) {
      device = candidate;
      break;
    }
  }
  if (!device) {
    dynamicSeq += 1;
    device = { deviceId: `dev-dyn-${dynamicSeq}` };
    dynamicDevices.set(device.deviceId, device);
  }
  if (typeof body.name === "string" && body.name) device.name = body.name;
  if (typeof body.os === "string" && body.os) device.os = body.os;
  device.offer = offer;
  device.online = true;
  device.lastSeenAt = new Date().toISOString();
  return device;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
  const send = (status, body) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  if (req.method !== "POST") {
    send(404, { ok: false, error: { code: "hub.not_found", message: "not found" } });
    return;
  }

  const body = await readBody(req);
  const authed = req.headers.authorization === `Bearer ${TOKEN}`;
  console.log(
    `${new Date().toISOString()} ${method} authed=${authed} body=${JSON.stringify(body)}`,
  );

  switch (method) {
    case "auth.login":
      if (body.phone === DEMO_PHONE && body.password === changedPass) {
        send(200, { ok: true, data: { token: TOKEN, account: ACCOUNT } });
      } else {
        send(200, {
          ok: false,
          error: { code: "auth.invalid_credentials", message: "手机号或密码错误" },
        });
      }
      return;
    case "auth.register":
      if (
        /^1[3-9]\d{9}$/.test(body.phone ?? "") &&
        typeof body.password === "string" &&
        body.password.length >= 8
      ) {
        if (body.phone === DEMO_PHONE) {
          send(200, {
            ok: false,
            error: { code: "auth.phone_taken", message: "该手机号已注册" },
          });
        } else {
          send(200, {
            ok: true,
            data: { account: { id: `acc_${body.phone}`, phone: body.phone } },
          });
        }
      } else {
        send(200, {
          ok: false,
          error: { code: "auth.invalid_phone", message: "手机号格式不正确" },
        });
      }
      return;
    case "auth.password.change":
      if (!authed) {
        send(200, { ok: false, error: { code: "auth.unauthorized", message: "未登录或会话过期" } });
        return;
      }
      if (
        typeof body.newPassword === "string" &&
        body.newPassword.length >= 8 &&
        body.oldPassword === changedPass
      ) {
        changedPass = body.newPassword;
        send(200, { ok: true, data: { ok: true } });
      } else if (body.oldPassword !== changedPass) {
        send(200, {
          ok: false,
          error: { code: "auth.invalid_credentials", message: "旧密码不正确" },
        });
      } else {
        send(200, {
          ok: false,
          error: { code: "hub.invalid_request", message: "新密码至少 8 位" },
        });
      }
      return;
    case "auth.wx-phone":
      // mock 未启用微信一键登录：返回与真实 hub 相同的 auth.wx_disabled，
      // 登录页探测后隐藏微信按钮（t27 门控策略）。
      send(200, { ok: false, error: { code: "auth.wx_disabled", message: "wx login disabled" } });
      return;
    case "auth.me":
      if (!authed) {
        send(200, { ok: false, error: { code: "auth.unauthorized", message: "未登录或会话过期" } });
        return;
      }
      send(200, { ok: true, data: { account: ACCOUNT } });
      return;
    case "auth.logout":
      send(200, { ok: true, data: {} });
      return;
    case "devices.list":
      if (!authed) {
        send(200, { ok: false, error: { code: "auth.unauthorized", message: "未登录或会话过期" } });
        return;
      }
      send(200, { ok: true, data: { devices: [...devices(), ...dynamicDevices.values()] } });
      return;
    case "devices.register": {
      if (!authed) {
        send(200, { ok: false, error: { code: "auth.unauthorized", message: "未登录或会话过期" } });
        return;
      }
      const device = upsertDynamicDevice(body);
      if (!device) {
        send(200, { ok: false, error: { code: "devices.offer_invalid", message: "offer 无效" } });
        return;
      }
      console.log(
        `dynamic device registered: ${device.deviceId} ${device.name} → ${device.offer.endpoint}`,
      );
      send(200, { ok: true, data: { deviceId: device.deviceId } });
      return;
    }
    case "devices.heartbeat": {
      if (!authed) {
        send(200, { ok: false, error: { code: "auth.unauthorized", message: "未登录或会话过期" } });
        return;
      }
      const device = dynamicDevices.get(body?.deviceId);
      if (!device) {
        send(200, { ok: false, error: { code: "devices.not_found", message: "未知设备" } });
        return;
      }
      if (body.offer) device.offer = body.offer;
      device.online = true;
      device.lastSeenAt = new Date().toISOString();
      send(200, { ok: true, data: {} });
      return;
    }
    default:
      send(404, {
        ok: false,
        error: { code: "hub.not_found", message: `unknown method ${method}` },
      });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock hub listening on http://0.0.0.0:${PORT}/api (${DEMO_PHONE}/${DEMO_PASS})`);
});
