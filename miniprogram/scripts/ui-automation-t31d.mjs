/**
 * t31-d UI 自动化验收：创建向导 codex 模型目录 + thinking 档位非空。
 *
 * 根因（实证）：daemon 侧 list_provider_models 对 codex 返回 7 个模型（含 thinking
 * 档位），客户端把「daemon error payload / 15s 超时」静默折叠成空列表——
 * 「模型目录为空、thinking 为空」。修复：listProviderModels 返回 {models,error}、
 * 目录超时 60s（冷快照 CLI 探测 >15s）、向导错误态 + 重试。
 *
 * 前置：
 *   1. devtools 自动化端口已开：cli auto --project <miniprogram> --auto-port 9420
 *   2. 6799 生产 daemon 在线（relay offer 设备注册用；全程只读——连接/目录/浏览，
 *      不提交创建，不写 daemon home）
 *
 * 验收链路：hub 探针账号 → 注册 relay 设备（指向 6799）→ 登录种子 → 设备页连接 →
 * 设置页进创建向导 → folder-picker 选真实已注册工作区 → 框架步选 codex →
 * 模型步非空（预选默认模型）→ thinking 步档位非空 → 框架步换 kimi →
 * 模型步显示「模型目录拉取失败：Authentication required」+ 重试（错误态可见性）。
 * 深色主题重复 codex 模型/thinking 两步截图。
 *
 * 产物（docs/screenshots/t31d-*.png）。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9420";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t31d-mac-dev";

// 6799 生产 daemon 的 relay offer（serverId 与 6799 server_info 实测一致；只读使用）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t31dprobe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t31dprobe-pass-1";
const PROBE_PHONE = process.env.PROBE_PHONE ?? `17325${Date.now().toString().slice(-6)}`;

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

/** folder-picker 面包屑 → 当前 trail 段（去掉根标签"/"）。 */
async function pickerTrail(page) {
  const crumbs = await page.$$(".fp-crumb");
  const segments = [];
  for (const crumb of crumbs) segments.push(((await crumb.text()) ?? "").trim());
  return segments.slice(1);
}

/**
 * 从向导第②步选一个已存在的真实目录（picker 根 = daemon 家目录）。
 * 目录只需存在即可——模型目录 RPC 不要求已注册工作区；不提交则不触发 open_project。
 */
async function pickExistingFolder(mini, page) {
  await waitFor("folder-picker 面板渲染", async () => (await page.$(".fp-panel")) ?? null);
  await waitFor("真实目录列表渲染", async () => {
    const rows = await page.$$(".fp-row");
    return rows.length >= 1 ? rows : null;
  });
  const row = await waitFor("目录项 Documents（真实存在）", async () =>
    (await findByText(page, ".fp-row", "Documents", ".fp-row-name")) ?? null,
  );
  await row.tap();
  await waitFor("进入 Documents", async () => {
    const trail = await pickerTrail(page);
    return trail[trail.length - 1] === "Documents" ? trail : null;
  });
  await (await page.$(".fp-confirm")).tap();
  console.log("ok 项目文件夹选定：~/Documents");
}

/** 走一遍 codex 向导目录链（框架→模型→thinking），返回 [模型值, thinking 档位数]。 */
async function walkthroughCodex(mini, page, shotPrefix) {
  // 第③步框架：选 codex
  await waitFor("进入第③步框架选择", async () => (await page.$(".chip")) ?? null);
  await sleep(600);
  const codexChip = await waitFor("框架目录出现 codex", async () =>
    (await findByText(page, ".chip", "codex")) ?? null,
  );
  await shot(mini, `${shotPrefix}-framework`);
  await codexChip.tap();

  // 第④步模型：等待目录加载完成（冷快照最长 60s），断言预选非空
  await waitFor(
    "codex 模型目录加载完成（非 loading）",
    async () => {
      const loading = await page.$(".loading-tip");
      if (loading) return null;
      return (await page.$(".picker-value")) ?? (await page.$(".field-error")) ?? null;
    },
    { timeout: 75000, interval: 800 },
  );
  const pickerValue = (await (await page.$(".picker-value"))?.text()) ?? "";
  if (!pickerValue || pickerValue.includes("默认模型")) {
    throw new Error(`codex 模型预选为空：${JSON.stringify(pickerValue)}`);
  }
  console.log(`ok codex 模型预选：${pickerValue}`);
  await sleep(400);
  await shot(mini, `${shotPrefix}-model`);

  // 第⑤步 thinking：断言档位 chips 非空
  await (await page.$(".wiz-nav-main")).tap();
  await waitFor("进入第⑤步 thinking/提交", async () => (await page.$(".prompt-input")) ?? null);
  const thinkChips = await page.$$(".chip");
  if (thinkChips.length < 3) {
    throw new Error(`codex thinking 档位不足（${thinkChips.length}）：期望 low/medium/high/...`);
  }
  const chipLabels = [];
  for (const chip of thinkChips) chipLabels.push(((await chip.text()) ?? "").trim());
  console.log(`ok codex thinking 档位：${chipLabels.join("/")}`);
  await shot(mini, `${shotPrefix}-effort`);
  return [pickerValue, thinkChips.length];
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：注册探针账号 + 预置 relay 设备（指向 6799，只读） ----
  console.log(`hub 探针账号：${PROBE_USER}`);
  const reg = await fetch(`${HUB_BASE}/auth.register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS, phone: PROBE_PHONE }),
  }).then((r) => r.json());
  if (!reg.ok) throw new Error(`注册失败：${JSON.stringify(reg)}`);
  const login = await fetch(`${HUB_BASE}/auth.login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS, phone: PROBE_PHONE }),
  }).then((r) => r.json());
  if (!login.ok) throw new Error(`登录失败：${JSON.stringify(login)}`);
  const token = login.data.token;
  const callApi = hubCall(token);
  const offer = parseRelayUri(RELAY_URI);
  const deviceReg = await callApi("devices.register", { name: DEVICE_NAME, os: "macos", offer });
  if (!deviceReg.ok) throw new Error(`设备注册失败：${JSON.stringify(deviceReg)}`);
  const deviceId = deviceReg.data.deviceId;
  console.log(`ok 设备已注册：${deviceId}`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId });

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9420)");

  // ---- 清态 + 种 hub 会话（t31c 同款）----
  for (const key of [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "paseo_mp_workspace",
    "paseo_mp_connection",
    "paseo_mp_last_agent",
    "aaswitch_theme_pref",
  ]) {
    await mini.callWxMethod("removeStorageSync", key);
  }
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_token", token);
  await mini.callWxMethod(
    "setStorageSync",
    "aaswitch_hub_account",
    JSON.stringify(login.data.account),
  );
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  let page = await mini.currentPage();
  if (page.path === "pages/login/index") {
    throw new Error("种入真实会话后仍被守卫拦到登录页");
  }

  // ---- 设备页：连接 relay 设备（→ 6799）----
  await mini.switchTab("/pages/devices/index");
  await sleep(2000);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () =>
    (await page.$(".device-online")) ?? null,
  );
  await onlineCard.tap();
  await waitFor(
    "relay 连接成功落对话主页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    },
    { timeout: 35000 },
  );
  await sleep(1500);

  // ---- 浅色：进向导 → 选工作区 → codex 目录链 ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1000);
  page = await mini.currentPage();
  const createCell = await waitFor(
    "设置页新建项目会话入口",
    async () => (await findByText(page, ".cell", "新建项目会话")) ?? null,
  );
  await createCell.tap();
  page = await waitFor("进入创建向导", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/create/index" ? current : false;
  });
  await waitFor("面包屑渲染（设备已自动选中）", async () => {
    const crumbs = await page.$$(".wiz-crumb");
    return crumbs.length === 5 ? crumbs : null;
  });
  await pickExistingFolder(mini, page);
  await walkthroughCodex(mini, page, "t31d-01-light");

  // ---- 错误态可见性：回框架步换 kimi（6799 上 kimi 目录 error=Authentication required）----
  await (await page.$(".wiz-nav-side")).tap(); // effort → model
  await sleep(600);
  // model → framework：面包屑回点「Agent 框架」
  const frameworkCrumb = await waitFor("面包屑 Agent 框架可回点", async () => {
    const values = await page.$$(".wiz-crumb-value");
    const titles = await page.$$(".wiz-crumb-title");
    for (let i = 0; i < titles.length; i++) {
      const t = (await titles[i].text()) ?? "";
      if (t.includes("框架")) return values[i] ?? titles[i];
    }
    return null;
  });
  await frameworkCrumb.tap();
  await sleep(600);
  const kimiChip = await waitFor("框架目录出现 kimi", async () =>
    (await findByText(page, ".chip", "kimi")) ?? null,
  );
  await kimiChip.tap();
  const errorTip = await waitFor(
    "kimi 模型目录错误态（拉取失败 + 重试）",
    async () => {
      const loading = await page.$(".loading-tip");
      if (loading) return null;
      const err = await page.$(".field-error");
      if (!err) return null;
      const text = (await err.text()) ?? "";
      return text.includes("模型目录拉取失败") ? err : null;
    },
    { timeout: 75000, interval: 800 },
  );
  console.log(`ok kimi 错误态：${(await errorTip.text()) ?? ""}`);
  await shot(mini, "t31d-02-kimi-error-visible");

  // ---- 深色：切主题 → 重走 codex 目录链 ----
  await mini.navigateBack();
  await sleep(800);
  await mini.reLaunch("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const darkOption = await waitFor("设置页出现深色选项", async () =>
    (await findByText(page, ".theme-option", "深色")) ?? null,
  );
  await darkOption.tap();
  await sleep(800);
  const createCellDark = await waitFor("设置页新建项目会话入口（深色）", async () =>
    (await findByText(page, ".cell", "新建项目会话")) ?? null,
  );
  await createCellDark.tap();
  page = await waitFor("进入创建向导（深色）", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/create/index" ? current : false;
  });
  await waitFor("面包屑渲染（深色）", async () => {
    const crumbs = await page.$$(".wiz-crumb");
    return crumbs.length === 5 ? crumbs : null;
  });
  await pickExistingFolder(mini, page);
  await walkthroughCodex(mini, page, "t31d-03-dark");

  // ---- 清理 ----
  await mini.navigateBack();
  await sleep(600);
  await mini
    .evaluate(() => {
      getApp().__automation?.disconnect?.();
      getApp().__automation?.sessionStore?.reset?.();
    })
    .catch(() => {});
  await mini.disconnect();
  clearInterval(heartbeatTimer);
  const unregister = await callApi("devices.unregister", { deviceId });
  console.log(
    `ok hub 设备清理：${unregister.ok ? "unregistered" : JSON.stringify(unregister).slice(0, 120)}`,
  );
  console.log("t31-d UI 验收完成");
}

main().catch((err) => {
  console.error("t31-d UI 验收失败：", err);
  process.exitCode = 1;
});
