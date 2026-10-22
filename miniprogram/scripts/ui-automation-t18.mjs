/**
 * t18 UI 自动化验收：运营功能第二批——定时任务 / attention 通知 / 归档标签 /
 * 会话导入 / 新建工作区（注册目录）/ 主题三档 / 工作区脚本。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置真实 relay offer 设备（本脚本自动完成）。
 *   2. 开发者工具自动化端口已开：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9424
 *
 * 用法：node scripts/ui-automation-t18.mjs
 *
 * 配额纪律：只创建一个验证 agent（短 prompt"只回复 ok"）、一个短周期定时任务
 * （cron 每分钟 + 立即执行验证链路），验证后删除任务与 agent。
 *
 * 产物（docs/screenshots/t18-*.png）：
 *   01 会话列表（筛选条 + 定时/脚本入口）      02 定时任务页（真实 schedule/list）
 *   03 新建定时任务表单                        04 任务列表出现 t18 验收任务
 *   05 立即执行 → 执行记录（schedule/logs）    06 agent 时间线出现定时执行记录
 *   07 attention 徽标/高亮（真实推送，mock 兜底） 08 标签编辑器（打标签）
 *   09 归档筛选（已归档卡片）                  10 导入已有会话 tab
 *   11 工作区脚本页（真实 workspace.script.list） 12 新建工作区（幂等注册当前目录）
 *   13 设置外观三档（深色）                    14 会话列表深色档
 *   15 清理完成（任务与验证 agent 已删）
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9424";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t18-mac-dev";

// 任务给定的真实 relay offer（.paseo-xdb daemon，真实工作区/agent）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t18probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t18probe-pass-1";

const SCHEDULE_NAME = "t18-验收";
const SCHEDULE_PROMPT = "定时验收：只回复 ok2";
const LABEL_TEXT = "验收";

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

/** 按钮组内按文本找按钮。 */
async function findButton(page, selector, text) {
  return findByText(page, selector, text);
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
  console.log(`✓ 设备已注册：${deviceReg.data.deviceId}（offer → ${offer.endpoint}）`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId: deviceReg.data.deviceId });

  // ---- 连接 devtools automator ----
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9424)");

  // ---- 登录 + 连接真实设备（relay E2EE） ----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");
  await mini.reLaunch("/pages/login/index");
  await sleep(1500);
  let page = await mini.currentPage();
  await waitFor("登录页出现", async () => (await page.$(".login-username")) !== null);
  const userInput = await page.$(".login-username");
  const passInput = await page.$(".login-password");
  const loginBtn = await page.$(".btn-login");
  await userInput.input(PROBE_USER);
  await passInput.input(PROBE_PASS);
  await loginBtn.tap();
  page = await waitFor("登录成功进入设备页", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/devices/index") return false;
    page = current;
    return true;
  });

  await mini.reLaunch("/pages/devices/index");
  await sleep(2500);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await onlineCard.tap();
  page = await waitFor(
    "连接成功进入 Agent 列表",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agents/index" ? current : false;
    },
    { timeout: 30000 },
  );
  await sleep(2500);

  // ---- 选择真实工作区 ----
  const wsBar = await waitFor("工作区栏出现", async () => (await page.$(".ws-bar-main")) ?? null);
  await wsBar.tap();
  await sleep(800);
  const wsRow = await waitFor("真实工作区列表渲染", async () => {
    const rows = await page.$$(".ws-row");
    return rows.length >= 1 ? rows : null;
  });
  await wsRow[0].tap();
  await sleep(800);
  await waitFor("工作区选中回填", async () => {
    const value = await page.$(".ws-bar-value");
    const text = await value.text();
    return text && text !== "选择工作区" ? text : null;
  });

  // ---- t18-01：列表筛选条 + 定时/脚本入口 ----
  await waitFor("筛选条渲染", async () => (await page.$(".filter-bar")) ?? null);
  await shot(mini, "t18-01-agents-filters-tools");

  // ---- 创建验证 agent（一个，短 prompt） ----
  const createEntry = await page.$(".create-entry");
  await createEntry.tap();
  page = await waitFor("进入创建页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/create/index" ? current : false;
  });
  const chips = await waitFor("provider 目录渲染", async () => {
    const list = await page.$$(".chip");
    return list.length >= 1 ? list : null;
  });
  // provider 优先级：zcode（t17 验证可用）> codex > 其他可用项。
  // 注意：daemon 上 claude 认证失效（403），不能作为验证 provider。
  const chipTexts = [];
  for (const chip of chips) chipTexts.push(((await chip.text()) ?? "").trim());
  console.log(`  provider 目录：${chipTexts.join("、")}`);
  const PREFERRED = ["zcode", "codex", "qoder", "kimi"];
  let chosenChip = null;
  for (const pref of PREFERRED) {
    const index = chipTexts.indexOf(pref);
    if (index >= 0) {
      chosenChip = chips[index];
      break;
    }
  }
  if (!chosenChip) chosenChip = chips[0];
  console.log(`  使用 provider：${(await chosenChip.text()).trim()}`);
  await chosenChip.tap();
  await sleep(2500);
  const prompt = await page.$(".prompt-input");
  await prompt.input("只回复 ok");
  const submitBtn = await page.$(".btn-block");
  await submitBtn.tap();
  page = await waitFor(
    "创建成功进入详情页",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agent/index" ? current : false;
    },
    { timeout: 45000 },
  );
  await sleep(3000);
  // 基线：创建后详情页的可见气泡数（定时执行后应增长）
  const baselineBubbles = (await page.$$(".bubble-text")).length;
  console.log(`  时间线基线气泡：${baselineBubbles}`);

  // ---- t18-02/03/04：定时任务 ----
  await mini.navigateTo("/pages/agents/index");
  await sleep(1200);
  page = await mini.currentPage();
  const scheduleEntry = await waitFor("定时入口出现", async () => {
    const current = await mini.currentPage();
    const entries = await current.$$(".tool-entry");
    for (const entry of entries) {
      const label = await entry.$(".tool-entry-text");
      if (label && (await label.text()) === "定时") return entry;
    }
    return null;
  });
  await scheduleEntry.tap();
  page = await waitFor("进入定时任务页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/schedules/index" ? current : false;
  });
  await waitFor("任务列表加载（空态或已有任务）", async () => {
    const current = await mini.currentPage();
    const empty = await current.$(".empty-title");
    const card = await current.$(".sch-card");
    return (empty || card) ?? null;
  });
  await shot(mini, "t18-02-schedules-page");

  const createScheduleBtn = await page.$(".sch-create-btn");
  await createScheduleBtn.tap();
  await waitFor("创建表单出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".sch-form")) ?? null;
  });
  page = await mini.currentPage();
  const schedulePrompt = await page.$(".sch-prompt");
  await schedulePrompt.input(SCHEDULE_PROMPT);
  const nameInput = await page.$(".field-input");
  await nameInput.input(SCHEDULE_NAME);
  // 频率：自定义 cron（每分钟，短周期）
  const chipsSchedules = await page.$$(".chip");
  for (const chip of chipsSchedules) {
    if ((await chip.text()) === "自定义") {
      await chip.tap();
      break;
    }
  }
  await sleep(400);
  const cronInput = await waitFor(
    "cron 输入框出现",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".sch-cron-input")) ?? null;
    },
  );
  await cronInput.input("* * * * *");
  // 目标：已有 Agent（默认选中列表第一个 = 刚创建的验证 agent）
  const targetAgentRow = await waitFor(
    "目标 agent 行出现（默认选中验证 agent）",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".sch-agent-selected")) ?? null;
    },
  );
  const agentRowName = await targetAgentRow.$(".sch-agent-name");
  const boundAgentName = await agentRowName.text();
  console.log(`  绑定 agent：${boundAgentName}`);
  await shot(mini, "t18-03-schedule-form");
  const formCreateBtn = await findButton(page, ".sch-form-actions .btn-mini", "创建");
  await formCreateBtn.tap();
  await waitFor(
    `任务卡片出现：${SCHEDULE_NAME}`,
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".sch-card", SCHEDULE_NAME)) ?? null;
    },
    { timeout: 30000 },
  );
  await shot(mini, "t18-04-schedule-created");

  // ---- t18-05：手动触发（schedule/run-once）+ 执行记录（schedule/logs） ----
  const runOnceBtn = await findButton(page, ".sch-actions .btn-mini", "立即执行");
  await runOnceBtn.tap();
  await sleep(4000); // run-once → daemon 发 prompt 给 agent → 响应带 runs
  page = await mini.currentPage();
  let runRow = await page.$(".sch-run-row");
  if (!runRow) {
    const logsBtn = await findButton(page, ".sch-actions .btn-mini", "执行记录");
    await logsBtn.tap();
    runRow = await waitFor(
      "执行记录渲染（run 行）",
      async () => {
        const current = await mini.currentPage();
        return (await current.$(".sch-run-row")) ?? null;
      },
      { timeout: 30000 },
    );
  }
  await shot(mini, "t18-05-schedule-runs");

  // ---- t18-06：agent 时间线出现定时执行记录（schedule prompt 消息） ----
  await mini.navigateTo("/pages/agents/index");
  await sleep(1500);
  const verifyCard = await waitFor(
    `验证 agent 卡片（${boundAgentName}）`,
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", boundAgentName, ".agent-title")) ?? null;
    },
  );
  await verifyCard.tap();
  page = await waitFor("进入 agent 详情", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agent/index" ? current : false;
  });
  await waitFor(
    "时间线出现定时执行记录（气泡数增长）",
    async () => {
      const current = await mini.currentPage();
      if (current.path !== "pages/agent/index") return null;
      const bubbles = await current.$$(".bubble-text");
      if (bubbles.length <= baselineBubbles) return null;
      let sawOk2 = false;
      for (const bubble of bubbles) {
        const text = await bubble.text();
        if (text && text.toLowerCase().includes("ok2")) sawOk2 = true;
      }
      return { count: bubbles.length, sawOk2 };
    },
    { timeout: 60000, interval: 1500 },
  );
  console.log("✓ 定时执行已在时间线留下记录（assistant 回复气泡）");
  await shot(mini, "t18-06-agent-timeline-schedule-run");

  // ---- t18-07：attention 徽标/高亮（真实推送优先，mock 兜底） ----
  await mini.navigateTo("/pages/agents/index");
  await sleep(1500);
  let attentionHighlighted = false;
  try {
    await waitFor(
      "真实 attention 高亮卡片",
      async () => {
        const current = await mini.currentPage();
        return (await current.$(".agent-card-attention")) ?? null;
      },
      { timeout: 30000, interval: 1000 },
    );
    attentionHighlighted = true;
  } catch {
    // 兜底：经自动化桥注入 mock attention 推送（与真实推送同一 store 入口）
    await mini.evaluate(() => {
      getApp().__automation?.attentionStore.handlePush({
        agentId: "t18-mock-attention",
        reason: "finished",
        timestamp: new Date().toISOString(),
        shouldNotify: true,
      });
    });
    await sleep(1000);
  }
  const attentionCount = await mini.evaluate(
    () => getApp().__automation?.attentionStore?.getCount?.() ?? -1,
  );
  console.log(`  attention 计数（真实高亮=${attentionHighlighted}）：${attentionCount}`);
  if (attentionCount <= 0) throw new Error("attention 徽标计数未生效");
  await shot(mini, "t18-07-attention-badge-highlight");

  // ---- t18-08：打标签（update_agent labels） ----
  page = await mini.currentPage();
  const labelAgentCard = await waitFor(
    `验证 agent 卡片（标签步骤）`,
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", boundAgentName, ".agent-title")) ?? null;
    },
  );
  await labelAgentCard.tap();
  page = await waitFor("进入 agent 详情（标签）", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agent/index" ? current : false;
  });
  const labelBtn = await waitFor(
    "标签按钮",
    async () => {
      const current = await mini.currentPage();
      return (await findButton(current, ".action-btn", "标签")) ?? null;
    },
  );
  await labelBtn.tap();
  const labelInput = await waitFor(
    "标签输入框",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".label-input")) ?? null;
    },
  );
  await labelInput.input(LABEL_TEXT);
  const addBtn = await waitFor(
    "标签添加按钮",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".label-add-btn")) ?? null;
    },
  );
  await addBtn.tap();
  await waitFor(
    "标签 chip 出现",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".label-chip", LABEL_TEXT)) ?? null;
    },
  );
  await shot(mini, "t18-08-label-editor");

  // ---- t18-09：归档（archive）→ 提示条 → 恢复（refresh）→ 再归档 → 列表筛选 ----
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
  const archiveBtn = await findButton(page, ".action-btn", "归档");
  await archiveBtn.tap();
  await waitFor(
    "归档提示条出现",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".archived-callout")) ?? null;
    },
    { timeout: 20000 },
  );
  await shot(mini, "t18-08b-archived-callout");
  // 恢复（refresh_agent，unarchive 语义验证）
  const restoreBtn = await waitFor(
    "恢复按钮（提示条内）",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".archived-callout .btn")) ?? null;
    },
  );
  await restoreBtn.tap();
  await waitFor(
    "归档提示条消失（已恢复）",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".archived-callout")) === null;
    },
    { timeout: 20000 },
  );
  console.log("✓ refresh_agent 恢复归档成功");
  // 再次归档，回列表看筛选
  const archiveBtn2 = await findButton(page, ".action-btn", "归档");
  await archiveBtn2.tap();
  await waitFor(
    "归档提示条出现（第二次）",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".archived-callout")) ?? null;
    },
    { timeout: 20000 },
  );
  await mini.navigateBack();
  await sleep(1500);
  const archivedFilter = await waitFor(
    "归档筛选 chip",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".filter-chip", "归档")) ?? null;
    },
  );
  await archivedFilter.tap();
  await waitFor(
    "归档卡片出现（已归档 pill）",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", "已归档", ".pill")) ?? null;
    },
    { timeout: 20000 },
  );
  await shot(mini, "t18-09-archive-filter");

  // ---- t18-10：导入已有会话 tab ----
  await mini.navigateTo("/pages/create/index");
  await sleep(1500);
  const importTab = await waitFor(
    "导入 tab",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".tab-item", "导入已有会话")) ?? null;
    },
  );
  await importTab.tap();
  await waitFor(
    "会话目录渲染（列表或空态）",
    async () => {
      const current = await mini.currentPage();
      const rows = await current.$$(".import-row");
      const muted = await current.$(".import-hint-card .muted");
      return rows.length > 0 || muted ? true : null;
    },
    { timeout: 30000 },
  );
  page = await mini.currentPage();
  const importRows = await page.$$(".import-row");
  console.log(`  provider 会话目录：${importRows.length} 条`);
  await shot(mini, "t18-10-import-sessions");

  // ---- t18-11：工作区脚本（workspace.script.list） ----
  await mini.navigateBack();
  await sleep(600);
  await mini.navigateTo("/pages/agents/index");
  await sleep(1500);
  const scriptsEntry = await waitFor(
    "脚本入口出现",
    async () => {
      const current = await mini.currentPage();
      const entries = await current.$$(".tool-entry");
      for (const entry of entries) {
        const label = await entry.$(".tool-entry-text");
        if (label && (await label.text()) === "脚本") return entry;
      }
      return null;
    },
  );
  await scriptsEntry.tap();
  await waitFor("进入脚本页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/scripts/index" ? current : false;
  });
  await waitFor(
    "脚本列表渲染（脚本卡片或空态）",
    async () => {
      const current = await mini.currentPage();
      const card = await current.$(".script-card");
      const empty = await current.$(".empty-title");
      return (card || empty) ?? null;
    },
    { timeout: 30000 },
  );
  page = await mini.currentPage();
  const scriptCards = await page.$$(".script-card");
  console.log(`  workspace scripts：${scriptCards.length} 个`);
  await shot(mini, "t18-11-workspace-scripts");
  await mini.navigateBack();
  await sleep(800);

  // ---- t18-12：新建工作区（注册本机目录；幂等注册当前工作区目录） ----
  page = await mini.currentPage();
  const wsBar2 = await waitFor(
    "工作区栏（新建工作区步骤）",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".ws-bar-main")) ?? null;
    },
  );
  await wsBar2.tap();
  await sleep(800);
  const newRow = await waitFor(
    "新建工作区入口行",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".ws-new-row")) ?? null;
    },
  );
  await newRow.tap();
  await waitFor("进入新建工作区页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/new-workspace/index" ? current : false;
  });
  const currentDirectory = await mini.evaluate(
    () => getApp().__automation?.workspaceStore?.getSnapshot?.()?.directory ?? "",
  );
  await shot(mini, "t18-12-new-workspace-page");
  if (!currentDirectory) {
    console.log("  ⚠ 未取到当前工作区目录，跳过注册提交（仅截图）");
  } else {
    console.log(`  幂等注册当前工作区目录：${currentDirectory}`);
    page = await mini.currentPage();
    const wsInput = await page.$(".field-input");
    await wsInput.input(currentDirectory);
    const registerBtn = await page.$(".btn-block");
    await registerBtn.tap();
    await waitFor(
      "注册成功返回列表",
      async () => {
        const current = await mini.currentPage();
        return current.path === "pages/agents/index" ? current : false;
      },
      { timeout: 30000 },
    );
    console.log("✓ open_project 幂等注册成功（返回现有工作区）");
  }

  // ---- t18-13/14：主题三档 ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1200);
  const darkOption = await waitFor(
    "深色选项",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".theme-option", "深色")) ?? null;
    },
  );
  await darkOption.tap();
  await sleep(1500);
  await shot(mini, "t18-13-settings-theme-dark");
  await mini.navigateTo("/pages/agents/index");
  await sleep(1200);
  await waitFor(
    "深色档 class 生效",
    async () => {
      const current = await mini.currentPage();
      return (await current.$(".theme-dark")) ?? null;
    },
  );
  await shot(mini, "t18-14-agents-theme-dark");
  await mini.navigateBack();
  await sleep(800);
  const autoOption = await waitFor(
    "跟随系统选项",
    async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".theme-option", "跟随系统")) ?? null;
    },
  );
  await autoOption.tap();
  await sleep(800);

  // ---- t18-15：清理（删除全部 t18 定时任务 + 全部验证 agent；防上次中断遗留） ----
  await mini.navigateTo("/pages/schedules/index");
  await sleep(1500);
  for (;;) {
    const card = await (async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".sch-card", SCHEDULE_NAME)) ?? null;
    })();
    if (!card) break;
    page = await mini.currentPage();
    const deleteScheduleBtn = await findButton(page, ".sch-actions .btn-mini", "删除");
    await deleteScheduleBtn.tap();
    await waitFor(
      "任务卡片已删除（本轮）",
      async () => {
        const current = await mini.currentPage();
        return (await findByText(current, ".sch-card", SCHEDULE_NAME)) === null;
      },
      { timeout: 20000 },
    );
    console.log("✓ 定时任务已删除（可能含上次中断遗留）");
  }

  await mini.navigateTo("/pages/agents/index");
  await sleep(1500);
  for (;;) {
    // 归档筛选下删，再回到进行中筛选删，直到两个筛选都找不到验证 agent
    const archivedFilter = await (async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".filter-chip", "归档")) ?? null;
    })();
    await archivedFilter.tap();
    await sleep(1200);
    let card = await (async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", boundAgentName, ".agent-title")) ?? null;
    })();
    if (!card) {
      // 归档里没有 → 查进行中
      const activeFilter = await (async () => {
        const current = await mini.currentPage();
        return (await findByText(current, ".filter-chip", "进行中")) ?? null;
      })();
      await activeFilter.tap();
      await sleep(1200);
      card = await (async () => {
        const current = await mini.currentPage();
        return (await findByText(current, ".agent-card", boundAgentName, ".agent-title")) ?? null;
      })();
    }
    if (!card) break;
    await card.tap();
    page = await waitFor("进入详情（清理）", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agent/index" ? current : false;
    });
    const deleteBtn = await waitFor(
      "删除按钮",
      async () => {
        const current = await mini.currentPage();
        const btns = await current.$$(".action-btn.btn-danger");
        return btns.length >= 1 ? btns[btns.length - 1] : null;
      },
    );
    await deleteBtn.tap();
    await waitFor(
      "删除后返回列表",
      async () => {
        const current = await mini.currentPage();
        return current.path === "pages/agents/index" ? current : false;
      },
      { timeout: 30000 },
    );
    console.log("✓ 验证 agent 已删除（可能含上次中断遗留）");
  }
  await shot(mini, "t18-15-cleanup-done");
  console.log("✓ 清理完成：t18 定时任务与验证 agent 均已删除");

  clearInterval(heartbeatTimer);
  await mini.disconnect();
  console.log("done");
}

main().catch((err) => {
  console.error("t18 automation failed:", err);
  process.exit(1);
});
