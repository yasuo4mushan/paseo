/**
 * 页面主题 class 订阅 hook（t18）：themeStore 变化时重渲染，
 * 返回追加到页面根节点的 class（"theme-light" / "theme-dark" / ""）。
 *
 * t22：每次 didShow 对当前页重设导航/窗口 chrome —— wx.setNavigationBarColor
 * 只作用于当前页，不重设的话手动档跨页导航会露出系统档的导航栏颜色。
 * 自管 chrome 的页面（终端恒暗导航）传 { chrome: false } 退出。
 *
 * 平台纪律：不用 useSyncExternalStore（React 18 小程序环境曾出过撕裂告警），
 * useState + useEffect 订阅（同 agents 页 useWorkspaceSelection 模式）。
 */

import { useEffect, useState } from "react";
import { useDidShow } from "@tarojs/taro";
import { themeStore } from "@/stores/theme-store";

export function useThemeClass(options: { chrome?: boolean } = {}): string {
  const { chrome = true } = options;
  const [cls, setCls] = useState(() => themeStore.getPageClass());
  useEffect(() => themeStore.subscribe(() => setCls(themeStore.getPageClass())), []);
  useDidShow(() => {
    if (chrome) themeStore.applyChrome();
  });
  return cls;
}
