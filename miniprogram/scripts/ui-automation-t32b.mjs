/**
 * t32b UI 自动化验收：对话输入框按住说话（豆包式听写浮层）。
 *
 * 隔离环境（不碰 6767/6799；模型/管线见 tests/integration-dictation.test.ts 头注释）：
 *   - mock hub：MOCK_STATIC_DEVICES=0 node scripts/mock-hub.mjs 6786
 *   - 隔离 daemon：PASEO_HOME=/tmp/t32b-home PASEO_LISTEN=127.0.0.1:6787
 *     PASEO_HUB_URL=http://127.0.0.1:6786/api PASEO_HUB_TOKEN=mock-token-1
 *     PASEO_RELAY_ENABLED=true PASEO_RELAY_(PUBLIC_)ENDPOINT=remoteagent.agentsworkforyou.cn:80
 *     （模拟器屏蔽 ws://127.0.0.1 回环，走公网 relay 是既有 workaround）
 *
 * 前置：开发者工具 auto 端口已开（9422）：
 *   <cli> auto --project <worktree>/miniprogram --auto-port 9422
 *   （每次全量运行前重启开发者工具——模拟器长时间运行后 automator RPC 明显
 *   退化；脚本内已对 relay 丢包导致的 store 中断做自愈重试）
 *
 * 验收面（模拟器无声卡，录音路径经 app.ts __automation.dictation 桥驱动状态机；
 * 真实 PCM→final 全链路由 vitest 集成测试覆盖，两层互补）：
 *   1. 真实 touch 接线：automator 派发 touchstart/touchend 到麦克风按钮，
 *     __automation.dictation.snapshot() 观察到 recording → idle 状态机往返。
 *   2. 浮层状态：正在聆听… → partial 上屏 → 上滑取消（红态）→ 松手不落字。
 *   3. final 插入：注入 final 文本 → 松手 → composer 草稿追加（不覆盖）。
 *   4. 权限拒绝：麦克风按钮置灰态。
 *   5. 上述明暗双主题截图。
 *
 * 用法：HUB_BASE=http://<LAN-IP>:6786/api node scripts/ui-automation-t32b.mjs
 *
 * 产物（docs/screenshots/t32b-*.png）：
 *   01 idle（明）  02 录音浮层-正在聆听（明）  03 录音浮层-partial（明）
 *   04 上滑取消（明）  05 权限拒绝置灰（明）
 *   06 idle（暗）  07 录音浮层-partial（暗）  08 上滑取消（暗）
 */

import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9422";

function lanIp() {
  for (const list of Object.values(networkInterfaces())) {
    for (const net of list ?? []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return "127.0.0.1";
}
const HUB_BASE = process.env.HUB_BASE ?? `http://${lanIp()}:6786/api`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const step = (msg) => console.log(`-- ${msg}`);

// 浮层常驻 CSS 动画会拖慢模拟器渲染线程，automator 单次 RPC 偶发接近 30s
// 超时——轮询放宽到 1s 间隔 / 60s 预算，避免把偶发慢响应当成断言失败。
async function waitFor(desc, fn, { timeout = 60000, interval = 1000 } = {}) {
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

/**
 * __automation.dictation 桥（app.ts 注入）。
 * 注意：evaluate 的返回值要可序列化（函数不能跨边界），因此这里不取桥对象，
 * 每个方法经 evaluate 闭包在 appservice 内执行并回传小结果。
 */
async function dictationBridge(mini) {
  const call = (fn, ...args) => mini.evaluate(fn, ...args);
  return {
    begin: () => call(() => getApp().__automation.dictation.begin()),
    slideUp: (active) => call((a) => getApp().__automation.dictation.slideUp(a), active),
    release: () => call(() => getApp().__automation.dictation.release()),
    injectPartial: (text) => call((t) => getApp().__automation.dictation.injectPartial(t), text),
    injectFinal: (text) => call((t) => getApp().__automation.dictation.injectFinal(t), text),
    setPermissionDenied: (v) =>
      call((x) => getApp().__automation.dictation.setPermissionDenied(x), v),
    installSilentAudio: () => call(() => getApp().__automation.dictation.installSilentAudio()),
    snapshot: () =>
      call(() => {
        const snap = getApp().__automation.dictation.snapshot();
        return {
          phase: String(snap.phase),
          partialText: String(snap.partialText ?? ""),
          slideUp: Boolean(snap.slideUp),
        };
      }),
  };
}

async function snapshotPhase(bridge) {
  return (await bridge.snapshot()).phase;
}

/**
 * 浮层态等待（自愈）：公网 relay 偶发掉线会把 dictation-store abort 回 idle
 * （正确生产行为），自动化里表现为浮层消失。轮询中发现 idle 就重新 begin +
 * 重放注入（prepare），再继续等目标条件，避免把断线当成断言失败。
 */
async function overlayWait(
  bridge,
  desc,
  prepare,
  check,
  { timeout = 60000, interval = 1000 } = {},
) {
  const started = Date.now();
  for (;;) {
    try {
      const snap = await bridge.snapshot();
      if (snap.phase === "idle") {
        await bridge.begin();
        if (prepare) await prepare();
      } else if (await check()) {
        console.log(`ok ${desc}`);
        return;
      }
    } catch {
      // 轮询期间异常继续等
    }
    if (Date.now() - started > timeout) throw new Error(`等待超时：${desc}`);
    await sleep(interval);
  }
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  console.log(`hub base = ${HUB_BASE}`);
  const mini = await automator.connect({ wsEndpoint: WS });
  console.log("connected to devtools automation (port 9422)");
  // 首个 automator 调用在 IDE 冷编译期偶发 30s 无响应（实测 systemInfo 探活可跨过）
  await mini.systemInfo();
  const bridge = await dictationBridge(mini);

  // ---- 冷启动：清态 → mock hub 登录 → 自动连接隔离 daemon ----
  step("冷启动清态 + 登录");
  for (const key of [
    "aaswitch_hub_token",
    "aaswitch_hub_account",
    "aaswitch_hub_base",
    "aaswitch_theme_pref",
    "paseo_mp_workspace",
    "paseo_mp_connection",
    "paseo_mp_last_agent",
  ]) {
    await mini.callWxMethod("removeStorageSync", key);
  }
  await mini.callWxMethod("setStorageSync", "aaswitch_hub_base", HUB_BASE);
  await mini.reLaunch("/pages/chat/index");
  await sleep(1500);
  await waitFor("未登录守卫跳登录页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/login/index" ? current : false;
  });
  let page = await mini.currentPage();
  await (await page.$(".login-phone")).input("13800138000");
  await (await page.$(".login-password")).input("demo12345");
  await page.$(".btn-login").then((btn) => btn.tap());
  page = await waitFor("登录成功落对话主页", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });

  step("自动连接隔离 daemon");
  await waitFor(
    "连接就绪（顶栏设备名出现）",
    async () => {
      const label = await page.$(".chat-device-label");
      return label ? ((await label.text()) ?? "").length > 0 : false;
    },
    { timeout: 45000 },
  );

  // ---- 1. idle：麦克风按钮常驻（明） ----
  step("idle 麦克风按钮");
  const micBtn = await waitFor(
    "composer 麦克风按钮",
    async () => (await page.$(".mic-btn")) ?? null,
  );
  await sleep(400);
  await shot(mini, "t32b-01-idle-light");

  // ---- 2. 真实 touch 接线（touchstart/touchend 派发到按钮；静音音频源避免声卡依赖） ----
  step("真实 touch 接线：按下→浮层→松手→回落");
  await bridge.installSilentAudio();
  // 公网 relay 偶发丢包会让 start RPC 失败 → store abort 回 idle（正确行为）；
  // 自动化按「用户再按一次」重试整步（最多 3 次）。
  let touchStepDone = false;
  for (let attempt = 1; attempt <= 3 && !touchStepDone; attempt += 1) {
    console.log(`-- touch 接线第 ${attempt} 次尝试`);
    // 等上一轮残留状态清空
    await waitFor("touch 前 idle", async () => (await snapshotPhase(bridge)) === "idle", {
      timeout: 20000,
    }).catch(() => {});
    // 元素句柄跨渲染会失效（连接就绪后的 re-render），touch 前重新取
    const micFresh = (await page.$(".mic-btn")) ?? micBtn;
    await micFresh.touchstart({ touches: [{ identifier: 1, clientX: 300, clientY: 600 }] });
    const recording = await waitFor(
      "touchstart 后进入 recording",
      async () => (await snapshotPhase(bridge)) === "recording",
      { timeout: 15000 },
    )
      .then(() => true)
      .catch(() => false);
    if (!recording) continue;
    const overlay = await waitFor("浮层出现（正在聆听…）", async () => {
      const text = await page.$(".dictation-text-inner");
      return text ? ((await text.text()) ?? "").includes("正在聆听") : false;
    })
      .then(() => true)
      .catch(() => false);
    if (!overlay) continue;
    await shot(mini, "t32b-02-overlay-listening-light");
    await ((await page.$(".mic-btn")) ?? micFresh).touchend({
      changedTouches: [{ identifier: 1, clientX: 300, clientY: 600 }],
    });
    await waitFor(
      "touchend 后状态机回落 idle",
      async () => (await snapshotPhase(bridge)) === "idle",
      { timeout: 20000 },
    );
    touchStepDone = true;
  }
  if (!touchStepDone) throw new Error("真实 touch 接线三次尝试均失败");
  // 静音路径收尾为空文本 → 「未识别到内容」toast，等它消隐再进后续截图
  await sleep(1800);

  // ---- 3. partial 上屏 + 上滑取消（桥驱动状态机；模拟器无声卡） ----
  step("partial 上屏");
  await bridge.begin();
  await waitFor("桥驱动进入 recording", async () => (await snapshotPhase(bridge)) === "recording");
  const injectPartialText = () => bridge.injectPartial("hello, please create a new branch");
  await injectPartialText();
  await overlayWait(bridge, "partial 文本上屏", injectPartialText, async () => {
    const text = await page.$(".dictation-text-inner");
    return text ? ((await text.text()) ?? "").includes("create a new branch") : false;
  });
  await sleep(400);
  await shot(mini, "t32b-03-overlay-partial-light");

  step("上滑取消（红态）");
  const enterCancelState = async () => {
    await injectPartialText();
    await bridge.slideUp(true);
  };
  await overlayWait(bridge, "浮层进入取消态（松开取消）", enterCancelState, async () => {
    const hint = await page.$(".dictation-hint");
    return hint ? ((await hint.text()) ?? "").includes("松开取消") : false;
  });
  await overlayWait(bridge, "麦克风圈转取消红底", enterCancelState, async () => {
    const snap = await bridge.snapshot();
    return snap.slideUp && (await page.$(".dictation-mic-cancel")) !== null;
  });
  await sleep(300);
  await shot(mini, "t32b-04-slideup-cancel-light");
  await bridge.release();
  await waitFor("取消后回落 idle", async () => (await snapshotPhase(bridge)) === "idle");
  // 取消不落字：草稿仍为空
  const inputAfterCancel = await (await page.$(".composer-input")).property("value");
  if (inputAfterCancel) throw new Error(`取消路径不应落字，但草稿=${inputAfterCancel}`);

  // ---- 4. final 插入：追加不覆盖 ----
  step("final 插入 composer（追加不覆盖）");
  const input = await page.$(".composer-input");
  await input.input("已有草稿：");
  await bridge.begin();
  await waitFor("再次进入 recording", async () => (await snapshotPhase(bridge)) === "recording");
  await bridge.injectPartial("checking out");
  await bridge.injectFinal(" and check the diff");
  await bridge.release();
  await waitFor(
    "final 插入完成（状态机 idle）",
    async () => (await snapshotPhase(bridge)) === "idle",
  );
  // complete() 会对 final 文本做 trim（首空格丢弃），追加结果 = 已有草稿：and check the diff
  await waitFor(
    "草稿为追加结果",
    async () => {
      const value = await (await page.$(".composer-input")).property("value");
      return value === "已有草稿：and check the diff" ? value : false;
    },
    { timeout: 10000 },
  );
  console.log("ok 草稿追加 = 已有草稿：and check the diff");

  // ---- 5. 权限拒绝置灰（明） ----
  step("权限拒绝置灰");
  await bridge.setPermissionDenied(true);
  await waitFor("麦克风按钮置灰类", async () => (await page.$(".mic-btn-denied")) !== null);
  await sleep(300);
  await shot(mini, "t32b-05-permission-denied-light");
  await bridge.setPermissionDenied(false);

  // ---- 6-8. 暗色档 ----
  step("暗色档（idle / partial / 取消）");
  await mini.callWxMethod("setStorageSync", "aaswitch_theme_pref", "dark");
  await mini.reLaunch("/pages/chat/index");
  await sleep(1200);
  page = await waitFor("回到对话主页（暗）", async () => {
    const current = await mini.currentPage();
    return current.path === "pages/chat/index" ? current : false;
  });
  await waitFor("暗色 idle 麦克风按钮", async () => (await page.$(".mic-btn")) !== null);
  await sleep(600);
  await shot(mini, "t32b-06-idle-dark");
  await bridge.begin();
  const injectPartialDark = () => bridge.injectPartial("hello, please create a new branch");
  await injectPartialDark();
  await overlayWait(bridge, "暗色 partial 上屏", injectPartialDark, async () => {
    const text = await page.$(".dictation-text-inner");
    return text ? ((await text.text()) ?? "").includes("create a new branch") : false;
  });
  await sleep(400);
  await shot(mini, "t32b-07-overlay-partial-dark");
  const enterCancelDark = async () => {
    await injectPartialDark();
    await bridge.slideUp(true);
  };
  // 取消态自愈：idle → 重 begin；slideUp 掉了 → 重放；最后等红底类
  {
    const started = Date.now();
    for (;;) {
      const snap = await bridge.snapshot().catch(() => null);
      if (!snap) {
        // RPC 抖动继续轮询
      } else if (snap.phase === "idle") {
        await bridge.begin();
        await enterCancelDark();
      } else if (!snap.slideUp) {
        await enterCancelDark();
      } else if ((await page.$(".dictation-mic-cancel").catch(() => null)) !== null) {
        console.log("ok 暗色取消态");
        break;
      }
      if (Date.now() - started > 60000) {
        console.log("diag 暗色取消态超时:", JSON.stringify(snap));
        throw new Error("等待超时：暗色取消态");
      }
      await sleep(1000);
    }
  }
  await sleep(300);
  await shot(mini, "t32b-08-slideup-cancel-dark");
  await bridge.release();
  await waitFor("暗色取消回落 idle", async () => (await snapshotPhase(bridge)) === "idle");

  // ---- 收尾：清态（devtools 实例常驻，避免污染下一次运行） ----
  step("收尾清态");
  await mini.callWxMethod("removeStorageSync", "aaswitch_theme_pref");
  await mini.evaluate(() => {
    getApp().__automation.disconnect();
    return true;
  });
  console.log("done: t32b UI 自动化全部通过");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
