/**
 * t20 图标资产完整性测试：
 *  - manifest 与 PNG 文件一一对应（生成器产物齐全，无缺档变体）；
 *  - 每个 PNG 是合法 81x81 RGBA（签名 + IHDR 校验）；
 *  - 语义图标清单（tabBar + 页面引用的关键名）存在；
 *  - src 内零 emoji（P0-2 回归门：图标一律线条 PNG，平台 emoji 不再用于图标）。
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import manifestJson from "../src/assets/icons/manifest.json";

const here = dirname(fileURLToPath(import.meta.url));
const ICON_DIR = resolve(here, "../src/assets/icons");
const TABBAR_DIR = resolve(here, "../src/assets/tabbar");
const SRC_DIR = resolve(here, "../src");

const manifest = manifestJson as Record<string, { description: string; files: string[] }>;

/** PNG 签名 + IHDR（81x81 RGBA）校验。 */
function assertValidPng(file: string, width = 81, height = 81): void {
  const buf = readFileSync(file);
  expect(buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), `${file} PNG 签名`).toBe(true);
  expect(buf.readUInt32BE(16), `${file} 宽`).toBe(width);
  expect(buf.readUInt32BE(20), `${file} 高`).toBe(height);
  expect(buf[24], `${file} 位深`).toBe(8);
  expect(buf[25], `${file} 色彩类型`).toBe(6); // RGBA
}

describe("图标 manifest 与资产文件", () => {
  it("manifest 列出的文件全部存在且为合法 81x81 RGBA PNG", () => {
    const names = Object.keys(manifest);
    expect(names.length).toBeGreaterThanOrEqual(30);
    for (const entry of Object.values(manifest)) {
      expect(entry.files.length).toBeGreaterThan(0);
      for (const file of entry.files) {
        const path = resolve(ICON_DIR, file);
        expect(existsSync(path), `${file} 缺失`).toBe(true);
        assertValidPng(path);
      }
    }
  });

  it("目录里的 PNG 都被 manifest 收录（无孤儿资产）", () => {
    const listed = new Set(Object.values(manifest).flatMap((e) => e.files));
    const onDisk = readdirSync(ICON_DIR).filter((f) => f.endsWith(".png"));
    expect(onDisk.filter((f) => !listed.has(f))).toEqual([]);
  });

  it("语义关键图标齐全（页面直接引用的名字）", () => {
    for (const key of [
      "chat",
      "devices",
      "settings",
      "file",
      "terminal",
      "diff",
      "schedule",
      "bell",
      "archive",
      "tag",
      "plus",
      "send",
      "paperclip",
      "close",
      "back",
      "chevron-down",
      "expand",
      "project",
      "check",
      "warning",
      "image",
      "bot",
      "spark",
      "brand-claude",
      "brand-codex",
      "brand-zcode",
      "brand-kimi",
      "brand-codebuddy",
      "brand-qoder",
      "brand-qwen",
    ]) {
      expect(manifest[key], `manifest 缺 ${key}`).toBeDefined();
    }
  });

  it("tabBar 三 tab 图标（含 active 变体）存在", () => {
    for (const name of [
      "devices.png",
      "devices-active.png",
      "chat.png",
      "chat-active.png",
      "settings.png",
      "settings-active.png",
    ]) {
      const path = resolve(TABBAR_DIR, name);
      expect(existsSync(path), `tabBar 缺 ${name}`).toBe(true);
      assertValidPng(path);
    }
  });
});

describe("emoji 归零回归门", () => {
  it("src 下 tsx/ts/css 无 pictographic emoji/dingbat 字符", () => {
    const offenders: string[] = [];
    const emojiRe = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}]/gu;
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!/\.(tsx?|css)$/.test(entry.name)) continue;
        const text = readFileSync(path, "utf8");
        const matches = text.match(emojiRe);
        if (matches) offenders.push(`${path}: ${matches.join(" ")}`);
      }
    };
    walk(SRC_DIR);
    expect(offenders).toEqual([]);
  });
});
