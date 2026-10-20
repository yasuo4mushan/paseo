import { defineConfig, type UserConfigExport } from "@tarojs/cli";
import path from "node:path";
import { fileURLToPath } from "node:url";
import devConfig from "./dev";
import prodConfig from "./prod";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

// https://taro-docs.jd.com/docs/next/config#defineconfig-辅助函数
export default defineConfig(async (merge) => {
  const baseConfig: UserConfigExport<"webpack5"> = {
    projectName: "paseo-miniprogram",
    date: "2026-10-20",
    designWidth: 750,
    deviceRatio: { 640: 2.34 / 2, 750: 1, 375: 2, 828: 1.81 / 2 },
    sourceRoot: "src",
    outputRoot: "dist",
    plugins: [],
    defines: {
      // Keep the Node-only test adapter out of the weapp bundle graph even if
      // an import sneaks in; Node socket code lives under tests/ anyway.
      __MINIPROGRAM__: true,
    },
    framework: "react",
    compiler: "webpack5",
    cache: { enable: false },
    mini: {
      postcss: {
        pxtransform: {
          enable: true,
          config: {},
        },
        cssModules: {
          enable: false,
        },
      },
      miniCssExtractPluginOption: {
        ignoreOrder: true,
      },
      webpackChain(chain) {
        // tweetnacl references Node built-ins through its UMD wrapper; we always
        // provide our own PRNG (src/connection/random-source.ts), so stub them.
        chain.resolve.set("fallback", {
          crypto: false,
          path: false,
          fs: false,
          module: false,
        });
      },
    },
    h5: {},
    alias: {
      "@": srcRoot,
    },
  };

  if (process.env.NODE_ENV === "development") {
    return merge({}, baseConfig, devConfig);
  }
  return merge({}, baseConfig, prodConfig);
});
