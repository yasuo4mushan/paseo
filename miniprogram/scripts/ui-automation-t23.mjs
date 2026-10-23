/**
 * t23 UI 自动化验收：统一设备状态语义——修复"设置页设备连接显示在线、
 * 设备页却显示离线"的语义撕裂（设备页 hub 心跳 vs 设置页本地 WS 连接态）。
 *
 * 剧本（真实 hub + 真实 relay + 真 daemon，只连接不消耗配额）：
 *   1. hub 注册探针账号 t23probe-<ts>。
 *   2. 预置两台设备：
 *      - A "t23-real-offer"：带真实 relay offer 但【不心跳】→ 60s TTL 后
 *        hub 侧离线。这就是用户 bug 场景：daemon 未登录 hub 账号，
 *        本地可连（手动配对 relay://）而设备页离线。
 *      - B "t23-heartbeat"：正常 25s 心跳 → hub 侧在线（对照组）。
 *   3. 等待 A 翻转为 offline、B 为 online。
 *   4. 小程序登录探针账号 → 设备页断言 A=离线（灰）/B=在线（蓝）。
 *   5. 设置 → 手动配对粘贴真实 relay:// → 连接真 daemon（E2EE，只握手不发任务）。
 *   6. 【核心断言】设置页与设备页【同显"已连接（未上表）"】+ 一行说明
 *      "桌面端未登录 aaswitch 账号，设备不会出现在其他手机"；B 保持"在线"。
 *   7. 点 A 卡片 → 直达对话页（未上表设备照常可用，不拆连接重握手）。
 *   8. 清理：断开连接、清会话、unregister 两台设备、auth.logout。
 *
 * 前置：
 *   1. npm run build:weapp 已构建（devtools 加载 dist/）。
 *   2. 开发者工具自动化端口：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9429
 *
 * 用法：node scripts/ui-automation-t23.mjs
 *
 * 产物（docs/screenshots/t23-*.png）：
 *   01 设备页（连接前：A 离线 / B 在线）   02 设置页（已连接（未上表）+说明）
 *   03 设备页（A 已连接（未上表）+说明）    04 对话页（点 A 卡片直达）
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9429";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";

// 任务给定的真实 relay offer（真 daemon 6799；只连接握手，不消耗配额）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t23probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t23probe-pass-1";
const DEVICE_A_NAME = "t23-real-offer"; // 真实 offer、不心跳 → 未上表场景
const DEVICE_B_NAME = "t23-heartbeat"; // 正常心跳对照

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, { timeout = 25000, interval = 500 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        console.log(`ok ${desc}`);
        return value;
      }
    } catch {
      // 轮询期间异常继续等
    }
    if (Date.now() - start > timeout) throw new Error(`等待超时：${desc}`);
    await sleep(interval);
  }
}

async function shot(mini, name) {
  const path = resolve(SHOT_DIR, `${name}.png`);
  await mini.screenshot({ path });
  console.log(`shot ${name}.png`);
}

function parseRelayUri(uri) {
  const url = new URL(uri.replace("relay://", "http://"));
  return {
    serverId: url.pathname.replace(/^\//, ""),
    daemonPublicKeyB64: decodeURIComponent(url.searchParams.get("key") ?? ""),
    endpoint: `${url.hostname}:${url.port || "80"}`,
    useTls: false,
  };
}

function hubCall(token) {
  return (method, body) =>
    fetch(`${HUB_BASE}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    }).then((r) => r.json());
}

/** 每步重新查询元素（automator 句柄随重渲染失效）。 */
async function findByText(page, selector, text, childSelector = null) {
  const rows = await page.$$(selector);
  for (const row of rows) {
    let value;
    if (childSelector) {
      const child = await row.$(childSelector);
      value = child ? await child.text() : null;
    } else {
      value = await row.text();
    }
    if (value && value.includes(text)) return row;
  }
  return null;
}

/** 设备卡片 → { name, pill, hint }（pill 文案 + 是否带未上表说明）。 */
async function readDeviceCard(page, name) {
  const rows = await page.$$(".device-card");
  for (const row of rows) {
    const nameEl = await row.$(".device-name");
    const nameText = nameEl ? await nameEl.text() : "";
    if (!nameText || !nameText.includes(name)) continue;
    const pillEl = await row.$(".pill");
    const hintEl = await row.$(".device-hint");
    return {
      name: nameText,
      pill: pillEl ? await pillEl.text() : "",
      hint: hintEl ? await hintEl.text() : null,
    };
  }
  return null;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：注册探针账号 ----
  console.log(`hub 探针账号：${PROBE_USER}`);
  const reg = await fetch(`${HUB_BASE}/auth.register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS }),
  }).then((r) => r.json());
  if (!reg.ok) throw new Error(`注册失败：${JSON.stringify(reg)}`);
  const login = await fetch(`${HUB_BASE}/auth.login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS }),
  }).then((r) => r.json());
  if (!login.ok) throw new Error(`登录失败：${JSON.stringify(login)}`);
  const token = login.data.token;
  const callApi = hubCall(token);

  // ---- 预置设备 A：真实 offer、不心跳（未上表场景） ----
  const offerA = parseRelayUri(RELAY_URI);
  const deviceA = await callApi("devices.register", {
    name: DEVICE_A_NAME,
    os: "macos",
    offer: offerA,
  });
  if (!deviceA.ok) throw new Error(`设备 A 注册失败：${JSON.stringify(deviceA)}`);
  console.log(`ok 设备 A（真实 offer 不心跳）：${deviceA.data.deviceId}（${offerA.endpoint}）`);

  // ---- 预置设备 B：假 serverId + 正常心跳（对照组） ----
  const offerB = {
    serverId: `srv-t23-dummy-${Date.now().toString(36)}`,
    daemonPublicKeyB64: Buffer.alloc(32, 7).toString("base64"),
    endpoint: offerA.endpoint,
    useTls: false,
  };
  const deviceB = await callApi("devices.register", {
    name: DEVICE_B_NAME,
    os: "macos",
    offer: offerB,
  });
  if (!deviceB.ok) throw new Error(`设备 B 注册失败：${JSON.stringify(deviceB)}`);
  console.log(`ok 设备 B（正常心跳对照）：${deviceB.data.deviceId}`);
  await callApi("devices.heartbeat", { deviceId: deviceB.data.deviceId });
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId: deviceB.data.deviceId }).catch(() => {});
  }, 25_000);

  // ---- 等待 A 的 60s 心跳 TTL 过期（hub 侧翻转为 offline） ----
  const hubStatus = await waitFor(
    "hub 侧 A 离线 / B 在线",
    async () => {
      const list = await callApi("devices.list", {});
      const a = list.data?.devices?.find((d) => d.deviceId === deviceA.data.deviceId);
      const b = list.data?.devices?.find((d) => d.deviceId === deviceB.data.deviceId);
      return a && b && a.online === false && b.online === true ? { a, b } : false;
    },
    { timeout: 100_000, interval: 5000 },
  );
  console.log(
    `ok hub 状态就绪：A online=${hubStatus.a.online}（lastSeen ${hubStatus.a.lastSeenAt}）/ B online=${hubStatus.b.online}`,
  );

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9429)");

  const cleanup = async (fail = false) => {
    clearInterval(heartbeatTimer);
    try {
      await callApi("devices.unregister", { deviceId: deviceA.data.deviceId });
      await callApi("devices.unregister", { deviceId: deviceB.data.deviceId });
      const list = await callApi("devices.list", {});
      const rest = list.data?.devices?.length ?? -1;
      console.log(`ok 清理：两台设备已 unregister（剩余 ${rest} 台）`);
    } catch (err) {
      console.error("清理失败：", err);
    }
    try {
      await callApi("auth.logout", {});
    } catch {
      // logout 失败不阻塞
    }
    if (fail) process.exitCode = 1;
  };

  try {
    // ---- 冷启动：清残留会话/配对 → 登录页 ----
    await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
    await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
    await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
    await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
    await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
    await mini.callWxMethod("removeStorageSync", "paseo_mp_last_agent");
    await mini.reLaunch("/pages/chat/index");
    await sleep(1500);
    let page = await mini.currentPage();
    page = await waitFor("未登录守卫跳登录页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/login/index" ? current : false;
    });

    // ---- 登录探针账号 ----
    const userInput = await page.$(".login-username");
    const passInput = await page.$(".login-password");
    await userInput.input(PROBE_USER);
    await passInput.input(PROBE_PASS);
    const loginBtn = await page.$(".btn-login");
    await loginBtn.tap();
    await waitFor("登录成功落对话主页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    });
    await sleep(800);

    // ---- 设备页（连接前）：A 离线 / B 在线 ----
    await mini.switchTab("/pages/devices/index");
    await sleep(2500);
    page = await mini.currentPage();
    await waitFor("设备列表渲染两台设备", async () => {
      const rows = await page.$$(".device-card");
      return rows.length >= 2 ? rows : false;
    });
    const beforeA = await waitFor(`设备页 A（${DEVICE_A_NAME}）显示离线`, async () => {
      const card = await readDeviceCard(page, DEVICE_A_NAME);
      return card && card.pill.includes("离线") ? card : false;
    });
    const beforeB = await waitFor(`设备页 B（${DEVICE_B_NAME}）显示在线`, async () => {
      const card = await readDeviceCard(page, DEVICE_B_NAME);
      return card && card.pill.includes("在线") ? card : false;
    });
    if (beforeA.hint !== null) throw new Error("连接前 A 不应出现未上表说明");
    console.log(`ok 连接前：A pill="${beforeA.pill}"（无说明）/ B pill="${beforeB.pill}"`);
    await shot(mini, "t23-01-devices-before-connect");

    // ---- 设置 → 手动配对 → 连接真 daemon（本地可连、hub 离线） ----
    await mini.switchTab("/pages/settings/index");
    await sleep(1200);
    page = await mini.currentPage();
    const pairCell = await findByText(page, ".cell", "手动配对");
    if (!pairCell) throw new Error("找不到手动配对入口");
    await pairCell.tap();
    await sleep(1000);
    page = await waitFor("进入手动配对页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/pair/index" ? current : false;
    });
    const pairInput = await page.$(".pair-input");
    await pairInput.input(RELAY_URI);
    const connectBtn = await page.$(".btn");
    await connectBtn.tap();
    await waitFor(
      "手动配对连接成功（E2EE 握手完成 → 跳对话页）",
      async () => {
        const current = await mini.currentPage();
        if (current.path === "pages/chat/index") return true;
        const errEl = await (await mini.currentPage()).$(".field-error");
        if (errEl) throw new Error(`配对失败：${await errEl.text()}`);
        return false;
      },
      { timeout: 40000 },
    );
    await sleep(1500);

    // ---- 【核心断言 1】设置页：已连接（未上表）+ 一行说明 ----
    await mini.switchTab("/pages/settings/index");
    await sleep(1500);
    page = await mini.currentPage();
    await waitFor("设置页连接状态 = 已连接（未上表）", async () => {
      const cell = await findByText(page, ".cell", "连接状态");
      const value = cell ? await cell.$(".cell-value") : null;
      const text = value ? await value.text() : "";
      return text.includes("已连接（未上表）") ? text : false;
    });
    const deviceCell = await findByText(page, ".cell", "当前设备");
    const deviceValue = deviceCell ? await deviceCell.$(".cell-value") : null;
    const deviceText = deviceValue ? await deviceValue.text() : "";
    if (!deviceText.includes(DEVICE_A_NAME)) {
      throw new Error(`设置页当前设备应为 ${DEVICE_A_NAME}，实际 "${deviceText}"`);
    }
    await waitFor("设置页出现未上表说明", async () => {
      const el = await page.$(".settings-unreported");
      return el ?? false;
    });
    console.log(`ok 设置页：已连接（未上表）· 当前设备="${deviceText}" · 说明已展示`);
    await shot(mini, "t23-02-settings-unreported");

    // ---- 【核心断言 2】设备页：A 已连接（未上表）+ 说明；B 保持在线 ----
    await mini.switchTab("/pages/devices/index");
    await sleep(1500);
    page = await mini.currentPage();
    const afterA = await waitFor(`设备页 A 显示 已连接（未上表）`, async () => {
      const card = await readDeviceCard(page, DEVICE_A_NAME);
      return card && card.pill.includes("已连接（未上表）") ? card : false;
    });
    const afterB = await waitFor("设备页 B 保持在线", async () => {
      const card = await readDeviceCard(page, DEVICE_B_NAME);
      return card && card.pill.includes("在线") ? card : false;
    });
    if (!afterA.hint || !afterA.hint.includes("不会出现在其他手机")) {
      throw new Error(`设备页 A 未上表说明缺失：${afterA.hint}`);
    }
    console.log(`ok 设备页：A pill="${afterA.pill}" + 说明 / B pill="${afterB.pill}"`);
    await shot(mini, "t23-03-devices-unreported");

    // ---- 未上表设备照常可用：点 A 卡片直达对话页（不拆连接重握手） ----
    const cardA = await findByText(page, ".device-card", DEVICE_A_NAME, ".device-name");
    await cardA.tap();
    await waitFor("点 A 卡片直达对话页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    });
    await sleep(1200);
    await shot(mini, "t23-04-chat-direct-from-unreported");

    // ---- 清理：断开 + 清会话（hub unregister 见 cleanup） ----
    await mini.switchTab("/pages/settings/index");
    await sleep(1000);
    page = await mini.currentPage();
    const disconnectBtn = await findByText(page, ".btn", "断开连接");
    if (disconnectBtn) {
      await disconnectBtn.tap();
      await sleep(800);
    }
    await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
    await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
    await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
    await mini.reLaunch("/pages/login/index");
    console.log("ok UI 侧已断开并清会话");

    await cleanup(false);
    console.log("t23 验收全部通过");
    await mini.disconnect();
  } catch (err) {
    console.error("验收失败：", err);
    await mini.screenshot({ path: resolve(SHOT_DIR, "t23-failure.png") }).catch(() => {});
    await cleanup(true);
    await mini.disconnect();
    throw err;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
