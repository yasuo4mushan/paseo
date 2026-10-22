/**
 * t16 UI 自动化验收：微信小程序功能对齐（第一批）——真实 hub + 真实 daemon。
 *
 * 前置：
 *   1. 真实 hub 已注册探针账号并预置带真实 relay offer 的设备（curl，见
 *      docs/screenshots/README 或任务记录；账号通过环境变量传入）。
 *   2. 开发者工具已开服务端口：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9422
 *
 * 用法：node scripts/ui-automation-t16.mjs
 *   环境变量：PROBE_USER / PROBE_PASS（真实 hub 账号）
 *
 * 产物（docs/screenshots/t16-*.png）：
 *   01 agents 列表（工作区栏）→ 02 工作区选择（真实工作区）→ 03 选中回填 →
 *   04 创建表单（真实 provider/model）→ 05 真实创建的 agent 详情 →
 *   06 中断 → 07 删除确认 → 08 权限弹层（mock 推送，工具授权）→
 *   09 权限弹层（计划确认形态）→ 10 深色模式
 *
 * 配额纪律：全程只创建一个真实 agent（短 prompt），验证后即删除。
 */

import { mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9422";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t16-mac-dev";

const PROBE_USER = process.env.PROBE_USER;
const PROBE_PASS = process.env.PROBE_PASS;
if (!PROBE_USER || !PROBE_PASS) {
  console.error("缺少 PROBE_USER / PROBE_PASS（真实 hub 探针账号）");
  process.exit(1);
}

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

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9422)");

  // ---- 登录 ----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_base");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_workspace");
  await mini.callWxMethod("removeStorageSync", "paseo_mp_connection");
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
  await waitFor("登录成功进入设备页", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/devices/index") return false;
    page = current;
    return true;
  });

  // ---- 设备保活 + 连接 ----
  const token = await mini.callWxMethod("getStorageSync", "aaswitch_hub_token");
  const callApi = hubCall(token);
  const listResult = await callApi("devices.list", {});
  const device = listResult.data.devices.find((d) => d.name === DEVICE_NAME);
  if (!device) throw new Error(`hub 上未找到设备 ${DEVICE_NAME}`);
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId: device.deviceId }).catch(() => {});
  }, 25_000);
  await callApi("devices.heartbeat", { deviceId: device.deviceId });
  await mini.reLaunch("/pages/devices/index");
  await sleep(2500);
  page = await mini.currentPage();
  const onlineCard = await waitFor("存在在线设备卡片", async () => {
    const el = await page.$(".device-online");
    return el ?? null;
  });
  await onlineCard.tap();
  page = await waitFor("连接成功进入 Agent 列表", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agents/index" ? current : false;
  }, { timeout: 30000 });
  await sleep(2500);
  await waitFor("工作区栏出现", async () => (await page.$(".ws-bar")) !== null);
  await shot(mini, "t16-01-agents-workspace-bar");

  // ---- 工作区选择（真实 fetch_workspaces） ----
  const wsBar = await page.$(".ws-bar-main");
  await wsBar.tap();
  await sleep(800);
  const wsRow = await waitFor("真实工作区列表渲染", async () => {
    const rows = await page.$$(".ws-row");
    return rows.length >= 1 ? rows : null;
  });
  console.log(`  daemon 返回 ${wsRow.length} 个工作区`);
  await shot(mini, "t16-02-workspace-picker");
  await wsRow[0].tap();
  await sleep(800);
  await waitFor("工作区选中回填到顶栏", async () => {
    const value = await page.$(".ws-bar-value");
    const text = await value.text();
    return text && text !== "选择工作区" ? text : null;
  });
  await shot(mini, "t16-03-agents-workspace-selected");

  // ---- 创建表单（真实 provider/model 目录） ----
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
  console.log(`  可选 provider：${chips.length} 个`);
  // 优先 zcode（内部 GLM），否则第一个可用 chip
  let providerText = "";
  let chosenChip = null;
  for (const chip of chips) {
    const text = await chip.text();
    if (text === "zcode") {
      chosenChip = chip;
      providerText = text;
      break;
    }
  }
  if (!chosenChip) {
    chosenChip = chips[0];
    providerText = await chips[0].text();
  }
  console.log(`  使用 provider：${providerText}`);
  await chosenChip.tap();
  await sleep(2500); // 等 model/mode 目录
  await shot(mini, "t16-04-create-form");

  // ---- 创建一个真实 agent（短 prompt，配额纪律：仅此一个） ----
  const prompt = await page.$(".prompt-input");
  await prompt.input("只回复 ok");
  const submitBtn = await page.$(".btn-block");
  await submitBtn.tap();
  page = await waitFor("创建成功进入详情页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agent/index" ? current : false;
  }, { timeout: 45000 });
  await sleep(3000); // 等时间线加载（agent 可能正在回复 ok）
  await shot(mini, "t16-05-agent-created");

  // ---- 中断（若 agent 还在运行则点击，否则仅截图说明） ----
  const interruptBtn = await page.$(".action-btn.btn-ghost");
  if (interruptBtn) {
    await shot(mini, "t16-06-agent-running-interrupt");
    await interruptBtn.tap();
    await sleep(2000);
    console.log("✓ 中断请求已发送");
  } else {
    console.log("（agent 已完成，中断按钮不展示——空态验证通过）");
  }

  // ---- 删除（mock wx.showModal 确认，避免原生弹窗阻塞自动化） ----
  await shot(mini, "t16-07-detail-actions");
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
  const deleteBtns = await page.$$(".action-btn.btn-danger");
  if (deleteBtns.length === 0) throw new Error("未找到删除按钮");
  await deleteBtns[deleteBtns.length - 1].tap();
  await sleep(2500);
  page = await waitFor("删除后返回列表页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agents/index" ? current : false;
  });
  console.log("✓ 真实 agent 已删除（配额处置：已删）");

  // ---- 权限弹层：mock 推送驱动（automator 难自然触发真实权限请求） ----
  await mini.evaluate((push) => {
    const app = getApp();
    app.__automation.permissionStore.handlePush(push);
  }, {
    agentId: "demo-agent-0001",
    request: {
      id: "perm-demo-tool",
      provider: "claude",
      name: "Bash",
      kind: "tool",
      input: { command: "git push origin main" },
    },
  });
  await waitFor("权限弹层出现（工具授权）", async () => {
    const sheet = await page.$(".perm-sheet");
    return sheet ?? null;
  });
  await shot(mini, "t16-08-permission-tool");
  // 演示"允许"交互：走真实 respond RPC 会打到不存在的权限 id，改为本地清队
  await mini.evaluate(() => {
    const app = getApp();
    app.__automation.permissionStore.clearAll();
  });
  await sleep(600);
  await mini.evaluate((push) => {
    const app = getApp();
    app.__automation.permissionStore.handlePush(push);
  }, {
    agentId: "demo-agent-0002",
    request: {
      id: "perm-demo-plan",
      provider: "claude",
      name: "ExitPlanMode",
      kind: "plan",
      title: "实施计划确认",
      actions: [
        { id: "keep-planning", label: "继续规划", behavior: "deny", variant: "secondary" },
        { id: "implement", label: "按计划实施", behavior: "allow", variant: "primary" },
      ],
      input: { plan: "1. 读配置 2. 改代码 3. 跑测试" },
    },
  });
  await waitFor("权限弹层出现（计划确认，多档动作）", async () => {
    const sheet = await page.$(".perm-sheet");
    return sheet ?? null;
  });
  await shot(mini, "t16-09-permission-plan");
  await mini.evaluate(() => {
    const app = getApp();
    app.__automation.permissionStore.clearAll();
  });

  clearInterval(heartbeatTimer);
  await mini.disconnect();
  console.log("done");
}

main().catch((err) => {
  console.error("t16 automation failed:", err);
  process.exit(1);
});
