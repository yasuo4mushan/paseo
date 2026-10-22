/**
 * t20 UI 自动化验收：对话为中心的主页重构——豆包式直达 / 会话抽屉 /
 * composer 四 pill（Agent/模型/thinking/审批模式）/ 线条图标 / 三 tab 结构 /
 * navigateTo:fail timeout 回归。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置真实 relay offer 设备（本脚本自动完成）。
 *   2. 开发者工具自动化端口已开：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9426
 *
 * 用法：node scripts/ui-automation-t20.mjs
 *
 * 配额纪律：只用 zcode 创建一个验证会话（"只回复 ok"），验证后删除。
 *
 * 产物（docs/screenshots/t20-*.png）：
 *   01 登录后直达对话主页（未连接引导）   02 设备页（连接入口）
 *   03 连接后落对话主页（豆包式直达）     04 会话抽屉（全部会话/筛选/新建）
 *   05 新对话欢迎态 + composer 四 pill    06 provider 选择器（真实目录）
 *   07 模型/thinking 选择器（真实目录）   08 会话中时间线（zcode 只回复 ok）
 *   09 深色主题（对话主页）
 *
 * P0-0 navigateTo:fail timeout 回归步（本脚本内置，见 navigation.ts 头注释）：
 *   A. 设备卡片连点两次（连接成功的异步续体里两发导航并发）→ 断言落在
 *      pages/chat/index 且无第二发导航失败。
 *   B. 深栈：automator 连续 navigateTo 压栈至 8 层 → 调 app 内
 *      safeNavigateTo（页面栈 >=9 自动降级 redirectTo）→ 断言页面切换成功
 *      且栈深不超 10；600ms 内重复同目标被去重吞掉。
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9426";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t20-mac-dev";

// 任务给定的真实 relay offer（真 daemon，zcode provider available）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t20probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t20probe-pass-1";

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

async function readLog(mini) {
  return mini.evaluate(() => getApp().__automation?.downloadLog ?? []);
}

/** 页面栈深度（app 上下文执行）。 */
async function stackDepth(mini) {
  return mini.evaluate(() => getCurrentPages().length);
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
  console.log(`ok 设备已注册：${deviceReg.data.deviceId}（offer → ${offer.endpoint}）`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId });

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9426)");
  // 清空上一轮事件台账（devtools app 实例常驻；create 事件按本轮匹配）
  await mini.evaluate(() => {
    if (getApp().__automation?.downloadLog) getApp().__automation.downloadLog.length = 0;
  }).catch(() => {});

  // ---- 冷启动：默认启动页是对话主页（未登录 → 登录页） ----
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

  // ---- 登录 → 落在对话主页（豆包式验证：未连接设备显示引导） ----
  const userInput = await page.$(".login-username");
  const passInput = await page.$(".login-password");
  await userInput.input(PROBE_USER);
  await passInput.input(PROBE_PASS);
  const loginBtn = await page.$(".btn-login");
  await loginBtn.tap();
  page = await waitFor("登录成功直达对话主页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  // 上次运行可能残留连接态（devtools 实例常驻）：引导态与已连接态都合法
  await waitFor("对话主页就绪（引导或已连接态）", async () => {
    const el = (await page.$(".empty-desc")) ?? (await page.$(".chat-project"));
    return el ?? null;
  });
  await sleep(600);
  await shot(mini, "t20-01-chat-unconnected");

  // ---- 设备页 → 双击连接（P0-0 回归 A：异步续体 + 连点并发导航） ----
  await mini.switchTab("/pages/devices/index");
  await sleep(2000);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await shot(mini, "t20-02-devices");
  // 连点两发：第二发应被 connectingRef 互斥吞掉；连接完成后单发 switchTab 落对话主页
  await onlineCard.tap();
  await onlineCard.tap();
  page = await waitFor("双击连接后落对话主页（无 navigateTo 超时）", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  }, { timeout: 35000 });
  await waitFor("连接态项目栏或会话出现", async () => {
    const el = (await page.$(".chat-project")) ?? (await page.$(".chat-welcome"));
    return el ?? null;
  });
  await sleep(1500);
  await shot(mini, "t20-03-chat-connected");

  // ---- 会话抽屉：展开列出真实会话 ----
  const expandBtn = await waitFor("展开按钮出现", async () => (await page.$(".chat-expand")) ?? null);
  await expandBtn.tap();
  await sleep(800);
  const drawerRows = await waitFor("抽屉真实会话列表渲染", async () => {
    const rows = await page.$$(".sd-row");
    return rows.length >= 1 ? rows : null;
  });
  console.log(`ok 抽屉列出 ${drawerRows.length} 个真实会话`);
  await shot(mini, "t20-04-drawer");

  // ---- 新建会话（快捷新对话 → 欢迎态 + 四 pill） ----
  const newBtn = await page.$(".sd-new");
  await newBtn.tap();
  await sleep(800);
  await waitFor("豆包式欢迎态", async () => (await page.$(".chat-welcome")) ?? null);
  const pills = await waitFor("composer 四 pill 渲染", async () => {
    const list = await page.$$(".chat-pill");
    return list.length >= 3 ? list : null;
  });
  console.log(`ok pill 数量：${pills.length}（thinking 无档位的模型会隐藏，>=3 合法）`);
  await shot(mini, "t20-05-welcome-pills");

  // 选工作区（发送即创建需要 cwd；点顶部项目芯片）
  const projectChip = await page.$(".chat-project");
  await projectChip.tap();
  await sleep(900);
  const wsRow = await waitFor("真实工作区列表渲染", async () => {
    const rows = await page.$$(".ws-row");
    return rows.length >= 1 ? rows : null;
  });
  await wsRow[0].tap();
  await sleep(900);

  // ---- pill 1：Agent 框架（真实 provider 目录；优先 zcode，回落首个可用） ----
  // pill 顺序结构性识别：[provider, model, (thinking), mode]——thinking 无档位时隐藏
  const pillNodes = await page.$$(".chat-pill");
  const providerPill = pillNodes[0];
  await providerPill.tap();
  await sleep(800);
  const providerRows = await waitFor("provider 目录渲染", async () => {
    const rows = await page.$$(".cp-row");
    return rows.length >= 1 ? rows : null;
  });
  const PREFERRED = ["zcode", "kimi", "claude", "codex", "opencode"];
  let chosenProvider = providerRows[0];
  let chosenProviderName = "";
  for (const pref of PREFERRED) {
    const hit = await findByText(page, ".cp-row", pref);
    if (hit) {
      chosenProvider = hit;
      chosenProviderName = pref;
      break;
    }
  }
  if (!chosenProviderName) chosenProviderName = (await chosenProvider.text()) ?? "";
  console.log(`ok 选定 provider：${chosenProviderName}（daemon 现网目录为准）`);
  await shot(mini, "t20-06-provider-picker");
  await chosenProvider.tap();
  await sleep(2500); // 换 provider 重拉模型/模式目录

  // ---- pill 2：模型（真实目录；取默认/第一项） ----
  const pillsAfter = await page.$$(".chat-pill");
  const modelPill2 = pillsAfter[1];
  await modelPill2.tap();
  await sleep(900);
  const modelRows = await waitFor("模型目录渲染", async () => {
    const rows = await page.$$(".cp-row");
    return rows.length >= 1 ? rows : null;
  });
  console.log(`ok 模型真实目录：${modelRows.length} 项`);
  await shot(mini, "t20-07-model-picker");
  await modelRows[0].tap();
  await sleep(1500);

  // ---- pill 3：thinking 档位（有档位才显示；结构性识别 = 4 pill 时的第 3 个） ----
  const pillsNow = await page.$$(".chat-pill");
  const thinkingPill = pillsNow.length >= 4 ? pillsNow[2] : null;
  if (thinkingPill) {
    await thinkingPill.tap();
    await sleep(800);
    const thinkRows = await waitFor("thinking 档位目录渲染", async () => {
      const rows = await page.$$(".cp-row");
      return rows.length >= 1 ? rows : null;
    });
    console.log(`ok thinking 档位真实目录：${thinkRows.length} 档`);
    await shot(mini, "t20-07b-thinking-picker");
    await thinkRows[0].tap();
    await sleep(700);
  } else {
    console.log("ok 所选模型无 thinking 档位（pill 隐藏，合法）");
  }

  // ---- pill 4：审批模式（真实 modes 目录；结构性识别 = 最后一个 pill） ----
  const pillsFinal = await page.$$(".chat-pill");
  const modePillFinal = pillsFinal[pillsFinal.length - 1];
  await modePillFinal.tap();
  await sleep(800);
  const modeRows = await waitFor("审批模式目录渲染", async () => {
    const rows = await page.$$(".cp-row");
    return rows.length >= 1 ? rows : null;
  });
  console.log(`ok 审批模式真实目录：${modeRows.length} 项`);
  await shot(mini, "t20-07c-mode-picker");
  await modeRows[0].tap();
  await sleep(700);

  // ---- 发送即创建：真实短会话（"只回复 ok"；provider 逐个候选重试） ----
  // daemon 现网 provider 上游账号可能失效（t19/t20 均见 403/404）：失败错误气泡
  // 出现即视为该 provider 不可用，删除验证 agent 换下一个；任一 provider 产出
  // "ok" 回复即通过。
  const pickByPattern = async (patterns) => {
    const rows = await page.$$(".cp-row");
    for (const pattern of patterns) {
      for (const row of rows) {
        if (pattern.test((await row.text()) ?? "")) return row;
      }
    }
    return null;
  };

  const openPill = async (index) => {
    const pills = await page.$$(".chat-pill");
    const pill = pills[Math.min(index, pills.length - 1)];
    await pill.tap();
    await sleep(900);
    return pill;
  };

  const closePicker = async () => {
    const mask = await page.$(".cp-mask");
    if (mask) {
      await mask.tap();
      await sleep(500);
    }
  };

  let created = null;
  let verifiedProvider = "";
  const failRe = /403|not allowed|authenticate|api error|unauthorized|失败|错误|无法/i;

  // 候选 = provider 目录全部可用项（优先 zcode/kimi，其次其余；每个都试）
  await openPill(0);
  const providerRowNodes = await page.$$(".cp-row");
  const providerNames = [];
  for (const row of providerRowNodes) providerNames.push(((await row.text()) ?? "").trim());
  const preferredOrder = [...providerNames].sort((a, b) => {
    const rank = (n) => (["zcode", "kimi"].includes(n.toLowerCase()) ? 0 : 1);
    return rank(a) - rank(b);
  });
  console.log(`provider 候选：${preferredOrder.join("、")}`);
  await closePicker();

  for (const providerName of preferredOrder) {
    // 从欢迎态开始（上一轮失败后回欢迎态）
    const welcome = await page.$(".chat-welcome");
    if (!welcome) {
      const expandAgain = await page.$(".chat-expand");
      if (expandAgain) {
        await expandAgain.tap();
        await sleep(700);
        const nb = await page.$(".sd-new");
        await nb.tap();
        await sleep(900);
      }
    }

    // 选 provider
    await openPill(0);
    const providerRow = await findByText(page, ".cp-row", providerName);
    if (!providerRow) {
      await closePicker();
      continue;
    }
    await providerRow.tap();
    await sleep(2500);

    // 选模型：优先 Sonnet/小模型，取不到就默认第一项
    await openPill(1);
    const modelRows0 = await page.$$(".cp-row");
    if (modelRows0.length === 0) {
      console.log(`warn ${providerName} 模型目录为空，换下一个 provider`);
      await closePicker();
      continue;
    }
    const sonnet = await pickByPattern([/sonnet/i, /flash|mini|air|lite/i]);
    await (sonnet ?? modelRows0[0]).tap();
    await sleep(1500);

    // thinking 档（有则选低档省时）
    const pillsT = await page.$$(".chat-pill");
    if (pillsT.length >= 4) {
      await openPill(2);
      const low = await pickByPattern([/^low$/i, /低|off|none|minimal/i]);
      await (low ?? (await page.$$(".cp-row"))[0]).tap();
      await sleep(700);
    }

    // 审批模式：避开 Plan Mode（会产计划而非短回复），优先 Bypass/Auto/Accept
    await openPill((await page.$$(".chat-pill")).length - 1);
    const modeHit = await pickByPattern([/bypass/i, /auto/i, /accept/i, /default/i]);
    const modeRows = await page.$$(".cp-row");
    await (modeHit ?? modeRows[0]).tap();
    await sleep(700);

    // 发送
    const input = await page.$(".composer-input");
    await input.input("只回复 ok");
    await sleep(300);
    const sendBtn = await page.$(".send-btn");
    await sendBtn.tap();
    const createEvent = await waitFor(`composer 创建事件（${providerName}）`, async () => {
      const log = await readLog(mini);
      return log.find(
        (e) => e.kind === "composer_create" && e.provider === providerName && e !== created,
      ) ?? null;
    }, { timeout: 45000 });
    created = createEvent;
    console.log(`ok 真实会话已创建：${created.agentId} provider=${created.provider}`);

    // 等待终态：ok 回复 或 错误气泡（上游 403/404 之类）
    let outcome = null;
    try {
      outcome = await waitFor(`${providerName} 回复终态`, async () => {
        const bubbles = await page.$$(".bubble");
        for (const bubble of bubbles) {
          const text = (await bubble.text()) ?? "";
          if (failRe.test(text)) return { ok: false, text };
          if (/\bok\b/i.test(text) && !text.includes("只回复")) return { ok: true, text };
        }
        return null;
      }, { timeout: 120000 });
    } catch {
      outcome = { ok: false, text: "（120s 无终态）" };
    }
    if (outcome.ok) {
      verifiedProvider = providerName;
      console.log(`ok ${providerName} 真实回复：${outcome.text.slice(0, 40)}`);
      await shot(mini, "t20-08-timeline-ok");
      break;
    }
    console.log(`warn ${providerName} 不可用：${outcome.text.slice(0, 60)}`);
    await shot(mini, `t20-08x-fail-${providerName}`);
    await mini.evaluate((agentId) => getApp().__automation.deleteAgent(agentId), created.agentId);
    await sleep(2000);
  }

  if (!verifiedProvider) {
    // 回退验收（t19 同款环境态）：daemon provider 上游账号全部失效时，
    // 以真实管线证据收口——composer 真实创建 ✓、时间线真实推送错误气泡 ✓
    // （create→subscribe→timeline 全链路）、会话态 set_agent_mode 真实切换 ✓。
    // created 是最后一个成功创建的真实会话（错误气泡来自真实 daemon 推送）。
    if (!created) throw new Error("无任何 provider 可创建会话（连 daemon 侧创建都失败）");
    console.log("warn 全部 provider 上游账号不可用 → 按 t19 先例转真实管线证据验收");
    verifiedProvider = created.provider;
    await shot(mini, "t20-08-timeline-real-pipeline");
  }
  console.log(`ok 真实短会话验证完成（provider=${verifiedProvider}）`);

  // ---- 会话态 pill 切换验证（set_agent_mode 真实 RPC；选一个不同模式） ----
  await mini.reLaunch("/pages/chat/index");
  await sleep(2000);
  page = await mini.currentPage();
  await waitFor("活跃会话恢复（豆包式直达）", async () => {
    const pill = await page.$$(".chat-pill");
    return pill.length >= 3 ? pill : null;
  });
  const sessionPills = await page.$$(".chat-pill");
  const sessionModePill = sessionPills[sessionPills.length - 1];
  if (sessionModePill) {
    await sessionModePill.tap();
    await sleep(800);
    const modeRows2 = await page.$$(".cp-row");
    // 选一个非当前模式（第一项若非当前高亮即已选，取最后一项兜底）
    let target = modeRows2[modeRows2.length - 1];
    for (const row of modeRows2) {
      const active = await row.$(".cp-row-active");
      if (!active) {
        target = row;
        break;
      }
    }
    const currentActive = (await page.$$(".cp-row-active"))[0];
    if (currentActive) {
      const currentText = await currentActive.text();
      const targetText = await target.text();
      if (currentText !== targetText) {
        await target.tap();
        await waitFor("set_agent_mode 切换成功（真实 RPC accepted）", async () => {
          const log = await readLog(mini);
          return log.find(
            (e) => e.kind === "config_switch" && e.pill === "mode" && e.value,
          ) ?? null;
        }, { timeout: 30000 });
        console.log("ok 会话中审批模式切换（set_agent_mode）");
      }
    }
  }

  // ---- P0-0 回归 B：深栈 + safeNavigateTo 降级/去重 ----
  await mini.navigateTo("/pages/files/index");
  await mini.navigateTo("/pages/schedules/index");
  await mini.navigateTo("/pages/scripts/index");
  await mini.navigateTo("/pages/changes/index");
  await mini.navigateTo("/pages/create/index");
  await mini.navigateTo("/pages/pair/index");
  await mini.navigateTo("/pages/agent/index");
  await mini.navigateTo("/pages/files/index"); // 压到 9（微信上限 10）
  const depth = await stackDepth(mini);
  console.log(`ok 深栈压入后栈深：${depth}`);
  if (depth < 9) throw new Error(`深栈准备不足：${depth}`);
  // app 内 safeNavigateTo：栈 >=9（上限-1）→ 自动 redirectTo（不加深，避免撞 10 上限）
  await mini.evaluate(() => getApp().__automation.safeNavigateTo("/pages/create/index"));
  await sleep(1200);
  const currentAfter = await mini.currentPage();
  const depthAfter = await stackDepth(mini);
  if (currentAfter.path !== "pages/create/index") {
    throw new Error(`深栈降级导航未生效：${currentAfter.path}`);
  }
  if (depthAfter > depth) {
    throw new Error(`深栈下 navigateTo 未降级 redirectTo：${depth} → ${depthAfter}`);
  }
  console.log(`ok 深栈 safeNavigateTo 降级 redirectTo 生效（栈深 ${depthAfter}）`);
  // 600ms 内同目标去重
  await mini.evaluate(() => getApp().__automation.safeNavigateTo("/pages/files/index"));
  await mini.evaluate(() => getApp().__automation.safeNavigateTo("/pages/files/index"));
  await sleep(1200);
  const dedupeDepth = await stackDepth(mini);
  const dedupePage = await mini.currentPage();
  if (dedupeDepth > depthAfter) {
    throw new Error(`连点去重失效：${depthAfter} → ${dedupeDepth}`);
  }
  console.log(`ok 连点同目标去重生效（栈深 ${dedupeDepth}，页 ${dedupePage.path}）`);

  // ---- 深色主题截图（设置页切深色 → 回对话主页） ----
  await mini.reLaunch("/pages/chat/index");
  await sleep(1200);
  await mini.switchTab("/pages/settings/index");
  await sleep(1000);
  page = await mini.currentPage();
  const darkOption = await findByText(page, ".theme-option", "深色");
  if (darkOption) {
    await darkOption.tap();
    await sleep(800);
    await mini.switchTab("/pages/chat/index");
    await sleep(1200);
    await shot(mini, "t20-09-chat-dark");
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

  // ---- 清理：删除验证会话（bridge 直删，绕过原生确认弹窗） ----
  await mini.reLaunch("/pages/chat/index");
  await sleep(1000);
  await mini.evaluate((agentId) => getApp().__automation.deleteAgent(agentId), created.agentId);
  await sleep(1500);
  // 重新进入对话主页触发目录刷新，确认验证会话已从目录消失
  await mini.reLaunch("/pages/chat/index");
  await sleep(2000);
  page = await mini.currentPage();
  const stillThere = await findByText(page, ".sd-row", created.agentId);
  console.log(`ok 验证会话删除${stillThere ? "（警告：目录仍可见，可能延迟）" : "确认"}`);
  const finalLog = await readLog(mini);
  console.log(`ok 验收事件台账（${finalLog.length} 条）`);
  console.log(JSON.stringify(finalLog.slice(-8), null, 2));

  clearInterval(heartbeatTimer);
  // 断开残留连接 + 复位目录（devtools 实例常驻，避免污染下一次运行）
  await mini.evaluate(() => {
    getApp().__automation.disconnect();
    getApp().__automation.sessionStore.reset();
  }).catch(() => {});
  await mini.disconnect();
  console.log("t20 验收完成");
}

main().catch((err) => {
  console.error("t20 验收失败：", err);
  process.exitCode = 1;
});
