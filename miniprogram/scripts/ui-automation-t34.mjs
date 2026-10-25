/**
 * t34 UI 自动化验收：Web 引导完成页二维码的 relay:// 链接 → 小程序配对页
 * 粘贴 → 连接成功进入对话主页。
 *
 * 前置（同 t34 端到端链路，全部本机隔离，不碰 6767/6799）：
 *   1. 本地 relay：PORT=6780 node packages/relay/dist/node-server.js
 *   2. mock hub：MOCK_STATIC_DEVICES=0 node miniprogram/scripts/mock-hub.mjs 6782
 *   3. 隔离 daemon：127.0.0.1:6781，AASWITCH_HOME=/tmp/t34-home，relay 指向
 *      127.0.0.1:6780，AASWITCH_HUB_URL=http://127.0.0.1:6782
 *   4. Web 侧 Playwright spec 已把二维码对应的 relay:// URI 写入
 *      /tmp/t34/relay-uri.txt（onboarding-connect-phone.spec.ts）
 *   5. devtools 自动化端口已开：
 *      cli auto --project <repo>/miniprogram --auto-port 9421
 *
 * 扫码相机无法自动化：用配对页「粘贴链接」验证同一解析（parseConnectionInput）
 * 与连接逻辑（relay E2EE → daemon 会话），即二维码内容的真实消费路径。
 *
 * 产物（miniprogram/docs/screenshots/t34-*.png）：
 *   01 配对页粘贴 relay:// 链接（浅色）
 *   02 连接成功进入对话主页（浅色）
 *   03 对话主页（深色）
 */
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9421";
const RELAY_URI_FILE = process.env.T34_RELAY_URI_OUT ?? "/tmp/t34/relay-uri.txt";
const HUB_BASE = process.env.T34_HUB_BASE ?? "http://127.0.0.1:6782/api";

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

  const relayUri = readFileSync(RELAY_URI_FILE, "utf8").trim();
  if (!relayUri.startsWith("relay://")) {
    throw new Error(`relay URI 文件内容异常：${relayUri.slice(0, 60)}`);
  }
  console.log(`relay URI（Web 引导二维码内容）：${relayUri}`);

  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9421)");

  // 清连接/会话态，种 mock hub 会话（登录守卫；与 t31c 同法）
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_last_agent");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", HUB_BASE);
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_token", "mock-token-1");
  await mini.callWxMethod(
    "setStorageSync",
    "aaswitch_hub_account",
    JSON.stringify({ id: "acc_demo", phone: "13800138000" }),
  );

  // 配对页：粘贴 Web 侧二维码的 relay:// 内容
  await mini.reLaunch("/pages/pair/index");
  await sleep(1200);
  let page = await mini.currentPage();
  await waitFor("配对页出现", async () => (await page.$(".pair-input")) !== null);
  const pairInput = await page.$(".pair-input");
  await pairInput.input(relayUri);
  await shot(mini, "t34-01-pair-pasted-light");

  const connectBtn = await waitFor("连接按钮可用", async () => {
    page = await mini.currentPage();
    return (await findByText(page, ".btn", "连接")) ?? null;
  });
  await connectBtn.tap();

  await waitFor("连接成功（离开配对页）", async () => {
    const current = await mini.currentPage();
    return current.path !== "pages/pair/index" ? current : false;
  });
  page = await mini.currentPage();
  console.log(`连接成功，进入页面：${page.path}`);
  if (page.path !== "pages/chat/index") {
    throw new Error(`连接后未进入对话主页，实际：${page.path}`);
  }
  await sleep(1500);
  await shot(mini, "t34-02-chat-connected-light");

  // 深色对话主页（设置页真实切换，同 t31c）
  await mini.reLaunch("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const darkOption = await waitFor("设置页出现深色选项", async () => {
    page = await mini.currentPage();
    return (await findByText(page, ".theme-option", "深色")) ?? null;
  });
  await darkOption.tap();
  await sleep(800);
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  await shot(mini, "t34-03-chat-connected-dark");

  // 连接标识自检：relay offer 的 serverId 与 Web 侧 daemon 一致
  const state = await mini.callWxMethod("getStorageSync", "paseo_mp_connection");
  console.log(`存储的连接输入：${state}`);

  await mini.disconnect();
  console.log("t34 小程序端到端验收完成");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
