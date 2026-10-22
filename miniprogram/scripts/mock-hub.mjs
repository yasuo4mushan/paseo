/**
 * Mock hub 服务（UI 自动化 / 手动调试用）。
 *
 * 按契约实现最小 Node http 服务：POST <base>/<method>，JSON body，
 * 响应 {ok:true,data} / {ok:false,error:{code,message}}，登录后校验 Bearer token。
 *
 * 固定数据：
 * - 账号 demo / demo123（其余凭据返回 auth.invalid_credentials）
 * - 设备 1：在线，带真实可连 relay offer（remoteagent.agentsworkforyou.cn，模拟器实测可通）
 * - 设备 2：离线，offer 为 null
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
const ACCOUNT = { id: "acc_demo", username: "demo" };

function devices() {
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
  console.log(`${new Date().toISOString()} ${method} authed=${authed} body=${JSON.stringify(body)}`);

  switch (method) {
    case "auth.login":
      if (body.username === "demo" && body.password === "demo123") {
        send(200, { ok: true, data: { token: TOKEN, account: ACCOUNT } });
      } else {
        send(200, {
          ok: false,
          error: { code: "auth.invalid_credentials", message: "用户名或密码错误" },
        });
      }
      return;
    case "auth.register":
      if (typeof body.username === "string" && body.username.length >= 2 && body.password >= 6) {
        send(200, { ok: true, data: { account: { id: `acc_${body.username}`, username: body.username } } });
      } else {
        send(200, { ok: false, error: { code: "auth.invalid_request", message: "参数无效" } });
      }
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
      send(200, { ok: true, data: { devices: devices() } });
      return;
    default:
      send(404, { ok: false, error: { code: "hub.not_found", message: `unknown method ${method}` } });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`mock hub listening on http://0.0.0.0:${PORT}/api (demo/demo123)`);
});
