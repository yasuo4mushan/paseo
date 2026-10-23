/**
 * t31a UI 自动化验收：对话页三入口显性化（新建对话按钮 / 项目文件侧滑面板 /
 * 导入已有会话入口）。
 *
 * 隔离环境（不碰 6767/6799）：
 *   - mock hub：MOCK_STATIC_DEVICES=0 node scripts/mock-hub.mjs 6794（隐藏固定
 *     设备，自动连接只会选到隔离 daemon；本脚本不启动，前置自备）
 *   - 隔离 daemon：PASEO_HOME=/tmp/t31a-home PASEO_LISTEN=127.0.0.1:6796
 *     PASEO_HUB_URL=http://127.0.0.1:6794 PASEO_HUB_TOKEN=mock-token-1
 *     PASEO_RELAY_ENABLED=true PASEO_RELAY_(PUBLIC_)ENDPOINT=remoteagent.agentsworkforyou.cn:80
 *     —— 设备经公网 relay 可达（模拟器屏蔽 ws://127.0.0.1 回环，走公网 relay 是
 *     既有 ui-automation 脚本的既定 workaround）
 *   - 演示工作区：/tmp/t31a-workspace（open_project 预注册）；idle 演示会话由
 *     daemon 侧 helper 预建（无 initialPrompt，不消耗配额）
 *
 * 前置：开发者工具 auto 端口已开（9420）：
 *   <cli> auto --project <worktree>/miniprogram --auto-port 9420
 *
 * 用法：HUB_BASE=http://<LAN-IP>:6794/api node scripts/ui-automation-t31a.mjs
 *
 * 产物（docs/screenshots/t31a-*.png）：
 *   01 对话页顶栏（新建/文件按钮）   02 文件面板（根目录，明色）
 *   03 文件面板子目录 + 面包屑       04 文件跳转预览（files 页）
 *   05 会话弹窗（新建/导入并排）     06 create 页导入 tab
 *   07 新建按钮点击后新会话欢迎态    08 文件面板（暗色档）
 */

import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9420";

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
const HUB_BASE = process.env.HUB_BASE ?? `http://${lanIp()}:6794/api`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const step = (msg) => console.log(`-- ${msg}`);

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
  console.log(`hub base = ${HUB_BASE}`);
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9420)");

  // ---- 冷启动：清态 → mock hub 登录 ----
  step("冷启动清态 + 登录");
  for (const key of [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "aaswitch_theme_pref",
    "paseo_mp_workspace",
    "paseo_mp_connection",
    "paseo_mp_last_agent",
  ]) {
    await mini.callWxMethod("removeStorageSync", key);
  }
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", HUB_BASE);
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  await waitFor("未登录守卫跳登录页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/login/index" ? current : false;
  });
  let page = await mini.currentPage();
  const userInput = await page.$(".login-phone");
  const passInput = await page.$(".login-password");
  await userInput.input("13800138000");
  await passInput.input("demo12345");
  await page.$(".btn-login").then((btn) => btn.tap());
  page = await waitFor("登录成功落对话主页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });

  // ---- 1. 自动连接隔离 daemon（记忆空 → 首个在线设备）----
  step("自动连接隔离 daemon");
  await waitFor(
    "自动连接隔离 daemon（顶栏设备按钮就绪）",
    async () => {
      const label = await page.$(".chat-device-label");
      return label ? ((await label.text()) ?? "").length > 0 : false;
    },
    { timeout: 45000 },
  );
  await waitFor("目录就绪（未连接横幅消失）", async () => (await page.$(".chat-banner")) === null);
  await sleep(800);

  // ---- 2. 顶栏显式按钮可见 ----
  step("顶栏新建/文件按钮");
  const newBtn = await waitFor(
    "顶栏【新建】按钮",
    async () => (await page.$(".chat-new-btn")) ?? null,
  );
  const newText = (await newBtn.text()) ?? "";
  if (!newText.includes("新建")) throw new Error(`新建按钮文案异常：${newText}`);
  await waitFor("顶栏【文件】按钮", async () => (await page.$(".chat-files-btn")) ?? null);
  await shot(mini, "t31a-01-chat-header");

  // ---- 3. 活跃会话就位（预建 idle 会话被 sessionStore 自动选中，cwd 即面板根）----
  step("活跃会话 + 项目目录标签");
  await waitFor("标题进入会话态（非新对话）", async () => {
    const title = await page.$(".chat-title");
    const text = title ? ((await title.text()) ?? "") : "";
    return text.length > 0 && !text.includes("新对话") ? text : false;
  });
  await waitFor("项目标签 = t31a-workspace（会话 cwd）", async () => {
    const label = await page.$(".chat-project-text");
    return label ? (await label.text()).includes("t31a-workspace") : false;
  });

  // ---- 4. 文件侧滑面板：根目录 ----
  step("文件面板根目录");
  await (await page.$(".chat-files-btn")).tap();
  await waitFor(
    "文件面板滑入（标题）",
    async () => (await page.$(".wfs-panel .wfs-title")) ?? null,
  );
  await waitFor("根目录条目（README.md 等）", async () => {
    const rows = await page.$$(".wfs-row");
    return rows.length >= 4 ? rows : null;
  });
  await sleep(400);
  await shot(mini, "t31a-02-files-panel-root");

  // ---- 5. 进入子目录 + 面包屑 + 返回上级 ----
  step("文件面板子目录导航");
  const srcRow = await waitFor(
    "src 目录行",
    async () => (await findByText(page, ".wfs-row", "src", ".wfs-row-name")) ?? null,
  );
  await srcRow.tap();
  await waitFor(
    "进入 src（greet.ts 可见）",
    async () => (await findByText(page, ".wfs-row", "greet.ts", ".wfs-row-name")) ?? null,
  );
  await sleep(300);
  await shot(mini, "t31a-03-files-panel-subdir");
  await sleep(300);
  const upBtn = await waitFor("返回上级按钮", async () => (await page.$(".wfs-up")) ?? null);
  await upBtn.tap();
  await waitFor(
    "返回根（README.md 回来）",
    async () => (await findByText(page, ".wfs-row", "README.md", ".wfs-row-name")) ?? null,
  );

  // ---- 6. 点文件 → files 页自动打开预览 ----
  step("文件跳转预览");
  await sleep(400);
  const readmeRow = await waitFor(
    "README.md 行",
    async () => (await findByText(page, ".wfs-row", "README.md", ".wfs-row-name")) ?? null,
  );
  await readmeRow.tap();
  page = await waitFor("跳转 files 页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/files/index" ? current : false;
  });
  await waitFor("文本预览自动打开（README.md）", async () => {
    const title = await page.$(".preview-title");
    return title ? (await title.text()).includes("README.md") : false;
  });
  await shot(mini, "t31a-04-file-preview");
  await mini.navigateBack();
  await sleep(1000);
  page = await waitFor("回到对话页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  // 关掉面板（文件按钮流程结束）
  const closeBtn = await waitFor("面板关闭按钮", async () => (await page.$(".wfs-close")) ?? null);
  await closeBtn.tap();
  await waitFor("面板已关", async () => (await page.$(".wfs-panel")) === null);

  // ---- 7. 会话弹窗：新建/导入并排；选中预建演示会话 ----
  step("会话弹窗 + 演示会话");
  await (await page.$(".chat-header-main")).tap();
  await waitFor("会话弹窗打开", async () => (await page.$(".sp-filters")) ?? null);
  await waitFor("底部【新建会话】按钮", async () => (await page.$(".sp-new")) ?? null);
  await waitFor("底部【导入已有会话】按钮", async () => (await page.$(".sp-import")) ?? null);
  await sleep(300);
  await shot(mini, "t31a-05-session-sheet");
  await (await page.$(".ts-close")).tap();
  await waitFor("会话弹窗关闭", async () => (await page.$(".sp-filters")) === null);

  // ---- 8. 导入入口 → create 页导入 tab ----
  step("导入入口 → create 页导入 tab");
  await (await page.$(".chat-header-main")).tap();
  await waitFor("会话弹窗再次打开", async () => (await page.$(".sp-import")) ?? null);
  await (await page.$(".sp-import")).tap();
  page = await waitFor("跳转 create 页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/create/index" ? current : false;
  });
  await waitFor("导入 tab 激活（?tab=import 直达）", async () => {
    const active = await page.$(".tab-item-active");
    return active ? (await active.text()).includes("导入已有会话") : false;
  });
  await waitFor(
    "导入面板就绪（历史目录或空态）",
    async () =>
      (await findByText(page, ".field-label", "Provider 侧历史会话")) ??
      (await page.$(".loading-tip")) ??
      null,
  );
  await sleep(400);
  await shot(mini, "t31a-06-import-tab");
  await mini.navigateBack();
  await sleep(1000);
  page = await waitFor("回到对话页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });

  // ---- 9. 新建按钮 → 快捷新对话（从活跃会话回欢迎态）----
  step("新建按钮 → 新会话欢迎态");
  await (await page.$(".chat-new-btn")).tap();
  await waitFor(
    "新会话欢迎态（有什么要做的？）",
    async () => (await page.$(".chat-welcome")) ?? null,
  );
  await sleep(400);
  await shot(mini, "t31a-07-new-chat-welcome");

  // ---- 10. 暗色档：文件面板 ----
  step("暗色档文件面板");
  await mini.callWxMethod("setStorageSync", "aaswitch_theme_pref", "dark");
  await mini.reLaunch("/pages/chat/index");
  await sleep(2500);
  page = await mini.currentPage();
  await waitFor("暗色档顶栏就绪", async () => (await page.$(".chat-new-btn")) ?? null);
  await (await page.$(".chat-files-btn")).tap();
  await waitFor("暗色档文件面板打开", async () => {
    const rows = await page.$$(".wfs-row");
    return rows.length >= 4 ? rows : null;
  });
  await sleep(400);
  await shot(mini, "t31a-08-files-panel-dark");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");

  // ---- 清理：断开连接，清会话回登录态（daemon/mock hub 由外部管理，不停）----
  step("清理");
  await mini
    .evaluate(() => {
      getApp().__automation?.disconnect?.();
      getApp().__automation?.sessionStore?.reset?.();
    })
    .catch(() => {});
  await mini.disconnect();
  console.log("t31a 验收完成");
}

main()
  .catch((err) => {
    console.error("t31a 验收失败：", err);
    process.exitCode = 1;
  })
  .finally(() => {
    // automator 的 WS 连接会吊住事件循环——显式退出，避免挂死
    process.exit(process.exitCode ?? 0);
  });
