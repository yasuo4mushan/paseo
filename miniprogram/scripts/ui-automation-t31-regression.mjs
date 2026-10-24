/**
 * t31 逐框架全链路回归：codex / zcode / kimi / codebuddy-code / qoder / qwen-code。
 *
 * 每个框架走完整用户链路（对 6799 生产 daemon，relay 只读连接 + 真实创建）：
 *   设置 → 新建项目会话向导 → folder-picker 选真实目录 → 框架 → 模型（记录目录或
 *   错误态）→ thinking 档位 → 填 prompt「只回复 ok」→ 创建并进入会话 → 等真实
 *   回复终态 → 截图。CLI 未登录的框架预期在目录步/回复步暴露认证错误，如实记录。
 *
 * 前置：cli auto --project <miniprogram> --auto-port 9420；6799 在线。
 * 产物：docs/screenshots/t31r-<provider>-*.png + 控制台汇总表。
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9420";
const HUB_BASE = "http://remoteagent.agentsworkforyou.cn/api";
const DEVICE_NAME = "t31r-mac-dev";
const RELAY_URI =
  "relay://remoteagent.agentsworkforyou.cn:80/srv_7aUzzpHz-TlI?key=C9D%2F2a3pHSuPXfCN9YCr9tvwOLcKckBQg09WqiMaBXk%3D";

const PROBE_USER = `t31rprobe-${Date.now().toString(36)}`;
const PROBE_PASS = "t31rprobe-pass-1";
const PROBE_PHONE = `17326${Date.now().toString().slice(-6)}`;

const PROVIDERS = [
  { id: "codex", labels: ["codex"] },
  { id: "zcode", labels: ["zcode"] },
  { id: "kimi", labels: ["kimi"] },
  { id: "codebuddy-code", labels: ["codebuddy-code", "codebuddy"] },
  { id: "qoder", labels: ["qoder"] },
  { id: "qwen-code", labels: ["qwen-code", "qwen"] },
];

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
    } catch {}
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

async function pickerTrail(page) {
  const crumbs = await page.$$(".fp-crumb");
  const segments = [];
  for (const crumb of crumbs) segments.push(((await crumb.text()) ?? "").trim());
  return segments.slice(1);
}

async function pickExistingFolder(page) {
  await waitFor("folder-picker 面板渲染", async () => (await page.$(".fp-panel")) ?? null);
  const row = await waitFor("目录项 Documents（真实存在）", async () =>
    (await findByText(page, ".fp-row", "Documents", ".fp-row-name")) ?? null,
  );
  await row.tap();
  await waitFor("进入 Documents", async () => {
    const trail = await pickerTrail(page);
    return trail[trail.length - 1] === "Documents" ? trail : null;
  });
  await (await page.$(".fp-confirm")).tap();
}

const results = [];

async function runProvider(mini, provider) {
  const entry = { provider: provider.id, model: null, thinking: null, agentId: null, reply: null, error: null };
  results.push(entry);
  console.log(`\n===== ${provider.id} =====`);

  try {
    // 进向导
    await mini.reLaunch("/pages/settings/index");
    await sleep(1200);
    let page = await mini.currentPage();
    const createCell = await waitFor("设置页新建项目会话入口", async () =>
      (await findByText(page, ".cell", "新建项目会话")) ?? null,
    );
    await createCell.tap();
    page = await waitFor("进入创建向导", async () => {
      const current = await mini.currentPage();
      return current.path === "pages/create/index" ? current : false;
    });

    await pickExistingFolder(page);

    // 框架
    await waitFor("第③步框架 chips 渲染", async () => {
      const chips = await page.$$(".chip");
      return chips.length ? chips : null;
    });
    let chip = null;
    for (const label of provider.labels) {
      chip = (await findByText(page, ".chip", label)) ?? null;
      if (chip) break;
    }
    if (!chip) {
      const all = [];
      for (const c of await page.$$(".chip")) all.push((await c.text()) ?? "");
      throw new Error(`框架 chips 中未找到 ${provider.id}（现有：${all.join(",")}）`);
    }
    await chip.tap();
    console.log(`ok 框架选中：${provider.id}`);

    // 模型步：加载完成（成功=picker-value；失败=field-error）
    await waitFor(
      "模型目录加载完成（非 loading）",
      async () => {
        const loading = await page.$(".loading-tip");
        if (loading) return null;
        return (await page.$(".picker-value")) ?? (await page.$(".field-error")) ?? null;
      },
      { timeout: 90000, interval: 1000 },
    );
    const errEl = await page.$(".field-error");
    if (errEl) {
      entry.model = `拉取失败：${(await errEl.text()) ?? ""}`.slice(0, 90);
      throw new Error(entry.model);
    }
    entry.model = (await (await page.$(".picker-value"))?.text()) ?? "";
    console.log(`ok 模型预选：${entry.model}`);
    await shot(mini, `t31r-${provider.id}-model`);

    // thinking 步
    await (await page.$(".wiz-nav-main")).tap();
    await waitFor("第⑤步 prompt 输入出现", async () => (await page.$(".prompt-input")) ?? null);
    const thinkChips = await page.$$(".chip");
    entry.thinking = thinkChips.length;
    const low =
      (await findByText(page, ".chip", "low")) ??
      (await findByText(page, ".chip", "低")) ??
      (await findByText(page, ".chip", "off"));
    if (low) await low.tap();
    console.log(`ok thinking 档位数：${thinkChips.length}`);

    // prompt + 提交
    const promptArea = await page.$(".prompt-input");
    await promptArea.input("只回复 ok");
    await sleep(300);
    const submitBtn = await waitFor("提交按钮「创建并进入会话」", async () =>
      (await findByText(page, ".btn", "创建并进入会话")) ?? null,
    );
    await submitBtn.tap();
    page = await waitFor(
      "redirectTo agent 详情页",
      async () => {
        const current = await mini.currentPage();
        return current.path === "pages/agent/index" ? current : false;
      },
      { timeout: 45000 },
    );
    entry.agentId = page.query?.id ?? "";
    console.log(`ok agent 已创建：${entry.agentId}`);

    // 回复终态
    await waitFor(
      "时间线首条渲染",
      async () => {
        const items = await page.$$(".timeline-item");
        return items.length >= 1 ? items : null;
      },
      { timeout: 60000 },
    );
    const failRe =
      /403|not allowed|authenticate|api error|unauthorized|not logged in|exit code|system error|失败|错误|无法|timeout|timed out/i;
    const okRe = /\bok\b/i;
    try {
      const outcome = await waitFor(
        "agent 回复终态",
        async () => {
          const bubbles = await page.$$(".bubble-text");
          for (const bubble of bubbles) {
            const text = (await bubble.text()) ?? "";
            if (failRe.test(text)) return { ok: false, text };
            if (okRe.test(text) && !text.includes("只回复")) return { ok: true, text };
          }
          return null;
        },
        { timeout: 150000, interval: 1500 },
      );
      entry.reply = outcome.ok ? `✅ ${outcome.text.slice(0, 40)}` : `❌ ${outcome.text.slice(0, 60)}`;
    } catch {
      const dump = [];
      for (const bubble of await page.$$(".bubble-text")) {
        dump.push(((await bubble.text()) ?? "").slice(0, 60));
      }
      entry.reply = `⏱ 150s 无终态；时间线：${JSON.stringify(dump).slice(0, 120)}`;
    }
    console.log(`ok 回复终态：${entry.reply}`);
    await shot(mini, `t31r-${provider.id}-reply`);
  } catch (e) {
    entry.error = String(e.message).slice(0, 120);
    console.log(`!! ${provider.id} 失败：${entry.error}`);
    await shot(mini, `t31r-${provider.id}-fail`).catch(() => {});
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });

  // hub 探针账号 + relay 设备（指向 6799）
  const reg = await fetch(`${HUB_BASE}/auth.register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: PROBE_USER, password: PROBE_PASS, phone: PROBE_PHONE }),
  }).then((r) => r.json());
  if (!reg.ok) throw new Error(`注册失败：${JSON.stringify(reg)}`);
  const login = await fetch(`${HUB_BASE}/auth.login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone: PROBE_PHONE, password: PROBE_PASS }),
  }).then((r) => r.json());
  if (!login.ok) throw new Error(`登录失败：${JSON.stringify(login)}`);
  const token = login.data.token;
  const callApi = hubCall(token);
  const offer = parseRelayUri(RELAY_URI);
  const deviceReg = await callApi("devices.register", { name: DEVICE_NAME, os: "macos", offer });
  if (!deviceReg.ok) throw new Error(`设备注册失败：${JSON.stringify(deviceReg)}`);
  const deviceId = deviceReg.data.deviceId;
  const heartbeatTimer = setInterval(() => {
    void callApi("devices.heartbeat", { deviceId }).catch(() => {});
  }, 15000);
  console.log(`ok 探针设备：${deviceId}`);

  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected (9420)");

  for (const key of [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "paseo_mp_workspace",
    "paseo_mp_connection",
    "paseo_mp_last_agent",
  ]) {
    await mini.callWxMethod("removeStorageSync", key);
  }
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_token", token);
  await mini.callWxMethod(
    "setStorageSync",
    "aaswitch_hub_account",
    JSON.stringify(login.data.account),
  );
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);

  await mini.switchTab("/pages/devices/index");
  await sleep(2000);
  let page = await mini.currentPage();
  const onlineCard = await waitFor("在线设备卡片", async () =>
    (await page.$(".device-online")) ?? null,
  );
  await onlineCard.tap();
  await waitFor(
    "relay 连接成功",
    async () => {
      const current = await mini.currentPage();
      return current.path === "pages/chat/index" ? current : false;
    },
    { timeout: 35000 },
  );
  await sleep(1000);

  for (const provider of PROVIDERS) {
    await runProvider(mini, provider);
  }

  await mini
    .evaluate(() => {
      getApp().__automation?.disconnect?.();
      getApp().__automation?.sessionStore?.reset?.();
    })
    .catch(() => {});
  await mini.disconnect();
  clearInterval(heartbeatTimer);
  const unregister = await callApi("devices.unregister", { deviceId });
  console.log(`ok 设备清理：${unregister.ok ? "unregistered" : "failed"}`);

  console.log("\n========== 汇总 ==========");
  for (const r of results) {
    console.log(
      `${r.provider.padEnd(16)} model=${(r.model ?? "-").slice(0, 30).padEnd(32)} think=${String(
        r.thinking ?? "-",
      ).padEnd(3)} agent=${(r.agentId ?? "-").slice(0, 14).padEnd(15)} reply=${r.reply ?? r.error ?? "-"}`,
    );
  }
}

main().catch((err) => {
  console.error("回归失败：", err);
  process.exitCode = 1;
});
