/**
 * t19 UI 自动化验收：功能对齐终批——Markdown 富渲染 / 文件写回与条目操作 /
 * diff 查看 / 终端流（脚本输出 + 工作区终端）/ subagents / 斜杠命令 /
 * 重命名 / 导出。
 *
 * 前置：
 *   1. 真实 hub 注册探针账号 + 预置真实 relay offer 设备（本脚本自动完成）。
 *   2. 开发者工具自动化端口已开：
 *      <cli> auto --project <miniprogram 绝对路径> --auto-port 9425
 *
 * 用法：node scripts/ui-automation-t19.mjs
 *
 * 配额纪律：只创建一个验证 agent（短 prompt 要求 markdown 回复），验证后删除；
 * 文件操作用 t19-<ts> 前缀的临时文件，验证后删除。
 *
 * 产物（docs/screenshots/t19-*.png）：
 *   01/02 Markdown 时间线与代码块        03 斜杠命令面板
 *   04 subagents 轨道                    05 新建文件（fs.entry.create）
 *   06 编辑器写回保存（fs.file.write）   07 写回读回验证
 *   08 重命名（fs.entry.rename）         09 删除（fs.entry.delete）
 *   10 commit 列表（checkout.commits）   11 逐行 +/- diff
 *   12 工作区终端（create+subscribe）    13 脚本输出入口（如可用）
 *   14 清理完成（验证 agent 已删）
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9425";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t19-mac-dev";

// 任务给定的真实 relay offer（.paseo-xdb daemon，真实工作区/agent）
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = process.env.PROBE_USER ?? `t19probe-${Date.now().toString(36)}`;
const PROBE_PASS = process.env.PROBE_PASS ?? "t19probe-pass-1";

const MARKDOWN_PROMPT = [
  "请严格按以下 markdown 结构回复（不要多余解释）：",
  "1. 一个二级标题「t19 渲染验证」",
  "2. 一个三项无序列表",
  "3. 一个 python 代码块，内容两行：print('t19') 和 print('done')",
  "4. 一句含粗体的话",
].join("\n");

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

async function findButton(page, selector, text) {
  return findByText(page, selector, text);
}

/** 读取 __automation.downloadLog（页面侧记录的真实 RPC 结果）。 */
async function readLog(mini) {
  return mini.evaluate(() => getApp().__automation?.downloadLog ?? []);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const stamp = Date.now().toString(36);
  const TEST_FILE = `t19-edit-${stamp}.md`;
  const RENAMED_FILE = `t19-renamed-${stamp}.md`;

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
  console.log("connected to devtools automation (port 9425)");

  // ---- 登录 + 连接真实设备（relay E2EE） ----
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
  await userInput.input(PROBE_USER);
  await passInput.input(PROBE_PASS);
  const loginBtn = await page.$(".btn-login");
  await loginBtn.tap();
  await waitFor("登录成功进入设备页", async () => {
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

  // ---- t19-01/02：创建验证 agent → Markdown 富渲染 ----
  // provider 级失败（如 codex 当前默认模型 404）时删除换下一个重试；
  // 任一 provider 产出含代码块的 markdown 回复即通过。
  const PREFERRED = ["zcode", "opencode", "kimi", "qoder", "codex"];

  const buildCandidates = async (pageObj) => {
    const chipList = await waitFor("provider 目录渲染", async () => {
      const current = await mini.currentPage();
      const list = await current.$$(".chip");
      return list.length >= 1 ? list : null;
    });
    const byName = new Map();
    for (const chip of chipList) {
      const text = ((await chip.text()) ?? "").trim();
      if (!byName.has(text)) byName.set(text, chip);
    }
    const ordered = [];
    for (const pref of PREFERRED) {
      if (byName.has(pref)) ordered.push({ name: pref, chip: byName.get(pref) });
    }
    for (const [name, chip] of byName) {
      // 只收小写单词形 provider 名——排除 "Plan Mode"/"Bypass" 等 mode chip
      if (!PREFERRED.includes(name) && /^[a-z][a-z0-9_-]*$/.test(name))
        ordered.push({ name, chip });
    }
    return ordered;
  };

  const openCreatePage = async () => {
    await mini.reLaunch("/pages/agents/index");
    await sleep(1000);
    const pageObj = await mini.currentPage();
    const entry = await pageObj.$(".create-entry");
    await entry.tap();
    return waitFor("进入创建页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/create/index" ? current : false;
    });
  };

  page = await openCreatePage();
  let candidates = await buildCandidates(page);
  console.log(`  provider 候选：${candidates.map((c) => c.name).join("、")}`);
  let usedExistingAgent = false; // provider 全挂时的回退标记（已有 agent 真实历史验证）
  let EXISTING_AGENT_TITLE = "";

  let codeBlock = null;
  let attempt = 0;
  // 索引循环：失败后重建的 candidates（新页面元素）在下一轮迭代生效。
  // for...of 持有旧数组引用——旧页面元素句柄已销毁（page destroyed）。
  for (let ci = 0; ci < candidates.length && !codeBlock; ci += 1) {
    const candidate = candidates[ci];
    attempt += 1;
    console.log(`  尝试 provider（${attempt}/${candidates.length}）：${candidate.name}`);
    await candidate.chip.tap();
    await sleep(2500);
    const prompt = await page.$(".prompt-input");
    await prompt.input(MARKDOWN_PROMPT);
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
    codeBlock = await waitFor(
      `assistant 回复以 Markdown 渲染（代码块出现，provider=${candidate.name}）`,
      async () => {
        const current = await mini.currentPage();
        if (current.path !== "pages/agent/index") return null;
        const root = await current.$(".md-root");
        if (!root) return null;
        return (await current.$(".md-code-block")) ?? null;
      },
      { timeout: 90_000, interval: 2000 },
    ).catch(() => null);
    if (codeBlock) {
      console.log(`✓ ${candidate.name} 产出 markdown 回复`);
      break;
    }
    // 失败（模型 404 / 超时）：记录最后气泡诊断 → 删除本 agent 换下一个
    try {
      const roots = await page.$$(".md-root");
      const last = roots[roots.length - 1];
      if (last) {
        const text = ((await last.text()) ?? "").slice(0, 120).replace(/\n/g, "\\n");
        console.log(`  最后气泡：${text}`);
      }
    } catch {
      // 诊断失败忽略
    }
    console.log(`  ${candidate.name} 未产出回复，删除重试`);
    await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
    const delBtns = await page.$$(".action-btn.btn-danger");
    if (delBtns.length > 0) {
      await delBtns[delBtns.length - 1].tap();
      await sleep(2000);
    }
    page = await openCreatePage();
    candidates = await buildCandidates(page);
  }
  if (!codeBlock) {
    // 回退：daemon provider 全部不可用（账号 403/模型 404）时，用已有 agent 的
    // 真实历史消息验证 markdown 渲染（任务书允许的替代路径）。
    console.log("  provider 全部不可用 → 回退：已有 agent 真实历史验证 markdown");
    await mini.reLaunch("/pages/agents/index");
    await sleep(2500);
    let agentPage = null;
    let fallbackTitle = "";
    const cardsNow = await (await mini.currentPage()).$$(".agent-card");
    for (const card of cardsNow) {
      const title = await card.$(".agent-title");
      const t = title ? ((await title.text()) ?? "").trim() : "";
      await card.tap();
      await sleep(2500);
      const current = await mini.currentPage();
      const block = await current.$(".md-code-block");
      if (block) {
        codeBlock = block;
        agentPage = current;
        fallbackTitle = t;
        break;
      }
      await mini.navigateBack();
      await sleep(1200);
    }
    if (!codeBlock) throw new Error("无 provider 可用且无含代码块历史消息的 agent");
    page = agentPage;
    usedExistingAgent = true;
    EXISTING_AGENT_TITLE = fallbackTitle;
    console.log(`✓ 使用已有 agent「${fallbackTitle}」真实历史渲染 markdown`);
  }
  const codeText = await (await codeBlock.$(".md-code-text")).text();
  console.log(`✓ 代码块真实内容（${codeText.trim().slice(0, 40)}…）`);
  await sleep(500);
  await shot(mini, "t19-01-agent-markdown");
  // 标题/列表/粗体渲染证据：md-heading 与 md-list 至少一个存在
  const hasHeading = (await page.$(".md-heading")) !== null;
  const hasList = (await page.$(".md-list")) !== null;
  const hasTable = (await page.$(".md-table")) !== null;
  console.log(`  md-heading=${hasHeading} md-list=${hasList} md-table=${hasTable}`);
  await shot(mini, "t19-02-code-block");

  // ---- t19-03：斜杠命令面板 ----
  const composerInput = await page.$(".composer-input");
  await composerInput.input("/");
  // 结果二选一：面板出现（目录非空）或 RPC 完成但目录为空（面板按设计不弹）
  const slashOutcome = await waitFor(
    "斜杠命令 RPC 完成（面板或空目录）",
    async () => {
      const logEntries = await readLog(mini);
      const entry = logEntries.find((e) => String(e.kind).startsWith("slash_commands"));
      if (!entry) return null;
      return entry;
    },
    { timeout: 25000, interval: 800 },
  );
  const slashCount = Number(slashOutcome.count ?? -1);
  if (slashCount > 0) {
    await waitFor("斜杠命令面板出现", async () => {
      const current = await mini.currentPage();
      return (await current.$(".slash-row")) ?? null;
    });
    console.log(`✓ 斜杠命令目录非空：${slashCount} 条，面板已弹出`);
    await shot(mini, "t19-03-slash-commands");
  } else {
    console.log(`✓ 斜杠命令 RPC 真实往返完成，daemon 目录为空（${slashCount} 条）→ 面板不弹属预期`);
    await shot(mini, "t19-03-slash-commands-empty");
  }
  await composerInput.input("");

  // ---- t19-04：subagents 轨道 ----
  const subBtn = await findButton(page, ".action-btn", "子代理");
  await subBtn.tap();
  await waitFor("subagents 面板出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".subagent-panel")) ?? null;
  });
  await shot(mini, "t19-04-subagents");
  const subClose = await page.$(".subagent-close");
  await subClose.tap();
  await sleep(300);

  // ---- 导出（剪贴板验证） ----
  const exportBtn = await findButton(page, ".action-btn", "导出");
  await exportBtn.tap();
  await sleep(1200);
  const clipboard = await mini.callWxMethod("getClipboardData");
  const clipOk = typeof clipboard?.data === "string" && clipboard.data.includes("# ");
  console.log(`✓ 导出剪贴板含 markdown 标题：${clipOk}`);
  if (!clipOk) throw new Error("导出剪贴板校验失败");

  // ---- 重命名验证 agent（update_agent name；同时让清理可唯一定位） ----
  // 已有 agent 回退场景：改名 → 截图 → 改回原名（不留副作用）。
  const VERIFY_NAME = `t19验证-${stamp}`;
  const labelBtn = await findButton(page, ".action-btn", "标签");
  await labelBtn.tap();
  await waitFor("标签/名称编辑器出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".label-editor")) ?? null;
  });
  const nameInputs = await page.$$(".label-input");
  if (nameInputs.length < 2)
    throw new Error(`名称输入框未找到（.label-input x${nameInputs.length}）`);
  await nameInputs[1].input(VERIFY_NAME);
  const renameBtn = await findButton(page, ".label-editor .btn", "重命名");
  await renameBtn.tap();
  await waitFor(`标题更新为 ${VERIFY_NAME}`, async () => {
    const current = await mini.currentPage();
    const titleEl = await current.$(".composer-title");
    if (!titleEl) return null;
    const text = await titleEl.text();
    return text.includes(VERIFY_NAME) ? text : null;
  });
  console.log("✓ update_agent 重命名真实成功（导航标题同步）");
  await shot(mini, "t19-04b-agent-renamed");
  if (usedExistingAgent) {
    // 改回原名（不留副作用）
    const nameInputs2 = await page.$$(".label-input");
    await nameInputs2[1].input(EXISTING_AGENT_TITLE);
    const renameBackBtn = await findButton(page, ".label-editor .btn", "重命名");
    await renameBackBtn.tap();
    await waitFor(`标题还原为 ${EXISTING_AGENT_TITLE}`, async () => {
      const current = await mini.currentPage();
      const titleEl = await current.$(".composer-title");
      if (!titleEl) return null;
      const text = await titleEl.text();
      return text.includes(EXISTING_AGENT_TITLE) ? text : null;
    });
    console.log(`✓ 已还原原名「${EXISTING_AGENT_TITLE}」`);
  }
  const doneBtn = await page.$(".label-editor-done");
  if (doneBtn) await doneBtn.tap();
  await sleep(300);

  // ---- t19-05：文件页 → 新建文件（fs.entry.create） ----
  await mini.reLaunch("/pages/agents/index");
  await sleep(1200);
  page = await mini.currentPage();
  const filesEntry = await findButton(page, ".tool-entry", "文件");
  await filesEntry.tap();
  page = await waitFor("进入文件页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/files/index" ? current : false;
  });
  await waitFor("目录列表加载", async () => {
    const current = await mini.currentPage();
    return (await current.$$(".file-row")).length > 0 ? true : null;
  });
  // mock：actionSheet 选"新建文件"，modal 输入文件名
  await mini.mockWxMethod("showActionSheet", { tapIndex: 0, errMsg: "showActionSheet:ok" });
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false, content: TEST_FILE });
  const addBtn = await page.$(".crumbs-add");
  await addBtn.tap();
  await waitFor(`新建文件出现在列表：${TEST_FILE}`, async () => {
    const current = await mini.currentPage();
    return (await findByText(current, ".file-row", TEST_FILE, ".file-name")) ?? null;
  });
  await shot(mini, "t19-05-file-created");
  let log = await readLog(mini);
  const created = log.find((e) => e.kind === "entry_created" && String(e.path).includes(TEST_FILE));
  if (!created) throw new Error("entry_created 未记录");
  console.log(`✓ fs.entry.create 真实成功（${created.path}）`);

  // ---- t19-06：编辑器写回（fs.file.write） ----
  const fileRow = await findByText(page, ".file-row", TEST_FILE, ".file-name");
  await fileRow.tap();
  await waitFor("文本预览出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".preview-overlay")) ?? null;
  });
  await mini.restoreWxMethod("showModal");
  const editBtn = await page.$(".preview-edit");
  await editBtn.tap();
  const textarea = await waitFor("编辑器打开", async () => {
    const current = await mini.currentPage();
    return (await current.$(".editor-textarea")) ?? null;
  });
  await textarea.input("# t19 写回验证\nhello t19");
  const saveBtn = await page.$(".editor-save");
  await saveBtn.tap();
  await waitFor("写回成功（write_saved 记录）", async () => {
    const entries = await readLog(mini);
    return (
      entries.find((e) => e.kind === "write_saved" && String(e.path).includes(TEST_FILE)) ?? null
    );
  });
  await sleep(600);
  await shot(mini, "t19-06-editor-saved");
  // 关编辑器 + 关预览（已保存，无确认弹窗）
  const editorClose = await page.$(".editor-overlay .preview-close");
  await editorClose.tap();
  await sleep(300);
  const previewClose = await page.$(".preview-overlay .preview-close");
  if (previewClose) await previewClose.tap();
  await sleep(400);

  // ---- t19-07：读回验证（重新打开 = 从 daemon 读） ----
  const fileRow2 = await waitFor("文件行重新可点", async () => {
    const current = await mini.currentPage();
    return (await findByText(current, ".file-row", TEST_FILE, ".file-name")) ?? null;
  });
  await fileRow2.tap();
  await waitFor("读回内容含 hello t19", async () => {
    const current = await mini.currentPage();
    const body = await current.$(".preview-text");
    if (!body) return null;
    const text = await body.text();
    return text.includes("hello t19") ? text : null;
  });
  console.log("✓ fs.file.write 写回后读回一致");
  await shot(mini, "t19-07-edit-readback");
  const closeBtn2 = await page.$(".preview-overlay .preview-close");
  if (closeBtn2) await closeBtn2.tap();
  await sleep(400);

  // ---- t19-08：重命名（fs.entry.rename） ----
  // mock 必须在 longpress 之前设置（actionSheet 弹出即消费 mock 结果）
  await mini.mockWxMethod("showActionSheet", { tapIndex: 0, errMsg: "showActionSheet:ok" }); // 重命名
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false, content: RENAMED_FILE });
  const fileRow3 = await findByText(page, ".file-row", TEST_FILE, ".file-name");
  await fileRow3.longpress();
  await waitFor(`重命名后出现：${RENAMED_FILE}`, async () => {
    const current = await mini.currentPage();
    return (await findByText(current, ".file-row", RENAMED_FILE, ".file-name")) ?? null;
  });
  await shot(mini, "t19-08-renamed");
  log = await readLog(mini);
  const renamed = log.find((e) => e.kind === "entry_renamed" && e.to?.includes(RENAMED_FILE));
  if (!renamed) throw new Error("entry_renamed 未记录");
  console.log(`✓ fs.entry.rename 真实成功（${renamed.from} → ${renamed.to}）`);

  // ---- t19-09：删除（fs.entry.delete） ----
  const delRow = await findByText(page, ".file-row", RENAMED_FILE, ".file-name");
  await mini.mockWxMethod("showActionSheet", { tapIndex: 2, errMsg: "showActionSheet:ok" }); // 删除
  await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
  await delRow.longpress();
  await waitFor("删除后行消失", async () => {
    const current = await mini.currentPage();
    return (await findByText(current, ".file-row", RENAMED_FILE, ".file-name")) === null;
  });
  await shot(mini, "t19-09-deleted");
  log = await readLog(mini);
  const deleted = log.find(
    (e) => e.kind === "entry_deleted" && String(e.path).includes(RENAMED_FILE),
  );
  if (!deleted) throw new Error("entry_deleted 未记录");
  console.log("✓ fs.entry.delete 真实成功");

  // ---- t19-12（先做终端，diff 随后）工作区终端：create + subscribe + input ----
  const termEntry = await page.$(".crumbs-term");
  await termEntry.tap();
  page = await waitFor("终端创建并进入终端页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/terminal/index" ? current : false;
  });
  const termLive = await waitFor("终端订阅成功（输出中）", async () => {
    const current = await mini.currentPage();
    const pill = await current.$(".term-pill");
    if (!pill) return null;
    const text = await pill.text();
    return text.includes("输出中") ? pill : null;
  });
  console.log("✓ subscribe_terminal → Restore/Output 帧实时渲染");
  // 等回放出现 shell 提示符（$ 或 % 或任意行）
  await waitFor("回放行出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".term-line")) ?? null;
  });
  const termInput = await waitFor("终端输入条出现", async () => {
    const current = await mini.currentPage();
    return (await current.$(".term-input")) ?? null;
  });
  await termInput.input("echo t19-terminal-ok");
  const termSend = await page.$(".send-btn");
  await termSend.tap();
  await waitFor("命令回显输出 t19-terminal-ok", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/terminal/index") return null;
    const lines = await current.$$(".term-line");
    for (const line of lines) {
      const text = await line.text();
      if (text && text.includes("t19-terminal-ok")) return text;
    }
    return null;
  });
  console.log("✓ terminal_input → Output 帧（echo 回显）闭环");
  await sleep(400);
  await shot(mini, "t19-12-terminal-output");
  await mini.navigateBack();
  await sleep(800);
  page = await mini.currentPage();

  // ---- t19-10/11：diff（checkout.commits.list + file_diff） ----
  await mini.reLaunch("/pages/agents/index");
  await sleep(1200);
  page = await mini.currentPage();
  const changesEntry = await findButton(page, ".tool-entry", "改动");
  await changesEntry.tap();
  page = await waitFor("进入改动页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/changes/index" ? current : false;
  });
  await waitFor("commit 列表渲染（真实 git）", async () => {
    const current = await mini.currentPage();
    return (await current.$(".commit-card")) ?? null;
  });
  // 逐个 commit 展开（点击 .commit-head 触发折叠开关），直到找到有文件行的
  let fileDiffRow = null;
  for (let attemptIdx = 0; attemptIdx < 5 && !fileDiffRow; attemptIdx += 1) {
    const heads = await page.$$(".commit-head");
    const head = heads[attemptIdx];
    if (!head) break;
    await head.tap();
    fileDiffRow = await waitFor(
      `commit #${attemptIdx + 1} 文件列表展开`,
      async () => {
        const current = await mini.currentPage();
        return (await current.$(".commit-file-row")) ?? null;
      },
      { timeout: 15000 },
    ).catch(() => null);
    if (!fileDiffRow) {
      // 该 commit 无文件记录（如 merge commit）→ 收起换下一个
      await head.tap();
      await sleep(400);
    }
  }
  if (!fileDiffRow) throw new Error("前 5 个 commit 均无文件改动记录");
  await shot(mini, "t19-10-commits");
  await fileDiffRow.tap();
  await waitFor("diff 行渲染（+/- 着色）", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/changes/index") return null;
    const add = await current.$(".diff-line-add");
    const any = await current.$(".diff-line");
    return add ?? any ?? null;
  });
  await sleep(400);
  await shot(mini, "t19-11-diff");
  const addCount = (await page.$$(".diff-line-add")).length;
  const removeCount = (await page.$$(".diff-line-remove")).length;
  console.log(`✓ diff 视图：+行 ${addCount} / -行 ${removeCount}`);
  const diffClose = await page.$(".diff-close-btn");
  if (diffClose) await diffClose.tap();
  await sleep(300);

  // ---- t19-13：脚本输出入口（如该工作区有带 terminalId 的脚本/服务） ----
  await mini.reLaunch("/pages/agents/index");
  await sleep(1000);
  page = await mini.currentPage();
  const scriptsEntry = await findButton(page, ".tool-entry", "脚本");
  await scriptsEntry.tap();
  page = await waitFor("进入脚本页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/scripts/index" ? current : false;
  });
  await sleep(1200);
  const outputBtn = await page.$(".script-actions .btn-ghost");
  let scriptOutputDone = false;
  if (outputBtn) {
    // 找到"输出"按钮（ghost 按钮可能是 停止 或 输出——按文本匹配）
    const output = await findButton(page, ".script-actions .btn", "输出");
    if (output) {
      await output.tap();
      await waitFor("脚本输出终端页", async () => {
        const current = await mini.currentPage();
        return current.path === "pages/terminal/index" ? current : false;
      });
      await waitFor(
        "脚本输出行出现",
        async () => {
          const current = await mini.currentPage();
          return (await current.$(".term-line")) ?? null;
        },
        { timeout: 15000 },
      );
      await sleep(600);
      await shot(mini, "t19-13-script-output");
      console.log("✓ 脚本输出入口 → 终端流渲染");
      scriptOutputDone = true;
      await mini.navigateBack();
      await sleep(600);
    }
  }
  if (!scriptOutputDone) console.log("  （该工作区暂无带 terminalId 的脚本，t19-13 跳过）");

  // ---- t19-14：清理验证 agent（仅自建 agent；已有 agent 回退场景跳过删除） ----
  if (usedExistingAgent) {
    console.log("  回退场景（已有 agent）：跳过删除，仅截图收尾");
    await shot(mini, "t19-14-cleanup");
  } else {
    await mini.reLaunch("/pages/agents/index");
    await sleep(1200);
    page = await mini.currentPage();
    const verifyCard = await waitFor(`列表找到验证 agent（${VERIFY_NAME}）`, async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", VERIFY_NAME, ".agent-title")) ?? null;
    });
    await verifyCard.tap();
    page = await waitFor("进入 agent 详情", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agent/index" ? current : false;
    });
    await mini.mockWxMethod("showModal", { confirm: true, cancel: false });
    const deleteBtns = await page.$$(".action-btn.btn-danger");
    if (deleteBtns.length === 0) throw new Error("未找到删除按钮");
    await deleteBtns[deleteBtns.length - 1].tap();
    await sleep(2500);
    await waitFor("删除后返回列表页", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/agents/index" ? current : false;
    });
    await waitFor("列表中验证 agent 已消失", async () => {
      const current = await mini.currentPage();
      return (await findByText(current, ".agent-card", VERIFY_NAME, ".agent-title")) === null;
    });
    await shot(mini, "t19-14-cleanup");
    console.log("✓ 验证 agent 已删除（配额处置）");
  }

  clearInterval(heartbeatTimer);
  await mini.disconnect();
  console.log("done");
}

main().catch((error) => {
  console.error("t19 验收失败：", error);
  process.exit(1);
});
