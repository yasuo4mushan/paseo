/**
 * 页面主题 class 订阅 hook（t18）：themeStore 变化时重渲染，
 * 返回追加到页面根节点的 class（"theme-light" / "theme-dark" / ""）。
 *
 * 平台纪律：不用 useSyncExternalStore（React 18 小程序环境曾出过撕裂告警），
 * useState + useEffect 订阅（同 agents 页 useWorkspaceSelection 模式）。
 */

import { useEffect, useState } from "react";
import { themeStore } from "@/stores/theme-store";

export function useThemeClass(): string {
  const [cls, setCls] = useState(() => themeStore.getPageClass());
  useEffect(() => themeStore.subscribe(() => setCls(themeStore.getPageClass())), []);
  return cls;
}
