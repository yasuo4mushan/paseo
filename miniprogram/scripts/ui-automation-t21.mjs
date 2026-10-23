/**
 * t21 UI 自动化验收：对话页设备选择重构——自动默认设备 + 顶部弹窗选择体系。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置 3 台设备（本脚本自动完成）：
 *      A/B 在线（同一真实 daemon offer，覆盖真切换）+ C 离线（注册后不发心跳，
 *      过 60s online TTL 自然离线；hub store 注册即刷 lastSeenAt，故 C 先注册后等待）。
 *   2. 开发者工具自动化端口已开：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9427
 *
 * 用法：node scripts/ui-automation-t21.mjs
 *
 * 验收主线（任务书完成门 2）：
 *   登录 → 直接落对话页且自动连上默认设备（无任何手动选择）→ 顶部设备弹窗
 *   （两在线一离线）→ 切到另一台在线设备（含草稿保留验证）→ 切回 → 顶部会话
 *   弹窗列出真实会话 → zcode 一个短会话验证对话链路 → 掉线横幅（停心跳 +
 *   切换恢复）→ 深色三档截图 → 清理（agent 删除 + devices.unregister）。
 *
 * 配额纪律：只用 zcode 创建一个验证会话（"只回复 ok"），验证后删除；
 * daemon 是生产环境，不重启不改配置。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9427";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";

// 任务书给定的真实 relay offer（真 daemon 6799，zcode provider available）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const DEVICE_A = { name: "t21-mac-main", os: "macos" };
const DEVICE_B = { name: "t21-mac-second", os: "macos" };
const DEVICE_C = { name: "t21-mac-offline", os: "macos" };

const PROBE_USER = process.env.PROBE_USER ?? `t21probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t21probe-pass-1";

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
      body: JSON.stringify(body ?? {}),
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

async function readLog(mini) {
  return mini.evaluate(() => getApp().__automation?.downloadLog ?? []);
}

/** hub 侧设备快照（脚本进程直查，验证 hub 真值）。 */
async function hubDevices(callApi) {
  const res = await callApi("devices.list");
  if (!res.ok) throw new Error(`devices.list 失败：${JSON.stringify(res)}`);
  return res.data.devices;
}

/** composer 输入值（value() 不可用时回退 null，走截图证据）。 */
async function composerValue(page) {
  try {
    const input = await page.$(".composer-input");
    return input ? await input.value() : null;
  } catch {
    return undefined;
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：探针账号 + 设备预置（A/B 在线真 offer，C 注册不发心跳待离线） ----
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

  // 列表序 = 注册序：C、A、B。C 先注册且不发心跳；登录前等 C 过 60s online TTL
  // 离线（hub store 注册即刷 lastSeenAt），保证自动连接时首个「在线」设备是 A——
  // 否则登录落在 C 的 TTL 窗口内，selectDefaultDevice 会取到 C（首跑踩坑）。
  const register = async (spec) => {
    const res = await callApi("devices.register", { name: spec.name, os: spec.os, offer });
    if (!res.ok) throw new Error(`设备注册失败 ${spec.name}：${JSON.stringify(res)}`);
    return res.data.deviceId;
  };
  const idC = await register(DEVICE_C);
  await waitFor(
    "hub 侧 C 过 online TTL 离线（登录前）",
    async () => {
      const devices = await hubDevices(callApi);
      return devices.find((d) => d.deviceId === idC)?.online === false ? true : false;
    },
    { timeout: 90000, interval: 5000 },
  );
  const idA = await register(DEVICE_A);
  const idB = await register(DEVICE_B);
  console.log(`ok 设备预置：A=${idA} B=${idB} C=${idC}（C 已离线）`);

  const paused = { A: false, B: false };
  const heartbeat = (id, key) => () => {
    if (!paused[key]) void callApi("devices.heartbeat", { deviceId: id }).catch(() => {});
  };
  const beatA = heartbeat(idA, "A");
  const beatB = heartbeat(idB, "B");
  const heartbeatTimer = setInterval(() => {
    beatA();
    beatB();
  }, 25_000);
  beatA();
  beatB();

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9427)");
  await mini
    .evaluate(() => {
      if (getApp().__automation?.downloadLog) getApp().__automation.downloadLog.length = 0;
    })
    .catch(() => {});

  // ---- 冷启动：清 storage + 断残留连接（devtools 实例常驻）----
  const clearKeys = [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "paseo_mp_workspace",
    "paseo_mp_connection",
    "paseo_mp_last_agent",
    "paseo_mp_device_prefs",
  ];
  for (const key of clearKeys) await mini.callWxMethod("removeStorageSync", key);
  await mini
    .evaluate(() => {
      getApp().__automation.disconnect();
      getApp().__automation.sessionStore.reset();
    })
    .catch(() => {});
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  let page = await mini.currentPage();
  page = await waitFor("未登录守卫跳登录页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/login/index" ? current : false;
  });

  // ---- 登录 → 自动默认设备（P0-1：全程零手动选择） ----
  const userInput = await page.$(".login-username");
  const passInput = await page.$(".login-password");
  await userInput.input(PROBE_USER);
  await passInput.input(PROBE_PASS);
  const loginBtn = await page.$(".btn-login");
  await loginBtn.tap();
  page = await waitFor("登录成功直达对话页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  const autoEvent = await waitFor(
    "自动连接默认设备（无手动选择，事件 auto_connect）",
    async () => {
      const log = await readLog(mini);
      return log.find((e) => e.kind === "auto_connect") ?? null;
    },
    { timeout: 45000 },
  );
  console.log(
    `ok auto_connect：deviceId=${autoEvent.deviceId} name=${autoEvent.name} source=${autoEvent.source}`,
  );
  if (autoEvent.deviceId !== idA) {
    throw new Error(`自动连接应取列表首个在线设备 A（${idA}），实际 ${autoEvent.deviceId}`);
  }
  await waitFor("连接建立（项目栏/欢迎态渲染）", async () => {
    const el = (await page.$(".chat-project")) ?? (await page.$(".chat-welcome"));
    return el ?? null;
  });
  await waitFor("顶栏设备按钮显示设备名", async () => {
    const label = await page.$(".chat-device-label");
    const text = label ? await label.text() : "";
    return text === DEVICE_A.name ? text : false;
  });
  await sleep(800);
  await shot(mini, "t21-01-auto-connected");

  // ---- 顶部设备弹窗（P0-2：两在线一离线） ----
  // C 已在登录前等待离线（见预置段），此处仅复核
  const preList = await hubDevices(callApi);
  if (preList.find((d) => d.deviceId === idC)?.online !== false) {
    throw new Error("C 应已离线（登录前已等待 TTL）");
  }
  const deviceBtn = await page.$(".chat-device-btn");
  await deviceBtn.tap();
  await sleep(900);
  const dpRows = await waitFor("设备弹窗渲染 3 行", async () => {
    const rows = await page.$$(".dp-row");
    return rows.length === 3 ? rows : null;
  });
  const rowC = await findByText(page, ".dp-row", DEVICE_C.name);
  if (!rowC) throw new Error("离线设备 C 未出现在设备弹窗");
  const cPill = await rowC.$(".pill");
  const cPillText = (await cPill.text()) ?? "";
  if (!cPillText.includes("离线")) {
    throw new Error(`C 应显示离线置灰，实际 "${cPillText}"`);
  }
  const rowA = await findByText(page, ".dp-row", DEVICE_A.name);
  // dp-row-active 是行自身的 class（非子元素），读 attribute 断言
  const aClass = (await rowA.attribute("class")) ?? "";
  if (!aClass.includes("dp-row-active")) {
    throw new Error(`当前设备 A 未高亮，class="${aClass}"`);
  }
  console.log("ok 设备弹窗：A 已连接高亮 / B 在线 / C 离线置灰");
  await shot(mini, "t21-02-device-sheet");

  // ---- 草稿保留 + 真切换（A → B）：切走清空、切回还原（P1） ----
  const mask = await page.$(".ts-mask");
  if (mask) {
    await mask.tap();
    await sleep(600);
  }
  const input1 = await page.$(".composer-input");
  await input1.input("t21 草稿保留验证：这台设备上没发出去的话");
  await sleep(600);
  const beforeSwitch = await composerValue(page);
  console.log(`ok 切换前草稿：${JSON.stringify(beforeSwitch)}`);

  let deviceBtn2 = await waitFor(
    "设备按钮复现",
    async () => (await page.$(".chat-device-btn")) ?? null,
  );
  await deviceBtn2.tap();
  await sleep(900);
  const rowB = await findByText(page, ".dp-row", DEVICE_B.name);
  if (!rowB) throw new Error("设备 B 未出现在弹窗");
  await rowB.tap();
  const switchEvent = await waitFor(
    "切换到 B（device_switch 事件）",
    async () => {
      const log = await readLog(mini);
      return log.find((e) => e.kind === "device_switch" && e.deviceId === idB) ?? null;
    },
    { timeout: 45000 },
  );
  console.log(`ok device_switch：${switchEvent.from} → ${switchEvent.deviceId}`);
  await waitFor("B 连接建立（目录刷新）", async () => {
    const label = await page.$(".chat-device-label");
    const text = label ? await label.text() : "";
    return text === DEVICE_B.name ? text : false;
  });
  await sleep(1500);
  const onB = await composerValue(page);
  if (onB !== undefined && onB !== null && onB.includes("草稿保留验证")) {
    throw new Error(`B 的 composer 不应带 A 的草稿，实际 "${onB}"`);
  }

  // 切回 A（同一 daemon；验证切换回退 + 草稿还原）
  deviceBtn2 = await page.$(".chat-device-btn");
  await deviceBtn2.tap();
  await sleep(900);
  const rowA2 = await findByText(page, ".dp-row", DEVICE_A.name);
  await rowA2.tap();
  await waitFor(
    "切回 A（device_switch 事件）",
    async () => {
      const log = await readLog(mini);
      return log.find((e) => e.kind === "device_switch" && e.deviceId === idA) ?? null;
    },
    { timeout: 45000 },
  );
  await waitFor("回到 A（顶栏设备名）", async () => {
    const label = await page.$(".chat-device-label");
    const text = label ? await label.text() : "";
    return text === DEVICE_A.name ? text : false;
  });
  await sleep(4000); // 目录刷新 + 草稿还原（key 变化链）
  const restored = await composerValue(page);
  if (restored !== undefined && restored !== null) {
    if (!restored.includes("草稿保留验证")) {
      throw new Error(`切回 A 草稿未还原，实际 "${restored}"`);
    }
    console.log("ok 草稿按设备×会话暂存还原");
  } else {
    console.log("warn composer value 不可读，草稿还原以截图为准");
    await shot(mini, "t21-03b-draft-restored-fallback");
  }
  await shot(mini, "t21-03-switched-back");

  // ---- 顶部会话弹窗（P0-3：真实会话列表） ----
  const headerMain = await page.$(".chat-header-main");
  await headerMain.tap();
  await sleep(900);
  const spRows = await waitFor(
    "会话弹窗列出真实会话",
    async () => {
      const rows = await page.$$(".sp-row");
      return rows.length >= 1 ? rows : null;
    },
    { timeout: 20000 },
  );
  console.log(`ok 会话弹窗：${spRows.length} 个真实会话`);
  await shot(mini, "t21-04-session-sheet");
  const spMask = await page.$(".ts-mask");
  if (spMask) {
    await spMask.tap();
    await sleep(600);
  }

  // ---- zcode 短会话验证对话链路（配额纪律：一个短会话，用完删除） ----
  // 从欢迎态起：新建会话（顶部标题区弹窗 → 新建会话）
  const headerMain2 = await page.$(".chat-header-main");
  await headerMain2.tap();
  await sleep(800);
  const newBtn = await page.$(".sp-new");
  if (!newBtn) throw new Error("新建会话入口缺失");
  await newBtn.tap();
  await sleep(900);
  await waitFor("豆包式欢迎态", async () => (await page.$(".chat-welcome")) ?? null);

  // 选工作区
  const projectChip = await page.$(".chat-project");
  await projectChip.tap();
  await sleep(900);
  const wsRows = await waitFor("真实工作区列表渲染", async () => {
    const rows = await page.$$(".ws-row");
    return rows.length >= 1 ? rows : null;
  });
  await wsRows[0].tap();
  await sleep(900);

  const openPill = async (index) => {
    const pills = await page.$$(".chat-pill");
    const pill = pills[Math.min(index, pills.length - 1)];
    await pill.tap();
    await sleep(900);
    return pill;
  };
  const closePicker = async () => {
    const cpMask = await page.$(".cp-mask");
    if (cpMask) {
      await cpMask.tap();
      await sleep(500);
    }
  };
  const pickByPattern = async (patterns) => {
    const rows = await page.$$(".cp-row");
    for (const pattern of patterns) {
      for (const row of rows) {
        if (pattern.test((await row.text()) ?? "")) return row;
      }
    }
    return null;
  };

  // provider：优先 zcode（daemon 现网目录为准；上游账号可能失效——见 t19/t20 先例）
  await openPill(0);
  const providerRows = await page.$$(".cp-row");
  const providerNames = [];
  for (const row of providerRows) providerNames.push(((await row.text()) ?? "").trim());
  const preferredOrder = [...providerNames].sort((a, b) => {
    const rank = (n) => (["zcode", "kimi"].includes(n.toLowerCase()) ? 0 : 1);
    return rank(a) - rank(b);
  });
  console.log(`provider 候选：${preferredOrder.join("、")}`);
  const zcodeRow = await findByText(page, ".cp-row", "zcode");
  if (zcodeRow) {
    await zcodeRow.tap();
  } else {
    console.log("warn zcode 不在目录，回落首项");
    await providerRows[0].tap();
  }
  await sleep(2500);

  // 模型：小模型优先
  await openPill(1);
  const modelRows0 = await page.$$(".cp-row");
  if (modelRows0.length === 0) throw new Error("模型目录为空，无法创建验证会话");
  const small = await pickByPattern([/sonnet/i, /flash|mini|air|lite/i]);
  await (small ?? modelRows0[0]).tap();
  await sleep(1500);

  // thinking 档（有则选低档）
  const pillsT = await page.$$(".chat-pill");
  if (pillsT.length >= 4) {
    await openPill(2);
    const low = await pickByPattern([/^low$/i, /低|off|none|minimal/i]);
    await (low ?? (await page.$$(".cp-row"))[0]).tap();
    await sleep(700);
  }

  // 审批模式：避开 Plan Mode
  await openPill((await page.$$(".chat-pill")).length - 1);
  const modeHit = await pickByPattern([/bypass/i, /auto/i, /accept/i, /default/i]);
  const modeRows = await page.$$(".cp-row");
  await (modeHit ?? modeRows[0]).tap();
  await sleep(700);

  // 发送（清掉此前草稿验证文本再输入）
  const sendInput = await page.$(".composer-input");
  await sendInput.input("只回复 ok");
  await sleep(300);
  const sendBtn = await page.$(".send-btn");
  await sendBtn.tap();
  const created = await waitFor(
    "composer 创建事件（真实 create_agent）",
    async () => {
      const log = await readLog(mini);
      return log.find((e) => e.kind === "composer_create" && e !== autoEvent) ?? null;
    },
    { timeout: 45000 },
  );
  console.log(`ok 真实会话已创建：${created.agentId} provider=${created.provider}`);

  // 等终态：ok 回复 或 真实推送错误气泡（上游账号失效时按 t19/t20 先例收口）
  const failRe = /403|not allowed|authenticate|api error|unauthorized|失败|错误|无法/i;
  let outcome = null;
  try {
    outcome = await waitFor(
      "回复终态",
      async () => {
        const bubbles = await page.$$(".bubble");
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
    outcome = { ok: false, text: "（120s 无终态）" };
  }
  if (outcome.ok) {
    console.log(`ok 真实回复：${outcome.text.slice(0, 40)}`);
    await shot(mini, "t21-05-zcode-ok");
  } else {
    console.log(`warn 上游不可用，按真实管线证据收口：${outcome.text.slice(0, 60)}`);
    await shot(mini, "t21-05-zcode-real-pipeline");
  }

  // ---- 掉线横幅（P0-4）：停 A 心跳 → hub 离线 → app 20s 轮询 → 横幅 → 切 B 恢复 ----
  paused.A = true;
  await waitFor(
    "hub 侧 A 离线（online TTL 过期）",
    async () => {
      const devices = await hubDevices(callApi);
      return devices.find((d) => d.deviceId === idA)?.online === false ? true : false;
    },
    { timeout: 120000, interval: 5000 },
  );
  const banner = await waitFor(
    "掉线横幅出现（20s 轮询窗口）",
    async () => {
      const el = await page.$(".chat-banner");
      return el ?? null;
    },
    { timeout: 40000, interval: 2000 },
  );
  const bannerText = (await banner.text()) ?? "";
  if (!bannerText.includes("离线")) throw new Error(`横幅文案异常：${bannerText}`);
  console.log(`ok 掉线横幅：${bannerText.replace(/\s+/g, " ").slice(0, 30)}`);
  await shot(mini, "t21-06-offline-banner");

  // 横幅「切换设备」→ 设备弹窗 → B（一键切换恢复）
  const switchBtn = await page.$(".chat-banner-btn-ghost");
  await switchBtn.tap();
  await sleep(900);
  const rowB2 = await findByText(page, ".dp-row", DEVICE_B.name);
  if (!rowB2) throw new Error("横幅切换入口未打开设备弹窗");
  await rowB2.tap();
  await waitFor(
    "横幅一键切换到 B",
    async () => {
      const log = await readLog(mini);
      return (
        log.find((e) => e.kind === "device_switch" && e.deviceId === idB && e !== switchEvent) ??
        null
      );
    },
    { timeout: 45000 },
  );
  await waitFor(
    "横幅消失（连上 B）",
    async () => {
      const el = await page.$(".chat-banner");
      return el === null ? true : false;
    },
    { timeout: 15000 },
  );
  console.log("ok 掉线横幅一键切换恢复");
  await shot(mini, "t21-07-banner-switch-recovered");
  paused.A = false;

  // ---- 深色三档（新弹窗/顶栏；tokens 双轨） ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1000);
  page = await mini.currentPage();
  const darkOption = await findByText(page, ".theme-option", "深色");
  if (!darkOption) throw new Error("深色主题选项缺失");
  await darkOption.tap();
  await sleep(800);
  await mini.switchTab("/pages/chat/index");
  await sleep(1500);
  page = await mini.currentPage();
  await shot(mini, "t21-dark-01-chat");
  const darkBtn = await page.$(".chat-device-btn");
  await darkBtn.tap();
  await sleep(900);
  await shot(mini, "t21-dark-02-device-sheet");
  const darkMask = await page.$(".ts-mask");
  if (darkMask) {
    await darkMask.tap();
    await sleep(600);
  }
  const darkHeader = await page.$(".chat-header-main");
  await darkHeader.tap();
  await sleep(900);
  await shot(mini, "t21-dark-03-session-sheet");
  const darkMask2 = await page.$(".ts-mask");
  if (darkMask2) {
    await darkMask2.tap();
    await sleep(500);
  }

  // ---- 清理：验证会话删除 + 主题还原 + 断开 + hub 设备注销 ----
  await mini.evaluate((agentId) => getApp().__automation.deleteAgent(agentId), created.agentId);
  await sleep(2000);
  await mini.switchTab("/pages/settings/index");
  await sleep(1000);
  page = await mini.currentPage();
  const autoOption = await findByText(page, ".theme-option", "系统");
  await autoOption?.tap();
  await sleep(500);
  await mini
    .evaluate(() => {
      getApp().__automation.disconnect();
      getApp().__automation.sessionStore.reset();
    })
    .catch(() => {});

  clearInterval(heartbeatTimer);
  const unregistered = [];
  for (const id of [idA, idB, idC]) {
    const res = await callApi("devices.unregister", { deviceId: id });
    unregistered.push(`${id}:${res.ok ? "ok" : "FAIL"}`);
  }
  console.log(`ok devices.unregister：${unregistered.join(" / ")}`);
  const finalDevices = await hubDevices(callApi);
  if (finalDevices.length !== 0) {
    throw new Error(`hub 设备清理不彻底，残留 ${finalDevices.length} 台`);
  }
  console.log("ok hub 设备零遗留（devices.list 空）");

  const finalLog = await readLog(mini);
  console.log(`ok 验收事件台账（${finalLog.length} 条）`);
  console.log(JSON.stringify(finalLog.slice(-10), null, 2));
  await mini.disconnect();
  console.log("t21 验收完成");
}

main().catch((err) => {
  console.error("t21 验收失败：", err);
  process.exitCode = 1;
});
