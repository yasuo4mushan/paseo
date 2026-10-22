/**
 * 自动化/调试事件日志（t19 起 agent 页使用；t20 提取共用）：
 * 页面把关键 RPC 结果推到 app.__automation.downloadLog，
 * devtools automator 经 mini.evaluate(getApp()) 读取做验收断言。
 * 生产环境无 UI 暴露面，静默 no-op。
 */

import Taro from "@tarojs/taro";

export function recordAutomationEvent(event: Record<string, unknown>): void {
  const app = Taro.getApp?.() as unknown as
    | {
        __automation?: { downloadLog?: Array<Record<string, unknown>> };
      }
    | undefined;
  app?.__automation?.downloadLog?.push({ ...event, at: Date.now() });
}
