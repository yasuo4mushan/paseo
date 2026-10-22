import { defineConfig } from "vitest/config";

// hub 自包含服务的独立测试配置：不加入主仓 vitest workspace，
// 只覆盖 hub/tests/（API 集成测试直接打真实 http.Server + 临时目录存储）。
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
