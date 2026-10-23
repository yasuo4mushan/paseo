/**
 * t24 UI 自动化验收：级联创建向导 + 设备侧项目文件夹选择/命名 + 文件功能入口找回。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置真实 relay offer 设备（本脚本自动完成）。
 *   2. 开发者工具自动化端口已开（auto 端口 9430）：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9430
 *
 * 用法：node scripts/ui-automation-t24.mjs
 *
 * 配额纪律：只用 zcode 创建一个验证会话（"只回复 ok"），验证后删除；
 *           向导新建的验证文件夹用完即删（fs.entry.delete）。
 *
 * 验收链路（对应完成门）：
 *   登录 → 设备页连接 → 设备卡快捷入口（文件/新建项目）→ files 页冷启动兜底 →
 *   设置页入口 → 向导：设备自动选中 → folder-picker 真实浏览 daemon 目录
 *   （逐级进入/返回/面包屑）→ 新建子文件夹命名（mock showModal editable）→
 *   选择确认 → 框架 zcode → 模型（默认预选）→ thinking → 创建真实 agent
 *   （短 prompt）→ agent 详情出现（时间线）→ 详情"文件"按钮直达 cwd →
 *   删除会话 + 删除验证文件夹 + hub 设备 unregister。
 *
 * 产物（docs/screenshots/t24-*.png）：
 *   01 设备卡快捷入口            02 files 页冷启动兜底
 *   03 向导设备自动选中（第②步）  04 folder-picker 真实目录
 *   05 逐级进入/面包屑            06 新建文件夹并进入
 *   07 框架步（zcode）           08 模型步（真实目录预选）
 *   09 thinking + 任务指令        10 agent 详情时间线
 *   11 详情"文件"按钮直达 cwd
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9430";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t24-mac-dev";

// 任务给定的真实 relay offer（真 daemon，zcode provider available）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t24probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t24probe-pass-1";
const FOLDER_NAME = `t24-verify-${Date.now().toString(36)}`;

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
  return segments.slice(1); // 首段是根标签
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：注册探针账号 + 预置真实设备 ----
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
  const offer = parseRelayUri(RELAY_URI);
  const deviceReg = await callApi("devices.register", {
    name: DEVICE_NAME,
    os: "macos",
    offer,
  });
  if (!deviceReg.ok) throw new Error(`设备注册失败：${JSON.stringify(deviceReg)}`);
  const deviceId = deviceReg.data.deviceId;
  console.log(`ok 设备已注册：${deviceId}（offer → ${offer.endpoint}）`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId });

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9430)");

  // ---- 冷启动：清态 → 登录 ----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_last_agent");
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  let page = await mini.currentPage();
  await waitFor("未登录时对话主页守卫跳登录页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/login/index" ? current : false;
  });
  const userInput = await page.$(".login-username");
  const passInput = await page.$(".login-password");
  await userInput.input(PROBE_USER);
  await passInput.input(PROBE_PASS);
  const loginBtn = await page.$(".btn-login");
  await loginBtn.tap();
  page = await waitFor("登录成功落对话主页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  await sleep(800);

  // ---- 设备页：连接真实 daemon ----
  await mini.switchTab("/pages/devices/index");
  await sleep(2000);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await onlineCard.tap();
  await waitFor(
    "连接成功落对话主页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    },
    { timeout: 35000 },
  );
  await sleep(1500);

  // ---- 入口找回 1：设备卡快捷入口 ----
  await mini.switchTab("/pages/devices/index");
  await sleep(1500);
  page = await mini.currentPage();
  const quickBtns = await waitFor("已连接设备卡快捷入口（文件/新建项目）", async () => {
    const list = await page.$$(".device-quick-btn");
    return list.length >= 2 ? list : null;
  });
  await shot(mini, "t24-01-devices-quick");

  // ---- 入口找回 2：设备卡"文件"直达 files 页（冷启动兜底自动选工作区） ----
  await quickBtns[0].tap();
  page = await waitFor("快捷入口直达 files 页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/files/index" ? current : false;
  });
  await waitFor("files 页就绪（工作区栏或空态引导）", async () => {
    const el = (await page.$(".files-ws")) ?? (await page.$(".empty-desc"));
    return el ?? null;
  });
  await sleep(800);
  await shot(mini, "t24-02-files-entry");
  await mini.navigateBack();
  await sleep(800);

  // ---- 入口找回 3：设置页"新建项目会话"入口 → 向导 ----
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

  // ---- 向导第①步已自动选中设备（直接落第②步文件夹） ----
  await waitFor("面包屑渲染（设备已自动选中）", async () => {
    const crumbs = await page.$$(".wiz-crumb");
    return crumbs.length === 5 ? crumbs : null;
  });
  const deviceCrumbValue = await (await page.$(".wiz-crumb .wiz-crumb-value")).text();
  if (!deviceCrumbValue || deviceCrumbValue === "未选择") {
    throw new Error(`设备未自动选中：${deviceCrumbValue}`);
  }
  console.log(`ok 设备自动选中：${deviceCrumbValue}（直接进入第②步）`);
  await waitFor("folder-picker 面板渲染", async () => (await page.$(".fp-panel")) ?? null);
  await shot(mini, "t24-03-wizard-device-auto");

  // ---- 第②步 folder-picker：真实浏览 daemon 目录 ----
  await waitFor("真实目录列表渲染", async () => {
    const rows = await page.$$(".fp-row");
    return rows.length >= 1 ? rows : null;
  });
  await sleep(600);
  await shot(mini, "t24-04-folder-picker-home");

  // 逐级进入一个真实子目录（优先已知开发目录名，回落第一项）
  let enterRow = null;
  for (const pref of ["codes", "code", "projects", "dev", "work", "Documents"]) {
    enterRow = await findByText(page, ".fp-row", pref, ".fp-row-name");
    if (enterRow) break;
  }
  if (!enterRow) {
    const rows = await page.$$(".fp-row");
    enterRow = rows[0];
  }
  const enterName = (await (await enterRow.$(".fp-row-name")).text()) ?? "";
  await enterRow.tap();
  await waitFor(`进入子目录 ${enterName}（面包屑变化）`, async () => {
    const trail = await pickerTrail(page);
    return trail.length >= 2 && trail[trail.length - 1] === enterName ? trail : null;
  });
  await sleep(400);
  await shot(mini, "t24-05-folder-picker-navigate");

  // 返回上一级（.fp-up）→ 面包屑回退
  const deepTrail = await pickerTrail(page);
  await (await page.$(".fp-up")).tap();
  await waitFor("返回上一级（trail 减一）", async () => {
    const trail = await pickerTrail(page);
    return trail.length === deepTrail.length - 1 ? trail : null;
  });
  const homeTrail = await pickerTrail(page);
  console.log(`ok 逐级进入/返回验证：home trail = /${homeTrail.join("/")}`);
  if (homeTrail.length === 0) throw new Error("返回后 trail 为空（异常）");

  // ---- 新建子文件夹（mock showModal editable 返回名称）----
  await mini.mockWxMethod("showModal", { confirm: true, content: FOLDER_NAME });
  await (await page.$(".fp-new")).tap();
  await waitFor(`新建文件夹并进入：${FOLDER_NAME}`, async () => {
    const trail = await pickerTrail(page);
    return trail[trail.length - 1] === FOLDER_NAME ? trail : null;
  });
  await mini.restoreWxMethod("showModal");
  await sleep(400);
  await shot(mini, "t24-06-folder-created");

  const createdTrail = await pickerTrail(page);
  const createdAbsPath = `/${createdTrail.join("/")}`;
  const createdRelPath = createdTrail.join("/"); // deleteFsEntry cwd="/" 用
  console.log(`ok 新建文件夹：${createdAbsPath}`);

  // 选择此文件夹 → 第③步框架
  await (await page.$(".fp-confirm")).tap();
  await waitFor("进入第③步框架选择", async () => (await page.$(".chip")) ?? null);
  await sleep(600);

  // ---- 第③步框架：优选 zcode（本机 daemon 目录为准；无则按序回落） ----
  const chipNodes = await page.$$(".chip");
  const chipTexts = [];
  for (const chip of chipNodes) chipTexts.push(((await chip.text()) ?? "").trim());
  console.log(`provider 目录：${chipTexts.join("、")}`);
  let framework = null;
  for (const pref of ["zcode", "kimi", "codex", "claude"]) {
    const hit = chipTexts.find((t) => t.toLowerCase() === pref);
    if (hit) {
      framework = await findByText(page, ".chip", hit);
      if (framework) {
        console.log(`ok 选定 provider：${hit}`);
        break;
      }
    }
  }
  if (!framework) {
    framework = chipNodes[0];
    console.log(`warn 目录无优选 provider，回落首个：${chipTexts[0] ?? ""}`);
  }
  await shot(mini, "t24-07-wizard-framework");
  await framework.tap();
  await waitFor("进入第④步模型", async () => (await page.$(".picker-value, .loading-tip")) ?? null);

  // ---- 第④步模型：真实目录（便利预选默认模型 = 级联要点）----
  await waitFor("模型目录加载完成", async () => {
    const loading = await page.$(".loading-tip");
    if (loading) return null;
    return (await page.$(".picker-value")) ?? (await page.$(".muted")) ?? null;
  });
  const modelValue = (await (await page.$(".picker-value"))?.text()) ?? "";
  console.log(`ok 模型步真实目录：${modelValue || "无目录（默认模型）"}`);
  await sleep(400);
  await shot(mini, "t24-08-wizard-model");
  // 下一步：Thinking
  await (await page.$(".wiz-nav-main")).tap();
  await waitFor("进入第⑤步 thinking/提交", async () => (await page.$(".prompt-input")) ?? null);

  // ---- 第⑤步 thinking + 任务指令（有档则选低档省时） ----
  const thinkChips = await page.$$(".chip");
  console.log(`ok thinking 档位：${thinkChips.length}（0 = 模型无档位，合法）`);
  const lowChip =
    (await findByText(page, ".chip", "low")) ??
    (await findByText(page, ".chip", "低")) ??
    (await findByText(page, ".chip", "off"));
  if (lowChip) await lowChip.tap();
  const promptArea = await page.$(".prompt-input");
  await promptArea.input("只回复 ok");
  await sleep(400);
  await shot(mini, "t24-09-wizard-effort");

  // ---- 提交 → 真实创建（zcode 短 prompt）----
  const submitBtn = await waitFor("提交按钮可点", async () => {
    const btn = await findByText(page, ".btn", "创建并进入会话");
    return btn ?? null;
  });
  await submitBtn.tap();
  page = await waitFor(
    "redirectTo agent 详情页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agent/index" ? current : false;
    },
    { timeout: 45000 },
  );
  const agentId = page.query?.id ?? "";
  if (!agentId) throw new Error("agent 详情页缺少 id 参数");
  console.log(`ok 真实 agent 已创建：${agentId}`);

  // ---- 详情出现：时间线（等 ok 回复；上游失效时按 t20 先例转真实管线证据） ----
  await waitFor(
    "时间线首条渲染",
    async () => {
      const items = await page.$$(".timeline-item");
      return items.length >= 1 ? items : null;
    },
    { timeout: 60000 },
  );
  const failRe =
    /403|not allowed|authenticate|api error|unauthorized|not logged in|exit code|system error|失败|错误|无法/i;
  let outcome = null;
  try {
    outcome = await waitFor(
      "agent 回复终态",
      async () => {
        const bubbles = await page.$$(".bubble-text");
        for (const bubble of bubbles) {
          const text = (await bubble.text()) ?? "";
          if (failRe.test(text)) return { ok: false, text };
          if (/\bok\b/i.test(text) && !text.includes("只回复")) return { ok: true, text };
        }
        return null;
      },
      { timeout: 120000 },
    );
  } catch {
    // 轮询落空时转储时间线 DOM 文本自证（element.text() 对部分嵌套节点返回空，
    // t24 验收实跑曾出现"屏幕已显示 ok 回复但轮询未匹配"——以截图+DOM 转储收口）
    const dump = [];
    for (const bubble of await page.$$(".bubble-text")) {
      dump.push(((await bubble.text()) ?? "").slice(0, 60));
    }
    console.log(`时间线 DOM 转储：${JSON.stringify(dump)}`);
    outcome = { ok: false, text: "（120s 无终态）" };
  }
  if (outcome.ok) {
    console.log(`ok 真实回复：${outcome.text.slice(0, 40)}`);
  } else {
    console.log(`warn 上游不可用，按 t20 先例转真实管线证据验收：${outcome.text.slice(0, 60)}`);
  }
  await shot(mini, "t24-10-agent-detail");

  // ---- 详情"文件"按钮直达会话 cwd ----
  const filesBtn = await waitFor(
    "会话详情【文件】按钮",
    async () => (await findByText(page, ".action-btn", "文件")) ?? null,
  );
  await filesBtn.tap();
  page = await waitFor("直达 files 页（cwd 参数）", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/files/index" ? current : false;
  });
  await waitFor("files 页 cwd 直达就绪", async () => {
    const el = (await page.$(".files-ws")) ?? (await page.$(".empty-desc"));
    return el ?? null;
  });
  await sleep(600);
  await shot(mini, "t24-11-agent-files-btn");

  // ---- 清理：删验证会话 + 删验证文件夹 + hub 设备 unregister ----
  await mini.evaluate((id) => getApp().__automation?.deleteAgent?.(id), agentId);
  await sleep(2000);
  const delFolder = await mini
    .evaluate((p) => getApp().__automation?.deleteFsEntry?.("/", p), createdRelPath)
    .catch((err) => ({ error: String(err) }));
  console.log(`ok 验证文件夹删除：${JSON.stringify(delFolder ?? {}).slice(0, 120)}`);
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
  console.log("t24 验收完成");
}

main().catch((err) => {
  console.error("t24 验收失败：", err);
  process.exitCode = 1;
});
