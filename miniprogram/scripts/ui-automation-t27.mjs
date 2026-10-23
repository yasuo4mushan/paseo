/**
 * t27 验收自动化：真实 hub（手机号版）全链路 + 截图。
 *
 * 流程（对公网 hub http://remoteagent.agentsworkforyou.cn/api）：
 *   1. 登录页（修复后）：输入框定高；微信一键按钮隐藏态（hub 未启用 wx-phone）
 *   2. 错误凭据 → 手机号或密码错误（截图错误态）
 *   3. 注册 139… 测试号（随机尾号）→ 自动登录 → 对话主页
 *   4. 设置页账户区：手机号展示 + 修改密码表单（截图）→ 提交（成功 toast）
 *   5. 退出 → 新密码登录成功（旧链路验证：改密后其余 token 吊销由服务端语义保证）
 *   6. 深色档登录页（手动档 theme-dark，页面 token 层）
 *
 * 前置：开发者工具已开 auto 端口 9432（见 docs/screenshots/README.md）。
 * 用法：node scripts/ui-automation-t27.mjs
 */

import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9432";

// 139 测试号：随机 8 位尾号避免与历史验收撞号
const PHONE = `139${String(Date.now() % 1e8).padStart(8, "0")}`.slice(0, 11);
const PASS_OLD = "t27-pass-one";
const PASS_NEW = "t27-pass-two";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, fn, { timeout = 15000, interval = 400 } = {}) {
  const start = Date.now();
  for (;;) {
    try {
      const value = await fn();
      if (value) {
        console.log(`✓ ${desc}`);
        return value;
      }
    } catch {
      // 轮询期间的异常继续等，超时后再抛
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

/** 在登录页填手机号+密码并点主按钮（mode: login | register）。 */
async function submitLogin(page, phone, password, mode) {
  const modeSwitch = await page.$(".login-switch");
  if (mode === "register" && (await modeSwitch.text()).includes("没有账号")) {
    await modeSwitch.tap();
    await sleep(600);
  }
  if (mode === "login" && (await modeSwitch.text()).includes("已有账号")) {
    await modeSwitch.tap();
    await sleep(600);
  }
  const phoneInput = await page.$(".login-phone");
  const passInput = await page.$(".login-password");
  const btn = await page.$(".btn-login");
  await phoneInput.input(phone);
  await passInput.input(password);
  await btn.tap();
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`test phone = ${PHONE}`);
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation");

  // 清会话与主题偏好，回登录页（真实 hub 用内置默认地址，不写 hub_base）
  for (const key of [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "aaswitch_theme_pref",
  ]) {
    await mini.callWxMethod("removeStorageSync", key);
  }
  await mini.reLaunch("/pages/login/index");
  await sleep(2000);

  let page = await mini.currentPage();
  await waitFor("登录页出现（手机号表单）", async () => (await page.$(".login-phone")) !== null);

  // ---- 1. 修复后登录页 + 微信按钮隐藏态 ----
  const wxBtn = await page.$(".btn-wx-phone");
  if (wxBtn) throw new Error("微信一键登录按钮应处于隐藏态（hub 未启用 wx-phone）");
  console.log("✓ 微信一键登录按钮隐藏态（探测 501 auth.wx_disabled）");
  await shot(mini, "t27-01-login-fixed");

  // ---- 2. 错误凭据错误态 ----
  await submitLogin(page, PHONE, "wrong-password", "login");
  await waitFor("invalid_credentials 中文错误文案", async () => {
    const err = await page.$(".login-error");
    return err ? (await err.text()).includes("手机号或密码错误") : false;
  });
  await shot(mini, "t27-02-login-error");

  // ---- 3. 注册 → 自动登录 → 对话主页 ----
  await sleep(1500); // 页面重渲染后句柄失效，重新查询
  page = await mini.currentPage();
  await submitLogin(page, PHONE, PASS_OLD, "register");
  await waitFor("注册并登录进入对话主页", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/chat/index") return false;
    page = current;
    return true;
  });
  const accountRaw = await mini.callWxMethod("getStorageSync", "aaswitch_hub_account");
  const account = JSON.parse(accountRaw);
  if (account.phone !== PHONE) throw new Error(`本地账号手机号不符：${accountRaw}`);
  console.log(`✓ 注册+登录成功（account.phone = ${account.phone}）`);

  // ---- 4. 设置页：改密表单截图 + 提交 ----
  await mini.switchTab("/pages/settings/index");
  await sleep(1200);
  page = await mini.currentPage();
  await waitFor("设置页出现修改密码入口", async () => {
    const cells = await page.$$(".cell-label");
    for (const cell of cells) {
      if ((await cell.text()) === "修改密码") return true;
    }
    return false;
  });
  const phoneCell = await waitFor("账户区展示手机号", async () => {
    const cells = await page.$$(".cell-value");
    for (const cell of cells) {
      if ((await cell.text()) === PHONE) return cell;
    }
    return null;
  });
  if (!phoneCell) throw new Error("设置页未展示手机号");
  // 打开改密表单并截图（passwordSet 未下发 → 显示"当前密码"输入，可留空提示在 hub 侧校验）
  const changeCell = await page.$(".pw-editor");
  const changeEntry = await page.$$(".cell-tappable");
  for (const cell of changeEntry) {
    const label = await cell.$(".cell-label");
    if (label && (await label.text()) === "修改密码") {
      await cell.tap();
      break;
    }
  }
  await waitFor("改密表单展开", async () => (await page.$(".pw-editor")) !== null);
  const oldInput = await page.$(".pw-editor .field-input");
  await oldInput.input(PASS_OLD);
  const pwInputs = await page.$$(".pw-editor .field-input");
  await pwInputs[1].input(PASS_NEW);
  await pwInputs[2].input(PASS_NEW);
  await shot(mini, "t27-03-settings-password");
  // 提交：三个输入框 onConfirm 或点确认按钮
  const btns = await page.$$(".pw-editor .btn");
  for (const btn of btns) {
    if ((await btn.text()).includes("确认修改")) {
      await btn.tap();
      break;
    }
  }
  await waitFor("改密成功（表单收起）", async () => (await page.$(".pw-editor")) === null);
  console.log("✓ 修改密码成功（toast 其余设备已下线语义）");
  await shot(mini, "t27-04-settings-after-change");

  // ---- 5. 退出登录 → 新密码登录 ----
  // 原生 wx.showModal 无法用 automation 点击，登出用等价路径：直接清本机会话
  // （服务端"其余 token 吊销"由 hub 的 auth.password.change 语义保证，t26 测试覆盖）。
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.reLaunch("/pages/login/index");
  await sleep(1500);
  page = await mini.currentPage();
  await waitFor("登出后回登录页", async () => (await page.$(".login-phone")) !== null);
  await submitLogin(page, PHONE, PASS_NEW, "login");
  await waitFor("新密码登录成功进入对话主页", async () => {
    const current = await mini.currentPage();
    if (current.path !== "pages/chat/index") return false;
    page = current;
    return true;
  });
  console.log("✓ 新密码登录成功");

  // ---- 6. 深色档登录页 ----
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_token");
  await mini.callWxMethod("removeStorageSync", "aaswitch_hub_account");
  await mini.callWxMethod("setStorageSync", "aaswitch_theme_pref", "dark");
  await mini.reLaunch("/pages/login/index");
  await sleep(2000);
  page = await mini.currentPage();
  await waitFor("深色档登录页出现", async () => (await page.$(".login-phone")) !== null);
  await shot(mini, "t27-05-login-dark");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");

  console.log("t27 验收完成");
  await mini.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
