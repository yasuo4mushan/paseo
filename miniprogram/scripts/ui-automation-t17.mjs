/**
 * t17 UI 自动化验收：文件体系——文件浏览器 / 预览 / 下载保存 / 附件上传。
 *
 * 前置：
 *   1. 真实 hub 已注册探针账号并预置带真实 relay offer 的设备（本脚本自动完成：
 *      auth.register + devices.register + 心跳保活）。
 *   2. 开发者工具已开服务端口：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9423
 *
 * 用法：node scripts/ui-automation-t17.mjs
 *
 * 产物（docs/screenshots/t17-*.png）：
 *   01 Agent 列表（文件入口）→ 02 文件浏览器（真实工作区根目录）→
 *   03 子目录浏览（chemflow/README.md）→ 04 文本文件内嵌预览（method.out）→
 *   05 PDF 下载保存 + wx.openDocument（method.pdf，301KB 真实二进制帧下载）→
 *   06 小文件下载保存（method.out 长按 → 下载目录落地）→
 *   07 新建验证 agent + 附件上传（mock chooseMedia 上传真实 PNG 字节）→
 *   08 发送带附件消息 → 时间线附件卡片 → 09 删除验证 agent
 *
 * 配额纪律：只创建一个真实 agent（短 prompt"只回复 ok"），验证后删除。
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
const WS = "ws://127.0.0.1:9423";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t17-mac-dev";

// 任务给定的真实 relay offer（.paseo-xdb daemon，工作区含真实文件）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t17probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t17probe-pass-1";

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

/** 读取 __automation.downloadLog（t17 页面侧记录的真实 wx 调用结果）。 */
async function readDownloadLog(mini) {
  return mini.evaluate(() => getApp().__automation?.downloadLog ?? []);
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
  console.log("connected to devtools automation (port 9423)");

  // ---- 登录（真实 hub） ----
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
  page = await waitFor("登录成功进入设备页", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/devices/index") return false;
    page = current;
    return true;
  });

  // ---- 连接真实设备（relay E2EE） ----
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

  // ---- 选择真实工作区（daemon fetch_workspaces） ----
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

  // ---- t17-01：Agent 列表的文件入口 ----
  await waitFor("文件入口出现", async () => (await page.$(".files-entry")) ?? null);
  await shot(mini, "t17-01-agents-files-entry");

  // ---- t17-02：文件浏览器（真实根目录） ----
  const filesEntry = await page.$(".files-entry");
  await filesEntry.tap();
  page = await waitFor("进入文件浏览器", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/files/index" ? current : false;
  });
  const fileRows = await waitFor(
    "真实目录条目渲染",
    async () => {
      const rows = await page.$$(".file-row");
      return rows.length >= 3 ? rows : null;
    },
    { timeout: 30000 },
  );
  console.log(`  daemon 返回 ${fileRows.length} 个条目`);
  await shot(mini, "t17-02-files-root");

  // ---- t17-03：进入子目录 chemflow（README.md 可见） ----
  const chemflowRow = await waitFor("找到 chemflow 目录行", async () => {
    const rows = await page.$$(".file-row");
    for (const row of rows) {
      const name = await row.$(".file-name");
      if (name && (await name.text()) === "chemflow") return row;
    }
    return null;
  });
  await chemflowRow.tap();
  await waitFor(
    "子目录渲染（README.md）",
    async () => {
      const rows = await page.$$(".file-row");
      for (const row of rows) {
        const name = await row.$(".file-name");
        if (name && (await name.text()) === "README.md") return true;
      }
      return false;
    },
    { timeout: 30000 },
  );
  await shot(mini, "t17-03-files-subdir-chemflow");

  // ---- t17-04：文本预览（chemflow/README.md，二进制帧读取 → 内嵌渲染） ----
  const readmeRow = await waitFor("找到 README.md 行", async () => {
    const rows = await page.$$(".file-row");
    for (const row of rows) {
      const name = await row.$(".file-name");
      if (name && (await name.text()) === "README.md") return row;
    }
    return null;
  });
  await readmeRow.tap();
  await waitFor("文本预览浮层出现", async () => (await page.$(".preview-overlay")) ?? null, {
    timeout: 30000,
  });
  await waitFor("预览内容非空", async () => {
    const text = await page.$(".preview-text");
    if (!text) return false;
    const content = await text.text();
    return content && content.length > 20 ? content.length : false;
  });
  console.log("  README.md 预览内容渲染成功");
  await shot(mini, "t17-04-text-preview");
  const previewClose = await page.$(".preview-close");
  await previewClose.tap();
  await sleep(600);

  // 返回根目录
  const backBtn = await waitFor("返回按钮出现", async () => (await page.$(".crumbs-back")) ?? null);
  await backBtn.tap();
  await sleep(1500);

  // ---- t17-05：PDF 下载保存 + wx.openDocument（method.pdf，真实 301KB 二进制流） ----
  const pdfRow = await waitFor("找到 method.pdf 行", async () => {
    const rows = await page.$$(".file-row");
    for (const row of rows) {
      const name = await row.$(".file-name");
      if (name && (await name.text()) === "method.pdf") return row;
    }
    return null;
  });
  await pdfRow.tap();
  const pdfDownload = await waitFor(
    "PDF 下载完成 + openDocument 成功（页面记录）",
    async () => {
      const log = await readDownloadLog(mini);
      const complete = log.find(
        (e) => e.kind === "download_complete" && e.fileName === "method.pdf",
      );
      const opened = log.find((e) => e.kind === "open_document" && e.fileName === "method.pdf");
      return complete && opened && opened.ok === true ? { complete, opened } : false;
    },
    { timeout: 120000, interval: 1000 },
  );
  console.log(
    `  method.pdf 下载 ${(pdfDownload.complete.size / 1024).toFixed(1)}KB → ${pdfDownload.complete.filePath}，openDocument ✓`,
  );
  await shot(mini, "t17-05-pdf-download-opendocument");

  // ---- t17-06：小文件下载（method.out 长按 → 下载目录落地） ----
  await mini.mockWxMethod("showModal", { confirm: false, cancel: true });
  const outRow = await waitFor("找到 method.out 行", async () => {
    const rows = await page.$$(".file-row");
    for (const row of rows) {
      const name = await row.$(".file-name");
      if (name && (await name.text()) === "method.out") return row;
    }
    return null;
  });
  await outRow.longpress();
  const outDownload = await waitFor(
    "method.out 下载完成（页面记录）",
    async () => {
      const log = await readDownloadLog(mini);
      const complete = log.find(
        (e) => e.kind === "download_complete" && e.fileName === "method.out",
      );
      return complete ?? false;
    },
    { timeout: 60000, interval: 1000 },
  );
  console.log(`  method.out 下载 ${outDownload.size}B → ${outDownload.filePath}`);
  await shot(mini, "t17-06-smallfile-download");

  // ---- t17-07/08：附件上传（新建验证 agent，短 prompt，配额纪律） ----
  await mini.navigateTo("/pages/agents/index");
  await sleep(1200);
  page = await mini.currentPage();
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
  let chosenChip = null;
  for (const chip of chips) {
    const text = await chip.text();
    if (text === "zcode") {
      chosenChip = chip;
      break;
    }
  }
  if (!chosenChip) chosenChip = chips[0];
  console.log(`  使用 provider：${await chosenChip.text()}`);
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

  // 准备上传用真实 PNG：写入 USER_DATA_PATH（1x1 PNG）
  const pngBase64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const userPath = await mini.evaluate((b64) => {
    const path = `${wx.env.USER_DATA_PATH}/t17-upload.png`;
    wx.getFileSystemManager().writeFileSync(path, b64, "base64");
    return path;
  }, pngBase64);
  console.log(`  测试图片已写入：${userPath}`);
  await mini.mockWxMethod("showActionSheet", { tapIndex: 0, errMsg: "showActionSheet:ok" });
  await mini.mockWxMethod("chooseMedia", {
    tempFiles: [{ tempFilePath: userPath, fileType: "image", size: 95 }],
    errMsg: "chooseMedia:ok",
  });

  const attachBtn = await waitFor(
    "附件 + 按钮出现",
    async () => (await page.$(".attach-btn")) ?? null,
  );
  await attachBtn.tap();
  await sleep(800); // actionSheet mock → chooseMedia mock → 读文件 → 上传
  const readyChip = await waitFor(
    "附件上传完成（chip ready）",
    async () => {
      const chip = await page.$(".attach-chip-ready");
      return chip ?? null;
    },
    { timeout: 30000 },
  );
  console.log("  附件上传成功（file.upload.request + 二进制帧 → uploaded_file）");
  await shot(mini, "t17-07-attach-uploaded");

  // 发送带附件的消息
  const composer = await page.$(".composer-input");
  await composer.input("看这张测试图");
  await sleep(300);
  const sendBtn = await page.$(".send-btn");
  await sendBtn.tap();
  await waitFor(
    "时间线出现附件卡片",
    async () => {
      const card = await page.$(".attach-cards");
      return card ?? null;
    },
    { timeout: 30000 },
  );
  await sleep(1500); // 等 daemon 回显 user_message（clientMessageId 去重）
  await shot(mini, "t17-08-attach-sent-timeline");
  console.log("✓ 附件卡片已渲染（本地台账 clientMessageId 回配对）");

  // ---- t17-09：删除验证 agent（配额处置） ----
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
  const deleteBtns = await page.$$(".action-btn.btn-danger");
  if (deleteBtns.length === 0) throw new Error("未找到删除按钮");
  await deleteBtns[deleteBtns.length - 1].tap();
  await sleep(2500);
  page = await waitFor("删除后返回列表页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/agents/index" ? current : false;
  });
  await shot(mini, "t17-09-verification-agent-deleted");
  console.log("✓ 验证 agent 已删除（配额处置：已删）");

  clearInterval(heartbeatTimer);
  await mini.disconnect();
  console.log("done");
}

main().catch((err) => {
  console.error("t17 automation failed:", err);
  process.exit(1);
});
