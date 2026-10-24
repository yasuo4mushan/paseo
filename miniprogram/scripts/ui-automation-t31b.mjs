/**
 * t31-b UI 自动化验收：新建工作区页目录输入逐级点选（folder-picker 接入）。
 *
 * 前置（本脚本外启动，端口为本任务专属）：
 *   1. 隔离 daemon：PASEO_HOME=/tmp/t31b-home PASEO_LISTEN=0.0.0.0:6795
 *      （fresh home 无密码 → 直连 ws 即 owner；模拟器屏蔽 ws://127.0.0.1 回环，
 *       统一走 LAN IP —— 与 ui-automation.mjs mock hub 同款绕法）
 *   2. mock hub：node scripts/mock-hub.mjs 6793（登录 gate 用）
 *   3. 开发者工具自动化端口：
 *      <cli> auto --project <worktree>/miniprogram --auto-port 9421
 *
 * 用法：node scripts/ui-automation-t31b.mjs
 *
 * 验收链路：
 *   mock hub 登录 → 手动配对直连隔离 daemon（LAN IP ws）→ agents 页工作区栏
 *   「新建工作区」入口 → 注册本机目录模式：folder-picker 初始态（home 列表）→
 *   逐级点选两级真实目录（面包屑变化）→「选择此文件夹」→ 已选摘要（完整路径
 *   高亮回显）→「高级」折叠手输（展开/收起，能力保留）→ 注册为工作区 →
 *   open_project 成功返回列表、workspaceStore 持有新工作区 → GitHub 克隆模式：
 *   目标父目录同样点选（共享浏览位置）→ 深色版截图。
 *
 * 产物（docs/screenshots/t31b-*.png）：
 *   01 点选器初始态            02 点入两级（面包屑/高亮）
 *   03 已选摘要（完整路径）    04 高级手输折叠展开
 *   05 注册成功（agents 页）   06 GitHub 模式目标父目录点选
 *   07 深色版
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { networkInterfaces } from "node:os";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9421";

// 模拟器屏蔽 ws://127.0.0.1 回环：mock hub 与 daemon 直连都走 LAN IP
function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
const LAN = process.env.T31B_LAN_IP ?? lanIp();
const HUB_BASE = `http://${LAN}:6793/api`;
const DAEMON_WS = `ws://${LAN}:6795/ws`;

const DEMO_PHONE = "13800138000";
const DEMO_PASS = "demo12345";

// 预置的两级真实目录（~/t31b-demo/demo-api，脚本外 mkdir）
const LEVEL1 = "t31b-demo";
const LEVEL2 = "demo-api";

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

/** 每步重新查询元素（automator 句柄随重渲染失效；容器内按文本匹配子元素）。 */
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
  return segments.slice(1); // 首段是根标签
}

/** 设置页 cell 按 label 精确匹配（includes 会撞副标题文案，如「管理设备」含"手动配对"）。 */
async function findCellByLabel(page, label) {
  const cells = await page.$$(".cell-tappable");
  for (const cell of cells) {
    const labelEl = await cell.$(".cell-label");
    const text = labelEl ? ((await labelEl.text()) ?? "").trim() : "";
    if (text === label) return cell;
  }
  return null;
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`LAN=${LAN} hub=${HUB_BASE} daemon=${DAEMON_WS}`);
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9421)");

  // ---- 清态 → mock hub 登录 ----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  // 显式浅色档（devtools 宿主系统外观常为深色，跟随系统会把浅色截成深色）
  await mini.callWxMethod("setStorageSync", "aaswitch_theme_pref", "light");
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", HUB_BASE);
  await mini.reLaunch("/pages/login/index");
  await sleep(1500);
  let page = await mini.currentPage();
  await waitFor("登录页出现", async () => (await page.$(".login-phone")) !== null);
  const userInput = await page.$(".login-phone");
  const passInput = await page.$(".login-password");
  await userInput.input(DEMO_PHONE);
  await passInput.input(DEMO_PASS);
  await (await page.$(".btn-login")).tap();
  page = await waitFor("登录成功落对话主页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  await sleep(800);

  // ---- 手动配对：直连隔离 daemon（LAN IP ws，绕模拟器回环屏蔽） ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const pairCell = await waitFor(
    "设置页手动配对入口",
    async () => (await findCellByLabel(page, "手动配对")) ?? null,
  );
  await pairCell.tap();
  page = await waitFor("进入配对页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/pair/index" ? current : false;
  });
  const pairInput = await page.$(".pair-input");
  await pairInput.input(DAEMON_WS);
  await (await page.$(".btn")).tap();
  page = await waitFor(
    "直连隔离 daemon 成功落对话主页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    },
    { timeout: 30000 },
  );
  await sleep(1000);

  // ---- 真实入口：agents 页工作区栏 → 新建工作区 ----
  await mini.navigateTo("/pages/agents/index");
  await sleep(1500);
  page = await mini.currentPage();
  await waitFor("工作区栏出现", async () => (await page.$(".ws-bar-main")) ?? null);
  await (await page.$(".ws-bar-main")).tap();
  await sleep(800);
  const newRow = await waitFor(
    "新建工作区入口行",
    async () => (await page.$(".ws-new-row")) ?? null,
  );
  await newRow.tap();
  page = await waitFor("进入新建工作区页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/new-workspace/index" ? current : false;
  });

  // ---- ① 点选器初始态（默认注册本机目录模式） ----
  await waitFor("folder-picker 面板渲染", async () => (await page.$(".fp-panel")) ?? null);
  await waitFor("真实目录列表渲染（home）", async () => {
    const rows = await page.$$(".fp-row");
    return rows.length >= 1 ? rows : null;
  });
  await waitFor("高级折叠行存在", async () => (await page.$(".nws-adv")) ?? null);
  await sleep(600);
  await shot(mini, "t31b-01-picker-initial");

  // ---- ② 逐级点选两级真实目录（面包屑变化） ----
  const row1 = await waitFor(
    `home 下存在 ${LEVEL1} 目录行`,
    async () => (await findByText(page, ".fp-row", LEVEL1, ".fp-row-name")) ?? null,
  );
  await row1.tap();
  await waitFor(`进入第一级 ${LEVEL1}`, async () => {
    const trail = await pickerTrail(page);
    return trail[trail.length - 1] === LEVEL1 ? trail : null;
  });
  const row2 = await waitFor(
    `${LEVEL1} 下存在 ${LEVEL2} 目录行`,
    async () => (await findByText(page, ".fp-row", LEVEL2, ".fp-row-name")) ?? null,
  );
  await row2.tap();
  await waitFor(`进入第二级 ${LEVEL2}`, async () => {
    const trail = await pickerTrail(page);
    return trail.length >= 2 && trail[trail.length - 1] === LEVEL2 ? trail : null;
  });
  await sleep(400);
  await shot(mini, "t31b-02-picker-two-levels");
  const trailNow = await pickerTrail(page);
  console.log(`ok 两级点选完成：/${trailNow.join("/")}`);

  // ---- ③ 确认选择 → 已选摘要（完整路径回显） ----
  await (await page.$(".fp-confirm")).tap();
  const summary = await waitFor("已选摘要出现", async () => (await page.$(".nws-picked")) ?? null);
  const summaryPath = await summary.$(".nws-picked-path");
  const summaryPathText = (await summaryPath.text()) ?? "";
  console.log(`ok 已选路径回显：${summaryPathText}`);
  if (!summaryPathText.includes(LEVEL1) || !summaryPathText.includes(LEVEL2)) {
    throw new Error(`已选摘要路径异常：${summaryPathText}`);
  }
  const effective = await page.$(".nws-effective");
  const effectiveText = effective ? ((await effective.text()) ?? "") : "";
  if (!effectiveText.includes(LEVEL2)) throw new Error(`生效路径回显异常：${effectiveText}`);
  await sleep(300);
  await shot(mini, "t31b-03-selected-summary");

  // ---- ④ 高级折叠手输（能力保留；展开互斥隐藏点选，收起恢复摘要） ----
  await (await page.$(".nws-adv")).tap();
  const manualInput = await waitFor("高级手输框展开", async () => (await page.$(".field-input")) ?? null);
  await sleep(300);
  await shot(mini, "t31b-04-advanced-manual");
  // 手输生效优先：输入一个绝对路径，nws-effective 应切到手输值
  await manualInput.input("/tmp/manual-override");
  await waitFor("手输路径优先生效", async () => {
    const el = await page.$(".nws-effective");
    const text = el ? ((await el.text()) ?? "") : "";
    return text.includes("/tmp/manual-override") ? text : null;
  });
  // 收起 → 回到已选摘要（点选结果仍在）
  await (await page.$(".nws-adv")).tap();
  await waitFor("收起后恢复已选摘要", async () => (await page.$(".nws-picked")) ?? null);

  // ---- ⑤ 注册为工作区（open_project 真实链路） ----
  const registerBtn = await findByText(page, ".btn-block", "注册为工作区");
  await registerBtn.tap();
  page = await waitFor(
    "注册成功返回 agents 页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agents/index" ? current : false;
    },
    { timeout: 30000 },
  );
  // evaluate 只回传可序列化小对象（直接回 store 快照会拿到 undefined）
  const snapshot = await mini.evaluate(() => {
    const snap = getApp().__automation?.workspaceStore?.getSnapshot?.();
    return snap
      ? { directory: snap.directory, label: snap.label, workspaceId: snap.workspaceId }
      : null;
  });
  const wsDir = snapshot?.directory ?? "";
  console.log(`ok workspaceStore：${JSON.stringify(snapshot).slice(0, 160)}`);
  if (!wsDir.includes(LEVEL1) || !wsDir.includes(LEVEL2)) {
    throw new Error(`注册后工作区目录异常：${wsDir}`);
  }
  await sleep(800);
  await shot(mini, "t31b-05-registered");

  // ---- ⑥ GitHub 克隆模式：目标父目录同样点选（共享浏览位置 → 从 demo-api 起） ----
  const wsBar2 = await waitFor("工作区栏（GitHub 模式入口）", async () => {
    const current = await mini.currentPage();
    return (await current.$(".ws-bar-main")) ?? null;
  });
  await wsBar2.tap();
  await sleep(800);
  const newRow2 = await waitFor(
    "新建工作区入口行（第二次）",
    async () => (await page.$(".ws-new-row")) ?? null,
  );
  await newRow2.tap();
  page = await waitFor("再次进入新建工作区页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/new-workspace/index" ? current : false;
  });
  const githubChip = await waitFor("GitHub 克隆 chip", async () => {
    const current = await mini.currentPage();
    return (await findByText(current, ".chip", "GitHub 克隆")) ?? null;
  });
  await githubChip.tap();
  await waitFor("目标父目录 folder-picker 渲染", async () => (await page.$(".fp-panel")) ?? null);
  await waitFor("目录列表渲染（home，重进页面后从根导航属预期）", async () => {
    const rows = await page.$$(".fp-row");
    return rows.length >= 1 ? rows : null;
  });
  const ghRow = await waitFor(
    `GitHub 模式：home 下 ${LEVEL1} 目录行`,
    async () => (await findByText(page, ".fp-row", LEVEL1, ".fp-row-name")) ?? null,
  );
  await ghRow.tap();
  await waitFor(`进入父目录 ${LEVEL1}`, async () => {
    const trail = await pickerTrail(page);
    return trail[trail.length - 1] === LEVEL1 ? trail : null;
  });
  await (await page.$(".fp-confirm")).tap();
  await waitFor("GitHub 模式已选摘要出现", async () => (await page.$(".nws-picked")) ?? null);
  const ghSummary = await page.$(".nws-picked-path");
  const ghPath = ghSummary ? ((await ghSummary.text()) ?? "") : "";
  console.log(`ok GitHub 目标父目录：${ghPath}`);
  if (!ghPath.includes(LEVEL1)) throw new Error(`GitHub 目标父目录摘要异常：${ghPath}`);
  await sleep(400);
  await shot(mini, "t31b-06-github-picker");

  // ---- ⑦ 深色版（设置页切深色 → 回新建工作区页） ----
  await mini.navigateBack();
  await sleep(600);
  await mini.switchTab("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  const darkOption = await waitFor(
    "深色选项",
    async () => (await findByText(page, ".theme-option", "深色")) ?? null,
  );
  await darkOption.tap();
  await sleep(800);
  await mini.navigateTo("/pages/new-workspace/index");
  await sleep(1200);
  page = await mini.currentPage();
  await waitFor("深色档 class 生效", async () => (await page.$(".theme-dark")) ?? null);
  // 注册本机目录模式点选器初始态（深色）
  await waitFor("深色下点选器渲染", async () => (await page.$(".fp-panel")) ?? null);
  await sleep(400);
  await shot(mini, "t31b-07-dark-picker");
  // GitHub 模式深色（已选摘要 + 高级折叠行）
  const githubChip2 = await findByText(page, ".chip", "GitHub 克隆");
  if (githubChip2) {
    await githubChip2.tap();
    await sleep(600);
    await shot(mini, "t31b-08-dark-github");
  }

  // ---- 清理：主题回浅色默认（写 storage，避免依赖设置页 UI）+ 断开连接 ----
  await mini.callWxMethod("setStorageSync", "aaswitch_theme_pref", "light");
  await mini
    .evaluate(() => {
      getApp().__automation?.disconnect?.();
    })
    .catch(() => {});
  await mini.disconnect();
  console.log("t31b 验收完成");
}

main().catch((err) => {
  console.error("t31b 验收失败：", err);
  process.exitCode = 1;
});
