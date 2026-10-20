import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// 小程序连接层的独立测试配置：不影响主仓 vitest 工作区，
// 只覆盖 miniprogram/tests/（单测 + 官方互通 + 打真 daemon/relay 的集成测试）。
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // 集成测试按文件串行，避免并发压真 daemon
    fileParallelism: false,
  },
});
