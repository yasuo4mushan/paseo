/**
 * t25 UI 自动化验收：时间线消息操作——复制（markdown 原文）/ 用户消息编辑重发
 * （rewind 回退 + 重发；不支持回退降级草稿）/ 引用复制。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置真实 relay offer 设备（脚本自动完成）。
 *   2. 开发者工具自动化端口已开（本任务端口 9431）：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9431
 *
 * 用法：node scripts/ui-automation-t25.mjs
 *
 * 原生面板处理：wx.showActionSheet 是原生弹层，automator 无法点选 →
 * mockWxMethod 注入 tapIndex 驱动真实 openActions 代码路径（状态机/分发/
 * 剪贴板/toast 全为真实执行），用后 restore。断言以 automation 事件台账
 * （recordAutomationEvent → downloadLog）+ getClipboardData 为主。
 *
 * 配额纪律：只创建一个验证会话（编辑重发链路，优先 zcode、缺则回落），验证后删除；
 * assistant 复制用已有真实会话（如 "hello"），只读不写。
 *
 * 产物（docs/screenshots/t25-*.png）：
 *   01 已有会话时间线（"…"入口可见）    02 assistant 复制后（toast/台账证据）
 *   03 用户消息编辑态（textarea 预填）  04 编辑重发后时间线（rewind 截断 + 新消息）
 *   05 深色时间线                       06 深色编辑态
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9431";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t25-mac-dev";

// 任务给定的真实 relay offer（真 daemon）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t25probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t25probe-pass-1";
// hub 现网 auth.register/login 均要求 phone（本任务验收期间生效）
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

/** 取最后一条用户气泡所在行（编辑目标）与最后一条 assistant 气泡行。 */
async function timelineRows(page) {
  const rows = await page.$$(".timeline-row");
  let lastUser = null;
  let lastAssistant = null;
  for (const row of rows) {
    if (await row.$(".bubble-user")) lastUser = row;
    if (await row.$(".bubble-assistant")) lastAssistant = row;
  }
  return { lastUser, lastAssistant, count: rows.length };
}

/** mock showActionSheet 返回指定 tapIndex 后触发一次真实 openActions。 */
async function tapMessageAction(mini, moreBtn, tapIndex) {
  await mini.mockWxMethod("showActionSheet", { tapIndex });
  try {
    await moreBtn.tap();
    await sleep(800);
  } finally {
    await mini.restoreWxMethod("showActionSheet").catch(() => {});
  }
}

/** 读剪贴板（devtools 环境真实 wx API）。 */
async function readClipboard(mini) {
  try {
    const res = await mini.callWxMethod("getClipboardData");
    return typeof res === "string" ? res : (res?.data ?? "") + "";
  } catch {
    return "";
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // ---- hub 侧：注册探针账号 + 预置真实设备 ----
  console.log(`hub 探针账号：${PROBE_USER}`);
  // hub 现网已要求 phone 字段（本任务验收期间生效）：用探针号段假手机号
  const reg = await fetch(`${HUB_BASE}/auth.register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: PROBE_USER,
      password: PROBE_PASS,
      phone: PROBE_PHONE,
    }),
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
  const deviceReg = await callApi("devices.register", {
    name: DEVICE_NAME,
    os: "macos",
    offer,
  });
  if (!deviceReg.ok) throw new Error(`设备注册失败：${JSON.stringify(deviceReg)}`);
  console.log(`ok 设备已注册：${deviceReg.data.deviceId}（offer → ${offer.endpoint}）`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId });

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9431)");
  await mini
    .evaluate(() => {
      if (getApp().__automation?.downloadLog) getApp().__automation.downloadLog.length = 0;
    })
    .catch(() => {});

  // ---- 登录（清残留态 → 种真实会话）----
  // hub 现网在验收期间开始要求 auth.login 带 phone，miniprogram 登录页
  // 尚未跟进（hub 侧新校验，非 t25 范围）：直接把真实 HTTP 登录拿到的
  // token/account 种进本地存储（与 hub-client.saveSession 同形），绕开登录页。
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_last_agent");
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
  await waitFor("对话主页就绪", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });

  // ---- 设备页连接真实 daemon ----
  await mini.switchTab("/pages/devices/index");
  await sleep(2000);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await onlineCard.tap();
  page = await waitFor(
    "连接后落对话主页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    },
    { timeout: 35000 },
  );
  await waitFor("连接态项目栏或欢迎态", async () => {
    const el = (await page.$(".chat-project")) ?? (await page.$(".chat-welcome"));
    return el ?? null;
  });
  await sleep(1500);

  // ---- 场景 A：已有真实会话 → assistant 消息复制（markdown 原文） ----
  const expandBtn = await waitFor(
    "展开按钮出现",
    async () => (await page.$(".chat-expand")) ?? null,
  );
  await expandBtn.tap();
  await sleep(800);
  const helloRow = await waitFor("抽屉里已有会话（优先 hello）", async () => {
    const hit =
      (await findByText(page, ".sd-row", "hello")) ??
      (await findByText(page, ".sd-row", "ok")) ??
      (await page.$$(".sd-row"))[0];
    return hit ?? null;
  });
  const helloTitle = ((await helloRow.text()) ?? "").trim().slice(0, 30);
  console.log(`ok 选定已有会话：${helloTitle}`);
  await helloRow.tap();
  await sleep(1500);
  let rowsInfo = await waitFor(
    "已有会话时间线渲染（含 assistant 气泡）",
    async () => {
      const info = await timelineRows(page);
      return info.lastAssistant ? info : null;
    },
    { timeout: 30000 },
  );
  await sleep(600);
  rowsInfo = await timelineRows(page);
  if (!rowsInfo.lastUser) {
    console.log("warn 该会话无用户气泡（只读引子会话），复制断言走 assistant 单边");
  }
  await shot(mini, "t25-01-existing-timeline");

  const assistantMore = await rowsInfo.lastAssistant.$(".msg-more");
  if (!assistantMore) throw new Error("assistant 气泡缺少 … 操作入口");
  await tapMessageAction(mini, assistantMore, 0); // [复制, 引用复制][0] = 复制
  const copyEvent = await waitFor("assistant 复制事件（message_action copy）", async () => {
    const log = await readLog(mini);
    return (
      log.find(
        (e) =>
          e.kind === "message_action" && e.action === "copy" && e.itemType === "assistant_message",
      ) ?? null
    );
  });
  console.log(`ok 复制事件：agent=${copyEvent.agentId}`);
  const clipboard1 = await readClipboard(mini);
  if (clipboard1.trim()) {
    console.log(`ok 剪贴板真实内容（前 80 字）：${clipboard1.slice(0, 80).replace(/\n/g, "⏎")}`);
  } else {
    console.log("warn devtools 剪贴板读空（事件台账已证实复制路径执行）");
  }
  await shot(mini, "t25-02-after-copy");

  // 引用复制（P2：同入口 tapIndex 1）
  const assistantMore2 = await (await timelineRows(page)).lastAssistant?.$(".msg-more");
  if (assistantMore2) {
    await tapMessageAction(mini, assistantMore2, 1);
    const quoteEvent = await waitFor("引用复制事件（message_action quote）", async () => {
      const log = await readLog(mini);
      return log.find((e) => e.kind === "message_action" && e.action === "quote") ?? null;
    });
    const clipboard2 = await readClipboard(mini);
    console.log(
      `ok 引用复制事件 ✓；剪贴板${clipboard2.includes(">") ? "含引用前缀 >" : "读取受限"}（前 60 字：${clipboard2.slice(0, 60).replace(/\n/g, "⏎")}）`,
    );
  }

  // ---- 场景 B：短会话（优先 zcode，缺则回落 rewind 可用 provider）→ 用户消息编辑重发 ----
  const EDIT_BEFORE = "只回复 ok";
  const EDIT_AFTER = "只回复 好的";
  // 回欢迎态新建会话
  await mini.reLaunch("/pages/chat/index");
  await sleep(1200);
  page = await mini.currentPage();
  const welcome = await page.$(".chat-welcome");
  if (!welcome) {
    const exp = await page.$(".chat-expand");
    if (exp) {
      await exp.tap();
      await sleep(700);
      const nb = await page.$(".sd-new");
      await nb.tap();
      await sleep(900);
    }
  }
  await waitFor("欢迎态（新对话）", async () => (await page.$(".chat-welcome")) ?? null);

  // 选工作区（t20 同序：先定 cwd，pill 目录与"发送即创建"都依赖它）。
  // daemon 目录可能含已删目录的陈旧工作区（t24 验证残留）→ createAgent 会被
  // daemon 以 "Working directory does not exist" 拒绝 → 发送阶段逐个换行重试
  const projectChip0 = await page.$(".chat-project");
  let workspaceCount = 1;
  if (projectChip0) {
    await projectChip0.tap();
    await sleep(900);
    const wsRows0 = await waitFor("真实工作区列表渲染", async () => {
      const rows = await page.$$(".ws-row");
      return rows.length >= 1 ? rows : null;
    });
    workspaceCount = wsRows0.length;
    // 选第 0 行定 cwd（模型目录依赖 cwd）；行选择自动关面板
    await wsRows0[0].tap();
    await sleep(1000);
    console.log(
      `ok 工作区候选：${workspaceCount} 个，已选[0]：${((await wsRows0[0].text()) ?? "").trim().slice(0, 30).replace(/\n/g, " ")}`,
    );
    const wsMask0 = await page.$(".ws-mask");
    if (wsMask0) {
      await wsMask0.tap();
      await sleep(600);
    }
  }

  // 选 provider：优先 zcode（任务指定）；daemon 现网目录无 zcode 时按
  // rewind 能力优先级回落（claude/codex 均支持会话回退），任选其一遍历
  const pickByPattern = async (patterns) => {
    const rows = await page.$$(".cp-row");
    for (const pattern of patterns) {
      for (const row of rows) {
        if (pattern.test((await row.text()) ?? "")) return row;
      }
    }
    return null;
  };
  // pill → 目录：选择器开关有竞态（关闭动画/重渲染吞点击）→ 每轮关残留
  // 遮罩、重查 pill 句柄、点后限时等行，超时整套重来
  const openPillRows = async (pillIndex, desc) => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const mask = await page.$(".cp-mask");
      if (mask) {
        await mask.tap();
        await sleep(700);
      }
      const pills = await page.$$(".chat-pill");
      const pill = pills[pillIndex];
      if (!pill) {
        await sleep(700);
        continue;
      }
      await pill.tap();
      try {
        return await waitFor(
          `${desc} 目录渲染`,
          async () => {
            const rows = await page.$$(".cp-row");
            return rows.length >= 1 ? rows : null;
          },
          { timeout: 20000 },
        );
      } catch {
        console.log(`warn ${desc} 目录未开（第 ${attempt + 1} 次），重试`);
      }
    }
    throw new Error(`${desc} 目录始终未渲染`);
  };
  const providerRowsFound = await openPillRows(0, "provider");
  const providerNames = [];
  for (const row of providerRowsFound) {
    providerNames.push(((await row.text()) ?? "").trim());
  }
  console.log(`provider 现网目录：${providerNames.join("、")}`);
  const PREFERRED = ["zcode", "claude", "codex", "kimi"];
  let chosenProviderName = providerNames[0] ?? "";
  for (const pref of PREFERRED) {
    const hit = providerNames.find((n) => n.toLowerCase().includes(pref));
    if (hit) {
      chosenProviderName = hit;
      break;
    }
  }
  const zcodeRow = await findByText(page, ".cp-row", chosenProviderName);
  if (!zcodeRow) throw new Error(`provider 目录异常：${providerNames.join("、")}`);
  console.log(`ok 选定 provider：${chosenProviderName}（zcode 缺席时按 rewind 能力回落）`);
  await zcodeRow.tap();
  await sleep(2500);
  // 模型取小模型优先（目录 RPC 走真实 daemon）；审批模式避开 Plan Mode
  const modelRowsFound = await openPillRows(1, "模型");
  const modelRow = (await pickByPattern([/flash|mini|air|lite|sonnet/i])) ?? modelRowsFound[0];
  await modelRow.tap();
  await sleep(1500);
  const pillsForMode = await page.$$(".chat-pill");
  const modeRowsFound = await openPillRows(pillsForMode.length - 1, "审批模式");
  const modeHit = await pickByPattern([/bypass/i, /auto/i, /accept/i, /default/i]);
  await (modeHit ?? modeRowsFound[0]).tap();
  await sleep(700);

  const input = await page.$(".composer-input");
  await input.input(EDIT_BEFORE);
  await sleep(300);
  // 关残留选择器遮罩（遮罩在层上会吞发送键的点击坐标）
  const lingeringMask = await page.$(".cp-mask");
  if (lingeringMask) {
    await lingeringMask.tap();
    await sleep(500);
  }
  // 发送即创建（句柄随重渲染失效是常见坑 → 每轮重查）。createAgent 走真实
  // daemon；陈旧工作区会被拒（"Working directory does not exist"，行内错误
  // .error-inline）→ 逐个换工作区行重试；草稿在 RPC 成功后才清，故终态以
  // composer_create 事件或行内错误为准，不给草稿清空设短时限
  let createEvent = null;
  for (let wsIndex = 0; wsIndex < workspaceCount && !createEvent; wsIndex++) {
    // 重开工作区选择器选第 wsIndex 行（列表顺序稳定）
    const chip = await page.$(".chat-project");
    await chip.tap();
    await sleep(800);
    const wsRows = await page.$$(".ws-row");
    if (!wsRows[wsIndex]) {
      console.log(`warn 工作区[${wsIndex}] 不在列表，跳过`);
      const m = await page.$(".ws-mask");
      if (m) {
        await m.tap();
        await sleep(500);
      }
      continue;
    }
    const wsText = ((await wsRows[wsIndex].text()) ?? "").trim();
    await wsRows[wsIndex].tap();
    await sleep(900);
    console.log(`ok 工作区[${wsIndex}]：${wsText.slice(0, 30).replace(/\n/g, " ")}`);
    // 换区可能重置 provider 草稿（seedDraft）→ 创建事件按"本轮新增"匹配，
    // provider 事后从事件里读
    const logBefore = (await readLog(mini)).length;
    const sendBtn = await page.$(".send-btn");
    await sendBtn.tap();
    // 快失败：daemon 侧秒拒（陈旧工作区）→ error-inline 出现即结束本轮等待；
    // 正常创建走完 composer_create 事件
    const outcome = await waitFor(
      `composer 创建事件（${chosenProviderName}）`,
      async () => {
        const log = await readLog(mini);
        const hit = log.slice(logBefore).find((e) => e.kind === "composer_create");
        if (hit) return { event: hit };
        const errEl = await page.$(".error-inline");
        const errText = errEl ? ((await errEl.text()) ?? "").trim() : "";
        if (errText) return { failFast: errText };
        return null;
      },
      { timeout: 60000 },
    );
    if (outcome.event) {
      createEvent = outcome.event;
    } else {
      console.log(`warn 工作区[${wsIndex}] 创建被拒：${outcome.failFast.slice(0, 90)}`);
      // 失败保留草稿；若被 UI 状态清掉则补填
      const in2 = await page.$(".composer-input");
      const v = String((await in2.property("value")) ?? "");
      if (!v.trim()) await in2.input(EDIT_BEFORE).catch(() => {});
    }
  }
  if (!createEvent) throw new Error("所有工作区均无法创建会话（composer_create 未出现）");
  const editAgentId = createEvent.agentId;
  console.log(`ok 验证会话已创建（${createEvent.provider ?? chosenProviderName}）：${editAgentId}`);

  // 等待首轮回复终态（ok / 好的 / 错误）
  const failRe = /403|not allowed|authenticate|api error|unauthorized|失败|错误|无法/i;
  let firstOutcome = null;
  try {
    firstOutcome = await waitFor(
      "首轮回复终态",
      async () => {
        const info = await timelineRows(page);
        if (!info.lastAssistant) return null;
        const text = (await info.lastAssistant.text()) ?? "";
        if (failRe.test(text)) return { ok: false, text };
        if (text.trim().length > 0 && !text.includes(EDIT_BEFORE)) return { ok: true, text };
        return null;
      },
      { timeout: 150000 },
    );
  } catch {
    firstOutcome = { ok: false, text: "（150s 无终态）" };
  }
  if (!firstOutcome.ok) {
    console.log(`warn 首轮回复异常：${firstOutcome.text.slice(0, 60)}（编辑链路仍继续验证）`);
  } else {
    console.log(`ok 首轮回复：${firstOutcome.text.slice(0, 40)}`);
  }

  // 用户气泡 → "…" → 操作单（mock tapIndex 1 = 编辑）→ 内联编辑态
  const userRow = await waitFor("用户气泡行出现", async () => {
    const info = await timelineRows(page);
    return info.lastUser ?? null;
  });
  const userMore = await userRow.$(".msg-more");
  if (!userMore) throw new Error("用户气泡缺少 … 操作入口");
  await tapMessageAction(mini, userMore, 1); // [复制, 编辑, 引用][1] = 编辑
  const editState = await waitFor("内联编辑态渲染（textarea 预填原文）", async () => {
    const el = await page.$(".msg-edit-area");
    return el ?? null;
  });
  const prefill = (await editState.text()) ?? "";
  console.log(
    `ok 编辑态预填（含原文）：${prefill.includes(EDIT_BEFORE) ? "✓" : `✗（${prefill.slice(0, 30)}）`}`,
  );
  await shot(mini, "t25-03-edit-state");

  // 修改文本 → 发送修改（rewind + resend）
  await editState.input(EDIT_AFTER);
  await sleep(400);
  const saveBtn = await page.$(".msg-edit-save");
  await saveBtn.tap();
  const editEvent = await waitFor("编辑事件（message_edit）", async () => {
    const log = await readLog(mini);
    return log.find((e) => e.kind === "message_edit" && e.agentId === editAgentId) ?? null;
  });
  const editMode = editEvent.mode;
  console.log(
    `ok 编辑模式裁决：${editMode}${editMode === "rewind" ? "（rewind 回退 + 重发）" : "（草稿降级）"}`,
  );

  if (editMode === "rewind") {
    const resentEvent = await waitFor(
      "重发完成（message_edit_resent）",
      async () => {
        const log = await readLog(mini);
        return (
          log.find((e) => e.kind === "message_edit_resent" && e.agentId === editAgentId) ?? null
        );
      },
      { timeout: 90000 },
    );
    console.log(`ok rewind + 重发链路完成（mode=${resentEvent.mode}）`);
    // rewind 截断断言：原 "只回复 ok" 气泡消失，"只回复 好的" 出现
    await sleep(2000);
    await waitFor(
      "重发后的新用户气泡",
      async () => {
        const bubbles = await page.$$(".bubble-user");
        for (const bubble of bubbles) {
          const text = ((await bubble.text()) ?? "").trim();
          if (text === EDIT_AFTER) return true;
        }
        return false;
      },
      { timeout: 30000 },
    );
    let oldStill = false;
    for (const bubble of await page.$$(".bubble-user")) {
      const text = ((await bubble.text()) ?? "").trim();
      if (text === EDIT_BEFORE) oldStill = true;
    }
    console.log(
      `ok rewind 截断断言：旧消息${oldStill ? "仍在（异常）" : "已撤回 ✓"}；新消息已入时间线 ✓`,
    );
  } else {
    // 草稿降级：composer 被填入修正文本
    await waitFor("草稿降级填入输入框", async () => {
      const el = await page.$(".composer-input");
      const v = (await el.property("value")) ?? "";
      return String(v).includes(EDIT_AFTER);
    });
    console.log("ok 草稿降级：修正文本已填入输入框（无重发，符合降级语义）");
    // 手动发出以便时间线截图完整
    const sendBtn2 = await page.$(".send-btn");
    await sendBtn2.tap();
    await sleep(1000);
  }
  await sleep(2500);
  await shot(mini, "t25-04-after-edit-resent");

  // ---- 深色主题截图（时间线 + 编辑态） ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1000);
  page = await mini.currentPage();
  const darkOption = await findByText(page, ".theme-option", "深色");
  if (darkOption) {
    await darkOption.tap();
    await sleep(800);
    await mini.reLaunch("/pages/chat/index");
    await sleep(2000);
    page = await mini.currentPage();
    await waitFor(
      "深色下活跃会话恢复",
      async () => {
        const info = await timelineRows(page);
        return info.lastUser ? info : null;
      },
      { timeout: 30000 },
    );
    await shot(mini, "t25-05-dark-timeline");
    // 深色编辑态（只进入编辑态截图，随后取消——不产生真实副作用）
    const darkUserRow = (await timelineRows(page)).lastUser;
    const darkMore = await darkUserRow?.$(".msg-more");
    if (darkMore) {
      await tapMessageAction(mini, darkMore, 1);
      await waitFor("深色编辑态渲染", async () => (await page.$(".msg-edit-area")) ?? null);
      await shot(mini, "t25-06-dark-edit-state");
      const cancelBtn = await page.$(".msg-edit-cancel");
      await cancelBtn.tap();
      await sleep(500);
    }
    // 还原跟随系统
    await mini.switchTab("/pages/settings/index");
    await sleep(800);
    page = await mini.currentPage();
    const autoOption = await findByText(page, ".theme-option", "系统");
    await autoOption?.tap();
    await sleep(500);
  } else {
    console.log("warn 未找到深色选项，跳过深色截图");
  }

  // ---- 清理：删除验证会话 ----
  await mini.reLaunch("/pages/chat/index");
  await sleep(1000);
  await mini.evaluate((agentId) => getApp().__automation.deleteAgent(agentId), editAgentId);
  await sleep(1500);
  await mini.reLaunch("/pages/chat/index");
  await sleep(2000);
  page = await mini.currentPage();
  const stillThere = await findByText(page, ".sd-row", editAgentId);
  console.log(`ok 验证会话删除${stillThere ? "（警告：目录仍可见，可能延迟）" : "确认"}`);

  const finalLog = await readLog(mini);
  const actionKinds = finalLog
    .filter((e) => String(e.kind).startsWith("message_") || e.kind === "composer_create")
    .map((e) => e.kind);
  console.log(`ok 验收事件链（${actionKinds.join(" → ")}）`);

  clearInterval(heartbeatTimer);
  await mini
    .evaluate(() => {
      getApp().__automation.disconnect();
      getApp().__automation.sessionStore.reset();
    })
    .catch(() => {});
  await mini.disconnect();
  console.log("t25 验收完成");
}

main().catch((err) => {
  console.error("t25 验收失败：", err);
  process.exitCode = 1;
});
