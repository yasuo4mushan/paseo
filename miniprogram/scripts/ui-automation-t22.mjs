/**
 * t22 UI 自动化验收：深色模式全站审计截图。
 *
 * 前置：
 *   1. 开发者工具自动化端口已开：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9428
 *   2. npm run build:weapp 已产出 dist（CLI 载入的是构建产物）。
 *
 * 用法：node scripts/ui-automation-t22.mjs
 *
 * 深色驱动方式：模拟器外观跟随系统，无 Apple Events 权限切系统外观时，
 * 走"手动深色档"（设置页点深色）驱动 .theme-dark 路径 —— 与媒体查询共用
 * 同一套 token 暗色分支（app.css .theme-dark 与 prefers-color-scheme 深色
 * 值一致，t22 起 tests 之外由本脚本按页截图验证）。
 *
 * 认证：注入伪 hub token（hasSession 只查 storage），页面以未连接/空态渲染，
 * 不依赖真实 hub/relay —— 本任务审计的是配色而非数据链路。
 *
 * 产物（docs/screenshots/t22-*.png）：每个页面深浅各一张 + 跟随档回归一张。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9428";

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

/** 容器内按文本匹配子元素（automator 句柄随重渲染失效，每步重查）。 */
async function findByText(page, selector, text) {
  const rows = await page.$$(selector);
  for (const row of rows) {
    const value = await row.text();
    if (value && value.includes(text)) return row;
  }
  return null;
}

/** 待审计页面（t22 基线已有页面；chat 顶栏细节/创建向导归 t21/t24 终审）。
 *  ready 取两态共有根 class：未连接分支的根是裸 .page（agents/files/create）。 */
const PAGES = [
  { name: "settings", path: "/pages/settings/index", ready: ".settings-page" },
  { name: "devices", path: "/pages/devices/index", ready: ".devices-page" },
  { name: "chat", path: "/pages/chat/index", ready: ".chat-page" },
  { name: "agents", path: "/pages/agents/index", ready: ".page" },
  { name: "agent", path: "/pages/agent/index", ready: ".agent-page" },
  { name: "create", path: "/pages/create/index", ready: ".page" },
  { name: "files", path: "/pages/files/index", ready: ".page" },
  { name: "changes", path: "/pages/changes/index", ready: ".changes-page" },
  { name: "terminal", path: "/pages/terminal/index", ready: ".terminal-page" },
  { name: "schedules", path: "/pages/schedules/index", ready: ".schedules-page" },
  { name: "scripts", path: "/pages/scripts/index", ready: ".scripts-page" },
  { name: "new-workspace", path: "/pages/new-workspace/index", ready: ".new-ws-page" },
  { name: "pair", path: "/pages/pair/index", ready: ".pair-page" },
];

async function visitAndShoot(mini, entry, mode) {
  await mini.reLaunch(entry.path);
  await sleep(1200);
  const expected = entry.path.replace(/^\//, "");
  const current = await mini.currentPage();
  if (current.path !== expected) {
    console.warn(`⚠ ${entry.name} 未停留（当前 ${current.path}），按当前页截图`);
  }
  // 等目标页（而非过渡中的旧页）根节点出现
  await waitFor(`${entry.name} 根节点渲染`, async () => {
    const p = await mini.currentPage();
    if (p.path !== expected) return false;
    return (await p.$(entry.ready)) !== null;
  });
  await sleep(600);
  await shot(mini, `t22-${mode}-${entry.name}`);
}

/** 设置页点主题档位；断言根节点 class 切换正确。 */
async function setTheme(mini, label, expectedClass) {
  await mini.reLaunch("/pages/settings/index");
  await sleep(1200);
  const page = await mini.currentPage();
  await waitFor(`设置页出现`, async () => (await page.$(".settings-page")) !== null);
  const option = await waitFor(`主题选项「${label}」`, async () => {
    const p = await mini.currentPage();
    return (await findByText(p, ".theme-option", label)) ?? null;
  });
  await option.tap();
  await sleep(2200); // 等 Taro.showToast（1500ms）散场再截图
  if (expectedClass) {
    await waitFor(`根节点出现 .${expectedClass}`, async () => {
      const p = await mini.currentPage();
      return (await p.$(`.settings-page.${expectedClass}`)) !== null;
    });
  } else {
    await waitFor(`根节点无手动主题 class（跟随档）`, async () => {
      const p = await mini.currentPage();
      const dark = await p.$(".settings-page.theme-dark");
      const light = await p.$(".settings-page.theme-light");
      return dark === null && light === null;
    });
  }
}

async function shootLogin(mini, mode) {
  // 退出会话才能停在登录页；拍完恢复 mock 会话
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.reLaunch("/pages/login/index");
  await sleep(1500);
  const page = await mini.currentPage();
  await waitFor("登录页出现", async () => (await page.$(".login-page")) !== null);
  await sleep(600);
  await shot(mini, `t22-${mode}-login`);
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_token", "mock-token-1");
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_account", {
    username: "demo",
  });
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9428)");

  // ---- mock hub 会话（node scripts/mock-hub.mjs 8788，demo/demo123）：
  //      注入固定 token + hub base，设备页能拉到列表不再跳登录；页面其余以空态渲染 ----
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_token", "mock-token-1");
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_account", {
    username: "demo",
  });
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", "http://127.0.0.1:8788");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");

  // ---- 深色档：全页截图 ----
  await setTheme(mini, "深色", "theme-dark");
  for (const entry of PAGES) {
    await visitAndShoot(mini, entry, "dark");
  }
  await shootLogin(mini, "dark");

  // ---- 浅色档：全页截图 ----
  await setTheme(mini, "浅色", "theme-light");
  for (const entry of PAGES) {
    await visitAndShoot(mini, entry, "light");
  }
  await shootLogin(mini, "light");

  // ---- 跟随档回归：无手动 class，设置页一张 ----
  await setTheme(mini, "跟随系统", null);
  await sleep(600);
  await shot(mini, "t22-auto-settings");

  await mini.disconnect();
  console.log("✅ t22 深色审计截图完成");
}

main().catch((err) => {
  console.error("❌ t22 审计失败：", err);
  process.exit(1);
});
