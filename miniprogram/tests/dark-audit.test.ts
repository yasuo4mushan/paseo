/**
 * t22 深色模式回归门：src 下 css/tsx 除白名单外不得出现硬编码色值。
 *
 * 规则（与 src/app.css 头注释一致）：
 *  - 色值字面量（#hex / rgb() / rgba() / white / black）只允许出现在：
 *      1. src/app.css —— 且仅限自定义属性定义行（--token: value）或注释行；
 *      2. src/constants/colors.ts —— wx API 只收字符串色值，CSS 变量不可用。
 *  - 白名单之外每发现一处即 fail，并给出文件:行号；新增场景请先补语义 token。
 *  - 现无"二维码反白"类例外；如未来需要（纯白打印底等），在下方 WHITELIST 显式登记。
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));

/** 允许出现色值字面量的文件（相对 src/，理由见各条注释）。 */
const WHITELIST: ReadonlyArray<{ file: string; why: string }> = [
  // 设计 token 唯一定义处；测试内另有限制：字面量必须落在 --token 定义或注释行
  { file: "app.css", why: "全局 token 定义处（浅/深双轨 + 恒色 token）" },
  // wx.showModal / 页面 config 等原生接口只接受字符串色值
  { file: "constants/colors.ts", why: "wx API 侧色值常量收口（CSS 变量不可用）" },
  // THEME_CHROME 原生导航/tabBar/窗口色板（wx API 字符串色值，双轨机制另一半）
  { file: "stores/theme-store.ts", why: "THEME_CHROME 原生 chrome 色板" },
];
const WHITELIST_FILES = new Set(WHITELIST.map((w) => w.file));

/** 色值字面量：#hex 与 rgb()/rgba()，及独立成词的 white/black（排除 white-space 等）。 */
const COLOR_LITERAL = /#[0-9a-fA-F]{3,8}\b|rgba?\(\s*\d|(?:^|[^-\w])(?:white|black)(?![\w-])/g;

/** 收集 src 下所有 .css/.tsx/.ts 文件（含嵌套；跳过生成产物目录）。 */
function collect(root: string, out: string[] = []): string[] {
  for (const name of readdirSync(root)) {
    if (name.startsWith(".") || name === "assets") continue;
    const full = join(root, name);
    if (statSync(full).isDirectory()) {
      collect(full, out);
      continue;
    }
    if (/\.(css|tsx|ts)$/.test(name)) out.push(full);
  }
  return out;
}

function lineHasCodeColorLiteral(line: string): boolean {
  // wx 配置枚举字段只收 "white"/"black" 两个字面量（非自由色值），连同
  // Taro 类型缺失时的 `as "white"` 断言一起剔除后再扫
  const stripped = line
    .replace(/((?:navigationBarTextStyle|borderStyle)\s*:\s*)"(?:white|black)"/g, "$1")
    .replace(/\bas\s+"(?:white|black)"/g, "")
    .replace(/\/\*.*?\*\//g, (m) => m.replace(/[^\s]/g, " "))
    .replace(/\/\/.*$/, "");
  return COLOR_LITERAL.test(stripped);
}

describe("t22 深色审计：无硬编码色值", () => {
  it("src 下除白名单文件外，css/tsx/ts 无色值字面量", () => {
    const offenders: string[] = [];
    for (const file of collect(SRC_DIR)) {
      const rel = relative(SRC_DIR, file).split(sep).join("/");
      if (WHITELIST_FILES.has(rel)) continue;
      const lines = readFileSync(file, "utf8").split(/\r?\n/);
      lines.forEach((line, i) => {
        COLOR_LITERAL.lastIndex = 0;
        if (lineHasCodeColorLiteral(line)) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `发现硬编码色值，请改用语义 token（app.css）或收口到 constants/colors.ts：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("app.css 内的色值字面量只出现在 token 定义行或注释里", () => {
    const css = readFileSync(join(SRC_DIR, "app.css"), "utf8").split(/\r?\n/);
    const offenders: string[] = [];
    css.forEach((line, i) => {
      COLOR_LITERAL.lastIndex = 0;
      if (!lineHasCodeColorLiteral(line)) return;
      const isTokenDef = /^\s*--[\w-]+\s*:/.test(line);
      const isComment = /^\s*(\/\*|\*|\/\/)/.test(line);
      if (!isTokenDef && !isComment) offenders.push(`app.css:${i + 1}: ${line.trim()}`);
    });
    expect(
      offenders,
      `app.css 里色值只能落在 --token 定义或注释（组件规则一律引用 var()）：\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("白名单登记的文件仍存在（防止删除后白名单悄悄失效）", () => {
    for (const { file } of WHITELIST) {
      expect(statSync(join(SRC_DIR, file)).isFile(), `${file} 已不存在，请同步更新 WHITELIST`).toBe(
        true,
      );
    }
  });
});
