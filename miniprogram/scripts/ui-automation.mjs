/**
 * UI 自动化验收脚本（微信开发者工具 automation 端口驱动）。
 *
 * 前置：
 *   1. 数据源二选一（环境变量选择）：
 *      - 默认：mock hub（node scripts/mock-hub.mjs，本机局域网 IP:8788，demo/demo123，
 *        两台设备，其中在线设备带真实可连 relay offer）
 *      - PROBE_USER/PROBE_PASS：真实 hub（默认地址），需先用 curl 在真实 hub 注册
 *        账号并 devices.register 预置设备（见 README）
 *      - HUB_BASE：显式覆盖 hub 地址（优先级最高）
 *   2. 开发者工具已开服务端口，且已执行：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9421
 *
 * 用法：node scripts/ui-automation.mjs [--dark]
 *   --dark 追加一张深色模式截图（需系统外观切换权限，见 README 降级说明）
 *
 * 产物：docs/screenshots/*.png（登录 → 设备 → agents → 详情 → 设置 → [深色]）
 */

import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9421";

// t27：手机号登录（mock hub 固定 13800138000 / demo12345；真实 hub 用环境变量）
const DEMO_USER = process.env.PROBE_USER ?? "13800138000";
const DEMO_PASS = process.env.PROBE_PASS ?? "demo12345";
const REAL_HUB = Boolean(process.env.PROBE_USER);

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}

// 真实 hub 走小程序内置默认地址；mock 才写自定义地址进 storage
const HUB_BASE = process.env.HUB_BASE ?? (REAL_HUB ? null : `http://${lanIp()}:8788/api`);
// 与 src/hub/hub-client.ts 的 DEFAULT_HUB_BASE 保持一致（真实 hub 模式下直接调 API 保活）
const DEFAULT_HUB = "http://remoteagent.agentsworkforyou.cn/api";
// 真实 relay serverId（mock-hub.mjs 同款 offer）：只有它对应的设备真正可连
const REAL_RELAY_SERVER_ID = "srv_7aUzzpHz-TlI";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, { timeout = 15000, interval = 500 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        console.log(`✓ ${desc}`);
        return value;
      }
    } catch (err) {
      // 轮询期间的异常继续等，超时后再抛
    }
    if (Date.now() - start > timeout) throw new Error(`等待超时：${desc}`);
    await sleep(interval);
  }
}

async function shot(mini, name) {
  const path = resolve(SHOT_DIR, `${name}.png`);
  await mini.screenshot({ path });
  console.log(`📸 ${name}.png`);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`hub base = ${HUB_BASE}`);
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation");

  // 清会话、回到登录页（真实 hub 用内置默认地址；mock 写自定义地址）
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  if (HUB_BASE) {
    await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", HUB_BASE);
  }
  await mini.reLaunch("/pages/login/index");
  await sleep(1500);

  let page = await mini.currentPage();
  await waitFor("登录页出现", async () => (await page.$(".login-phone")) !== null);
  await shot(mini, "01-login");
  // t27：微信一键按钮门控——hub 未启用（501 auth.wx_disabled）时整块隐藏
  const wxBtn = await page.$(".btn-wx-phone");
  if (wxBtn) throw new Error("微信一键登录按钮应处于隐藏态（hub 未启用 wx-phone）");
  console.log("✓ 微信一键登录按钮隐藏态（探测 501 auth.wx_disabled）");

  // 错误凭据 → 错误文案（手机号版文案）
  const userInput = await page.$(".login-phone");
  const passInput = await page.$(".login-password");
  const loginBtn = await page.$(".btn-login");
  await userInput.input("13800138000");
  await passInput.input("wrong-pass");
  await loginBtn.tap();
  await waitFor("invalid_credentials 错误文案", async () => {
    const err = await page.$(".login-error");
    return err ? (await err.text()).includes("手机号或密码错误") : false;
  });
  console.log("✓ 错误码映射为中文文案");

  // 正确凭据 → 设备 tab。错误态渲染后旧元素句柄失效，必须重新查询再输入
  // （hub 对 auth.login 限 10 次/IP/分钟，失败后稍候再试）
  await sleep(2000);
  const userInput2 = await page.$(".login-phone");
  const passInput2 = await page.$(".login-password");
  const loginBtn2 = await page.$(".btn-login");
  await userInput2.input(DEMO_USER);
  await passInput2.input(DEMO_PASS);
  await loginBtn2.tap();
  let loginErrorText = "";
  try {
    await waitFor("登录成功进入对话页/设备页", async () => {
      const current = await mini.currentPage();
      // t20 起登录直达对话主页（chat tab）；旧路径 devices 仍接受
      if (current.path !== "pages/chat/index" && current.path !== "pages/devices/index") {
        return false;
      }
      page = current;
      return true;
    });
  } catch (err) {
    const errorEl = await page.$(".login-error");
    loginErrorText = errorEl ? await errorEl.text() : "(无错误文案)";
    throw new Error(`登录未跳转设备页，页面错误文案：${loginErrorText}`);
  }
  await waitFor("设备列表出现设备卡片", async () => {
    const list = await page.$$(".device-card");
    return list.length >= 1 ? list : null;
  });

  // 真实 hub：设备 60s 无心跳判离线（HUB_ONLINE_TTL_MS）。daemon 侧心跳未上线，
  // 这里用小程序 storage 里的 token 直接替预置设备发心跳，再刷新页面取在线态。
  if (REAL_HUB) {
    const token = await mini.callWxMethod("getStorageSync", "aaswitch_hub_token");
    const hubBase = await mini.callWxMethod("getStorageSync", "aaswitch_hub_base");
    const base = hubBase || DEFAULT_HUB;
    const callApi = (method, body) =>
      fetch(`${base}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }).then((r) => r.json());
    const { data } = await callApi("devices.list", {});
    for (const device of data.devices) {
      // 只保活带真实可连 relay offer 的设备；其余设备保持离线，正好覆盖离线态 UI
      if (device.name.includes("t15") && device.offer?.serverId === REAL_RELAY_SERVER_ID) {
        await callApi("devices.heartbeat", { deviceId: device.deviceId });
        console.log(`✓ 心跳保活 ${device.name}`);
      }
    }
    await mini.reLaunch("/pages/devices/index");
    await sleep(2500);
    page = await mini.currentPage();
  }
  await shot(mini, "02-devices");

  // 点击在线设备 → relay E2EE 连接 → Agent 列表
  const online = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await online.tap();
  await waitFor(
    "连接成功进入 Agent 列表",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agents/index" ? current : false;
    },
    { timeout: 25000 },
  );
  await sleep(2500); // 等 agent 数据渲染
  await shot(mini, "03-agents");

  // Agent 详情（若真机环境有 agent）
  page = await mini.currentPage();
  const agentCard = await page.$(".agent-card");
  if (agentCard) {
    await agentCard.tap();
    await waitFor("进入 Agent 详情", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agent/index" ? current : false;
    });
    await sleep(2500); // 等时间线加载
    await shot(mini, "04-agent-detail");
    await mini.navigateBack();
  } else {
    console.log("（真实环境暂无 agent，详情页截图跳过——不影响验收主流程）");
  }

  // 设置页
  await mini.switchTab("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  await waitFor("设置页出现", async () => (await page.$(".cell-group")) !== null);
  await shot(mini, "05-settings");

  // 手动配对页（高级入口）
  const pairCell = await page.$$(".cell-tappable");
  let pairOpened = false;
  for (const cell of pairCell) {
    const text = await cell.text();
    if (text.includes("手动配对")) {
      await cell.tap();
      pairOpened = true;
      break;
    }
  }
  if (pairOpened) {
    await waitFor("配对页出现", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/pair/index" ? current : false;
    });
    await shot(mini, "06-pair");
    await mini.navigateBack();
  }

  // 深色模式截图（可选）：临时切系统外观 → devtools darkmode 跟随
  if (process.argv.includes("--dark")) {
    try {
      execSync(
        `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'`,
      );
      await sleep(4000);
      await mini.reLaunch("/pages/devices/index");
      await sleep(3000);
      await shot(mini, "07-devices-dark");
    } finally {
      execSync(
        `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'`,
      );
    }
  }

  await mini.disconnect();
  console.log("done");
}

main().catch((err) => {
  console.error("automation failed:", err);
  process.exit(1);
});
