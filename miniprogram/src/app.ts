import { useEffect, type PropsWithChildren } from "react";
import Taro from "@tarojs/taro";
import { installPooledRandomSource, randomSourceInstalled } from "./connection/random-source";
import { permissionStore } from "./permission/permission-store";
import { attentionStore } from "./stores/attention-store";
import { workspaceStore } from "./stores/workspace-store";
import { sessionStore } from "./stores/session-store";
import { safeNavigateTo } from "./utils/navigation";
import {
  normalizeThemePreference,
  themeStore,
  type ThemeChromeColors,
} from "./stores/theme-store";
// 全局设计 tokens 与共享样式（app.wxss）：Taro 的 app 入口不会自动收集
// src/app.css，必须在入口显式 import，否则全局样式静默丢失（t10 踩坑）。
import "./app.css";

/**
 * E2EE 需要 tweetnacl 有可用 PRNG；小程序无 WebCrypto，这里在启动时安装
 * wx.getRandomValues 驱动的字节池（见 random-source.ts）。
 */
function installRandom(): void {
  if (randomSourceInstalled()) return;
  type RandomValuesApi = (option: { length: number }) => Promise<{ randomValues: ArrayBuffer }>;
  const api = (Taro as unknown as { getRandomValues?: RandomValuesApi }).getRandomValues;
  if (typeof api === "function") {
    installPooledRandomSource(async (n) => {
      const { randomValues } = await api({ length: n });
      return new Uint8Array(randomValues);
    });
    return;
  }
  // 老基础库无 wx.getRandomValues：字节池恒空，退化为 Math.random 兜底
  // （安全性降级，见 README 限制说明）。
  installPooledRandomSource(async () => new Uint8Array(0));
}

const THEME_KEY = "aaswitch_theme_pref";
const VIBRATE_KEY = "aaswitch_attention_vibrate";

/** t18：attention 副作用 —— tabBar 徽标（t20 起会话在对话 tab，index=1）+ 振动。 */
function installAttentionEffects(): void {
  const stored = Taro.getStorageSync<boolean>(VIBRATE_KEY);
  if (typeof stored === "boolean") attentionStore.setVibrationEnabled(stored);
  attentionStore.bindSideEffects({
    onCountChange: (count) => {
      if (count > 0) {
        Taro.setTabBarBadge({ index: 1, text: count > 99 ? "99+" : String(count) }).catch(() => {
          // 非 tab 页面或渲染时机不匹配时静默（徽标是增强提示，不阻塞）
        });
      } else {
        Taro.removeTabBarBadge({ index: 1 }).catch(() => {});
      }
    },
    onNotify: (_entry, push) => {
      if (push.shouldNotify) {
        Taro.vibrateShort({ type: "light" }).catch(() => {});
      }
    },
  });
}

/** t18：主题三档 —— storage 持久化 + 导航/tabBar 显式着色 + 系统主题变化监听。 */
function installTheme(): void {
  const applyChrome = (colors: ThemeChromeColors) => {
    Taro.setNavigationBarColor({
      frontColor: colors.navFrontColor,
      backgroundColor: colors.navBackgroundColor,
    }).catch(() => {});
    Taro.setTabBarStyle(colors.tabBar).catch(() => {});
    // t22：窗口底色（下拉/回弹露出区域）与 --bg 同步，避免手动深色档边缘闪白。
    Taro.setBackgroundColor({ backgroundColor: colors.pageBackgroundColor }).catch(() => {});
  };
  const systemTheme =
    (Taro.getSystemInfoSync().theme as string | undefined) ?? "light";
  themeStore.install(
    {
      get: () => {
        const raw = Taro.getStorageSync<string>(THEME_KEY);
        return raw ? normalizeThemePreference(raw) : null;
      },
      set: (value) => Taro.setStorageSync(THEME_KEY, value),
    },
    applyChrome,
    systemTheme,
  );
  // wx.onThemeChange(callback)：Taro 类型把它标成了 option 对象，这里按实际 API 断言。
  const onThemeChange = (Taro as unknown as { onThemeChange?: (cb: (res: { theme: string }) => void) => void })
    .onThemeChange;
  onThemeChange?.((res) => {
    themeStore.setSystemTheme(res.theme);
  });
}

function App({ children }: PropsWithChildren) {
  useEffect(() => {
    installRandom();
    installTheme();
    installAttentionEffects();
    // 自动化验收桥（t16/t17/t18）：devtools automator 经 mini.evaluate(getApp()) 注入
    // mock 权限/attention 推送、读取下载调用记录与工作区选择，驱动截图与验收断言。
    // 生产环境无 UI 暴露面，仅内部对象引用。
    const app = Taro.getApp?.() as unknown as
      | {
          __automation?: {
            permissionStore: typeof permissionStore;
            attentionStore: typeof attentionStore;
            workspaceStore: typeof workspaceStore;
            sessionStore: typeof sessionStore;
            /** t20：验收清理用（绕过确认弹窗直删验证 agent）。 */
            deleteAgent?: (agentId: string) => Promise<void>;
            /** t24：验收清理用（直删向导新建的验证文件夹，绕过长按菜单）。 */
            deleteFsEntry?: (cwd: string, path: string) => Promise<void>;
            /** t20：navigateTo timeout 回归步（页面栈降级/连点去重在真 runtime 验证）。 */
            safeNavigateTo?: (url: string) => Promise<unknown>;
            /** t20：验收收尾断开连接（devtools 实例常驻，避免污染下一次运行）。 */
            disconnect?: () => Promise<void>;
            downloadLog?: Array<Record<string, unknown>>;
          };
        }
      | undefined;
    if (app && !app.__automation) {
      app.__automation = { permissionStore, attentionStore, workspaceStore, sessionStore, downloadLog: [] };
    } else if (app?.__automation && !app.__automation.downloadLog) {
      app.__automation.downloadLog = [];
    }
    if (app?.__automation && !app.__automation.sessionStore) {
      app.__automation.sessionStore = sessionStore;
    }
    if (app?.__automation && !app.__automation.safeNavigateTo) {
      app.__automation.safeNavigateTo = safeNavigateTo;
    }
    if (app?.__automation && !app.__automation.disconnect) {
      app.__automation.disconnect = async () => {
        const { connectionManager } = await import("./connection/connection-manager");
        connectionManager.disconnect();
      };
    }
    if (app?.__automation && !app.__automation.deleteAgent) {
      app.__automation.deleteAgent = async (agentId: string) => {
        const { connectionManager } = await import("./connection/connection-manager");
        await connectionManager.requireConnection().deleteAgent(agentId);
      };
    }
    if (app?.__automation && !app.__automation.deleteFsEntry) {
      app.__automation.deleteFsEntry = async (cwd: string, path: string) => {
        const { connectionManager } = await import("./connection/connection-manager");
        await connectionManager.requireConnection().deleteFsEntry({ cwd, path });
      };
    }
  }, []);
  return children;
}

export default App;
