/**
 * 安全导航（t20，修 navigateTo:fail timeout）：
 *
 * 根因（真机/工具均复现过）：
 *  1. 微信同一时刻只允许一个页面切换在途；连点或异步续体里并发第二发
 *     navigateTo/switchTab，后到者报 navigateTo:fail timeout（前一发的转场
 *     未结束，Promise 永不 settle）。设备页"连接设备"是 await 完网络握手后
 *     再 navigateTo，恰与用户手速/其他转场撞车的高发位。
 *  2. 页面栈上限 10 层：从对话主页经抽屉/详情/文件/diff 层层 navigateTo，
 *     深栈后再 navigateTo 直接 fail（错误文案随基础库版本不同，timeout 是其一）。
 *
 * 修复：
 *  - 串行化：模块级导航队列，一次只放行一个导航，完成（或 2s 兜底）后放行下一个；
 *    重复目标直接吞掉（连点等效一次）。
 *  - 栈保护：navigateTo 前查 getCurrentPages().length，>=9 时降级 redirectTo
 *    （替换栈顶不加深）。
 *  - 主路径改 tab：设备页连上设备 switchTab 到对话主页（t20 三 tab），
 *    switchTab 不入栈，从结构上消除该高发位的 navigateTo。
 *
 * 回归复现步骤（自动化脚本 scripts/ui-automation-t20.mjs 内置）：
 *  连点设备卡片两次（连接成功后两发导航并发）→ 断言最终落在 pages/chat/index
 *  且期间无 navigateTo:fail；再从 chat 层层下钻 6 页后继续 navigateTo →
 *  断言 redirectTo 降级生效、页面栈不超 10。
 */

import Taro from "@tarojs/taro";

/** 微信页面栈上限。 */
const PAGE_STACK_LIMIT = 10;
/** 单个导航的最长占用（转场完成的兜底；微信转场动画约 300-500ms）。 */
const NAV_TIMEOUT_MS = 2000;

type NavKind = "navigateTo" | "redirectTo" | "switchTab" | "reLaunch";

let navChain: Promise<unknown> = Promise.resolve();
let lastTarget = "";
let lastTargetAt = 0;

function runNav<T>(kind: NavKind, url: string): Promise<T> {
  const call = Taro[kind] as (option: { url: string }) => Promise<T>;
  return call({ url });
}

/** 串行 + 去重 + 栈保护的导航入口。 */
function enqueue<T>(kind: NavKind, url: string, options?: { dedupeMs?: number }): Promise<T> {
  // 短窗口内同目标重复导航直接吞掉（连点）。
  const dedupeMs = options?.dedupeMs ?? 600;
  if (url && url === lastTarget && Date.now() - lastTargetAt < dedupeMs) {
    return Promise.resolve(undefined as T);
  }
  lastTarget = url;
  lastTargetAt = Date.now();

  const task = navChain.then(async () => {
    let effectiveKind: NavKind = kind;
    if (kind === "navigateTo") {
      const pages = Taro.getCurrentPages?.() ?? [];
      if (pages.length >= PAGE_STACK_LIMIT - 1) {
        // 栈将满：替换栈顶而不是再压一层。
        effectiveKind = "redirectTo";
      }
    }
    return await runNav<T>(effectiveKind, url);
  });
  // 兜底：万一底层 Promise 不 settle，NAV_TIMEOUT_MS 后放行队列（不阻塞后续导航）。
  const bounded = Promise.race([
    task,
    new Promise<unknown>((resolve) => setTimeout(() => resolve(undefined), NAV_TIMEOUT_MS)),
  ]);
  navChain = bounded.catch(() => {});
  return task as Promise<T>;
}

export function safeNavigateTo(url: string): Promise<unknown> {
  return enqueue("navigateTo", url);
}

export function safeRedirectTo(url: string): Promise<unknown> {
  return enqueue("redirectTo", url);
}

export function safeSwitchTab(url: string): Promise<unknown> {
  return enqueue("switchTab", url);
}

export function safeReLaunch(url: string): Promise<unknown> {
  return enqueue("reLaunch", url);
}

/** 返回上一页（无上一页时回对话主页，避免死栈顶）。 */
export function safeNavigateBack(fallbackUrl = "/pages/chat/index"): Promise<unknown> {
  const pages = Taro.getCurrentPages?.() ?? [];
  if (pages.length > 1) {
    return Taro.navigateBack().catch(() => safeSwitchTab(fallbackUrl));
  }
  return safeSwitchTab(fallbackUrl);
}
