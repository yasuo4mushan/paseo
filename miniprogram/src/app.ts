import { useEffect, type PropsWithChildren } from "react";
import Taro from "@tarojs/taro";
import { installPooledRandomSource, randomSourceInstalled } from "./connection/random-source";
import { permissionStore } from "./permission/permission-store";
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

function App({ children }: PropsWithChildren) {
  useEffect(() => {
    installRandom();
    // 自动化验收桥（t16/t17）：devtools automator 经 mini.evaluate(getApp()) 注入
    // mock 权限推送 / 读取下载与预览调用记录，驱动全局弹层截图与验收断言。
    // 生产环境无 UI 暴露面，仅内部对象引用。
    const app = Taro.getApp?.() as unknown as
      | {
          __automation?: {
            permissionStore: typeof permissionStore;
            downloadLog?: Array<Record<string, unknown>>;
          };
        }
      | undefined;
    if (app && !app.__automation) {
      app.__automation = { permissionStore, downloadLog: [] };
    } else if (app?.__automation && !app.__automation.downloadLog) {
      app.__automation.downloadLog = [];
    }
  }, []);
  return children;
}

export default App;
