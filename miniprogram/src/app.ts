import { useEffect, type PropsWithChildren } from "react";
import Taro from "@tarojs/taro";
import { installPooledRandomSource, randomSourceInstalled } from "./connection/random-source";

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
  }, []);
  return children;
}

export default App;
