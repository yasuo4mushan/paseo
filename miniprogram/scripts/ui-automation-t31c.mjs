/**
 * t31-c UI 自动化验收：agent 可见性修复（all_providers 能力声明）。
 *
 * 场景：隔离 daemon（ws://<LAN-IP>:6792，PASEO_HOME=/tmp/t31c-home）预置一条
 * zcode provider 的 stored agent。修复前（hello 不声明 all_providers）daemon 会把
 * 非 legacy provider 的 agent 整体过滤；修复后应出现在会话列表与对话页。
 *
 * 前置：
 *   1. 隔离 daemon 已在 6792 监听（/tmp/t31c-home，含 zcode agent 记录）。
 *   2. devtools 自动化端口已开：cli auto --project <miniprogram> --auto-port 9422
 *
 * 产物（docs/screenshots/t31c-*.png）：
 *   01 会话列表出现 zcode agent 卡片（浅色）
 *   02 会话详情（zcode provider 副标题）
 *   03 深色会话列表
 *   04 对话页会话选择（zcode 出现在列表）
 *
 * provider 目录（list_available_providers）同样受 all_providers 门控，
 * 已由 node 直连探针在 6799/6792 双向证明（修复前 zcode 缺席、修复后出现），
 * 不在 UI 步骤里重复（创建页 provider 步骤在向导第 ③ 步，前置依赖多）。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9422";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DAEMON_URL = process.env.T31C_DAEMON_URL ?? "ws://192.168.2.202:6792/ws";

const PROBE_USER = process.env.PROBE_USER ?? `t31probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t31probe-pass-1";
// hub 现网 auth.register 要求 phone（同 t25）
const PROBE_PHONE = process.env.PROBE_PHONE ?? `17325${Date.now().toString().slice(-6)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, { timeout = 20000, interval = 500 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        console.log(`✓ ${desc}`);
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
  console.log(`📸 ${name}.png`);
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

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：注册探针账号（登录门槛；设备列表无需注册，走直连） ----
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

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9422)");

  // ---- 种真实会话（hub 现网 auth.login 要求 phone，登录页尚未跟进；同 t25 绕开）----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_last_agent");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");
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
    throw new Error("种入真实会话后仍被守卫拦到登录页（token 已失效？）");
  }
  console.log(`会话就绪页面：${page.path}`);

  // ---- 配对页直连隔离 daemon ----
  await mini.reLaunch("/pages/pair/index");
  await sleep(1200);
  page = await mini.currentPage();
  await waitFor("配对页出现", async () => (await page.$(".pair-input")) !== null);
  const pairInput = await page.$(".pair-input");
  await pairInput.input(DAEMON_URL);
  const connectBtn = await waitFor("连接按钮可用", async () => {
    const btn = await findByText(page, ".btn", "连接");
    return btn ?? null;
  });
  await connectBtn.tap();
  await waitFor("连接成功（离开配对页）", async () => {
    const current = await mini.currentPage();
    return current.path !== "pages/pair/index" ? current : false;
  });

  // ---- 会话列表：zcode agent 卡片 ----
  await mini.reLaunch("/pages/agents/index");
  await sleep(1500);
  page = await mini.currentPage();
  const zcodeCard = await waitFor("会话列表出现 zcode agent 卡片", async () => {
    page = await mini.currentPage();
    return (await findByText(page, ".agent-card", "t31 zcode")) ?? null;
  });
  const subtitle = await zcodeCard.$(".agent-sub");
  console.log("zcode 卡片副标题：", await subtitle.text());
  const pill = await zcodeCard.$(".pill");
  console.log("zcode 状态胶囊：", await pill.text());
  await shot(mini, "t31c-01-agents-zcode-light");

  // ---- 会话详情：provider 副标题 + 标题 ----
  await zcodeCard.tap();
  page = await waitFor("进入会话详情", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agent/index" ? current : false;
  });
  await sleep(1500);
  await shot(mini, "t31c-02-agent-detail");

  // ---- 深色主题会话列表（走设置页真实切换：themeStore 在 App 启动时安装，
  //      直接写 storage + reLaunch 不会重装，必须经 setPreference 生效） ----
  await mini.navigateBack();
  await sleep(800);
  await mini.reLaunch("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const darkOption = await waitFor("设置页出现深色选项", async () => {
    page = await mini.currentPage();
    return (await findByText(page, ".theme-option", "深色")) ?? null;
  });
  await darkOption.tap();
  await sleep(800);
  await mini.reLaunch("/pages/agents/index");
  await sleep(1500);
  page = await mini.currentPage();
  await waitFor("深色下 zcode 卡片仍在", async () =>
    (await findByText(page, ".agent-card", "t31 zcode")) ?? null,
  );
  await shot(mini, "t31c-03-agents-zcode-dark");
  // 切回浅色（清理，避免影响后续会话选择截图的底色）
  await mini.reLaunch("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const lightOption = await waitFor("切回浅色选项", async () => {
    page = await mini.currentPage();
    return (await findByText(page, ".theme-option", "浅色")) ?? null;
  });
  await lightOption.tap();
  await sleep(800);

  // ---- 对话页会话选择（chat-header 打开 SessionPickerSheet） ----
  await mini.reLaunch("/pages/chat/index");
  await sleep(2000);
  page = await mini.currentPage();
  const headerMain = await waitFor("对话页头部出现", async () =>
    (await page.$(".chat-header-main")) ?? null,
  );
  await headerMain.tap();
  await sleep(800);
  const spRow = await waitFor("对话页会话选择出现 zcode 行", async () =>
    (await findByText(page, ".sp-row", "t31 zcode", ".sp-name")) ?? null,
  );
  const spStatus = await spRow.$(".pill");
  console.log("会话选择 zcode 状态胶囊：", spStatus ? await spStatus.text() : "(无)");
  await shot(mini, "t31c-04-chat-session-picker");

  console.log("t31c UI 验收完成");
  await mini.disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error("t31c UI 验收失败：", err);
  process.exit(1);
});
