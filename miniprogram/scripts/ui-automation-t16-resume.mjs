/**
 * t16 验收续跑：删除刚才创建的真实 agent + 权限弹层截图。
 * （首次运行被管道截断；本脚本不创建新 agent，遵循配额纪律。）
 */
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const automator = require("miniprogram-automator");

const here = dirname(fileURLToPath(import.meta.url));
const SHOT_DIR = resolve(here, "../docs/screenshots");
const WS = "ws://127.0.0.1:9422";

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
    } catch {}
    if (Date.now() - start > timeout) throw new Error(`等待超时：${desc}`);
    await sleep(interval);
  }
}

async function shot(mini, name) {
  await mini.screenshot({ path: resolve(SHOT_DIR, `${name}.png`) });
  console.log(`📸 ${name}.png`);
}

async function main() {
  mkdirSync(SHOT_DIR, { recursive: true });
  const mini = await automator.connect({ wsEndpoint: WS });
  let page = await mini.currentPage();
  console.log("current page:", page.path);

  // 若不在详情页（首次运行已完成删除则跳过）
  if (page.path === "pages/agent/index") {
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
  } else if (page.path !== "pages/agents/index") {
    await mini.reLaunch("/pages/agents/index");
    await sleep(2000);
    page = await mini.currentPage();
  }

  // 权限弹层（工具授权）
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
  await waitFor("权限弹层出现（工具授权）", async () => (await page.$(".perm-sheet")) ?? null);
  await shot(mini, "t16-08-permission-tool");
  await mini.evaluate(() => {
    getApp().__automation.permissionStore.clearAll();
  });
  await sleep(600);

  // 权限弹层（计划确认，多档动作）
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
  await waitFor("权限弹层出现（计划确认）", async () => (await page.$(".perm-sheet")) ?? null);
  await shot(mini, "t16-09-permission-plan");
  await mini.evaluate(() => {
    getApp().__automation.permissionStore.clearAll();
  });

  // 深色模式：切系统外观后回列表截图（darkmode tokens 双轨验证）
  const { execSync } = await import("node:child_process");
  try {
    execSync(
      `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'`,
    );
    await sleep(4000);
    await mini.reLaunch("/pages/agents/index");
    await sleep(3000);
    page = await mini.currentPage();
    await waitFor("深色模式列表页就绪", async () => (await page.$(".ws-bar")) !== null);
    // 深色下再弹一次权限弹层，验证弹层 tokens 双轨
    await mini.evaluate((push) => {
      getApp().__automation.permissionStore.handlePush(push);
    }, {
      agentId: "demo-agent-0003",
      request: {
        id: "perm-demo-dark",
        provider: "claude",
        name: "Bash",
        kind: "tool",
        input: { command: "npm run build" },
      },
    });
    await waitFor("深色权限弹层出现", async () => (await page.$(".perm-sheet")) ?? null);
    await shot(mini, "t16-10-permission-dark");
    await mini.evaluate(() => {
      getApp().__automation.permissionStore.clearAll();
    });
  } finally {
    execSync(
      `osascript -e 'tell application "System Events" to tell appearance preferences to set dark mode to not dark mode'`,
    );
  }

  await mini.disconnect();
  console.log("done");
}

main().catch((err) => {
  console.error("t16 resume failed:", err);
  process.exit(1);
});
