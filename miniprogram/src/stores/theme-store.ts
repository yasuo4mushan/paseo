/**
 * 外观主题三档（t18）：跟随系统 / 浅色 / 深色。
 *
 * darkmode 双轨覆盖：
 * - 页面 tokens：page 根节点追加 .theme-light / .theme-dark class 覆盖 CSS 变量
 *   （app.css 定义两套覆盖；跟随系统时不加 class，走 prefers-color-scheme 媒体查询）。
 * - 导航/tabBar：wx.setNavigationBarColor + wx.setTabBarStyle 按解析结果显式设置
 *   （setTabBarStyle 无"恢复默认"API，跟随模式也按当前系统主题设同款值，行为一致）。
 *
 * 平台无关纯 TS + 订阅；storage / 系统主题 / wx 副作用由宿主注入，可单测。
 */

export type ThemePreference = "auto" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const VALID: ReadonlySet<string> = new Set(["auto", "light", "dark"]);

export function normalizeThemePreference(value: unknown): ThemePreference {
  return typeof value === "string" && VALID.has(value) ? (value as ThemePreference) : "auto";
}

/** 偏好 → 实际主题（auto 由宿主注入的系统主题解析）。 */
export function resolveTheme(preference: ThemePreference, systemTheme: string): ResolvedTheme {
  if (preference === "light" || preference === "dark") return preference;
  return systemTheme === "dark" ? "dark" : "light";
}

/** 页面根 class：auto 不加（媒体查询兜底），显式档位加覆盖 class。 */
export function themePageClass(preference: ThemePreference): string {
  if (preference === "light") return "theme-light";
  if (preference === "dark") return "theme-dark";
  return "";
}

export const THEME_LABELS: Record<ThemePreference, string> = {
  auto: "跟随系统",
  light: "浅色",
  dark: "深色",
};

export interface ThemeChromeColors {
  /** 导航栏前景：wx.setNavigationBarColor 仅接受 #ffffff / #000000。 */
  navFrontColor: "#ffffff" | "#000000";
  navBackgroundColor: string;
  tabBar: {
    color: string;
    selectedColor: string;
    backgroundColor: string;
    borderStyle: "black" | "white";
  };
}

export const THEME_CHROME: Record<ResolvedTheme, ThemeChromeColors> = {
  light: {
    navFrontColor: "#000000",
    navBackgroundColor: "#ffffff",
    tabBar: {
      color: "#8a8f99",
      selectedColor: "#07c160",
      backgroundColor: "#ffffff",
      borderStyle: "black",
    },
  },
  dark: {
    navFrontColor: "#ffffff",
    navBackgroundColor: "#111111",
    tabBar: {
      color: "#5f6672",
      selectedColor: "#07c160",
      backgroundColor: "#1e1e1e",
      borderStyle: "white",
    },
  },
};

type Listener = () => void;

class ThemeStore {
  private preference: ThemePreference = "auto";
  private systemTheme: ResolvedTheme = "light";
  private listeners = new Set<Listener>();
  /** 宿主注入的 chrome 应用器（wx.setNavigationBarColor / setTabBarStyle）。 */
  private applyChrome: ((colors: ThemeChromeColors) => void) | null = null;
  private storage: {
    get: () => ThemePreference | null;
    set: (value: ThemePreference) => void;
  } = {
    get: () => null,
    set: () => {},
  };

  install(
    storage: { get: () => ThemePreference | null; set: (value: ThemePreference) => void },
    applyChrome: (colors: ThemeChromeColors) => void,
    systemTheme: string,
  ): void {
    this.storage = storage;
    this.applyChrome = applyChrome;
    this.systemTheme = systemTheme === "dark" ? "dark" : "light";
    this.preference = normalizeThemePreference(storage.get());
    this.emitChrome();
    this.notify();
  }

  /** 系统主题变化（wx.onThemeChange）；仅跟随模式有意义，但统一重设 chrome。 */
  setSystemTheme(theme: string): void {
    const next: ResolvedTheme = theme === "dark" ? "dark" : "light";
    if (next === this.systemTheme) return;
    this.systemTheme = next;
    this.emitChrome();
    this.notify();
  }

  getPreference(): ThemePreference {
    return this.preference;
  }

  getResolved(): ResolvedTheme {
    return resolveTheme(this.preference, this.systemTheme);
  }

  getPageClass(): string {
    return themePageClass(this.preference);
  }

  setPreference(preference: ThemePreference): void {
    const next = normalizeThemePreference(preference);
    if (next === this.preference) return;
    this.preference = next;
    this.storage.set(next);
    this.emitChrome();
    this.notify();
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  private emitChrome(): void {
    this.applyChrome?.(THEME_CHROME[this.getResolved()]);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }
}

/** 单例经 globalThis 固定（原因见 permission-store.ts 同款注释）。 */
const GLOBAL_KEY = "__aaswitch_theme_store";
const globalScope = globalThis as { [GLOBAL_KEY]?: ThemeStore };
export const themeStore: ThemeStore = (globalScope[GLOBAL_KEY] ??= new ThemeStore());
