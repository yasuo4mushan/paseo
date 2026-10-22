/**
 * tabBar 图标生成器：1.5px 线条风（t20 重制，与 gen-icons.mjs 同原语）。
 *
 * 产物：src/assets/tabbar/{chat,devices,settings}{,-active}.png（81x81 RGBA）
 * 用法：node scripts/gen-tab-icons.mjs
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, COLORS, LINE } from "./png-canvas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../src/assets/tabbar");

const SHAPES = {
  /** 对话：气泡 + 两行文本（中心 tab）。 */
  chat: (cov, c) => {
    c.covRoundRect(cov, 12, 14, 57, 42, 12, LINE);
    c.covPolyline(cov, [[26, 54], [22, 68], [38, 56]], LINE);
    c.covLine(cov, 25, 29, 56, 29, LINE);
    c.covLine(cov, 25, 40, 46, 40, LINE);
  },
  /** 设备：显示器 + 支架 + 底座。 */
  devices: (cov, c) => {
    c.covRoundRect(cov, 12, 15, 57, 39, 7, LINE);
    c.covLine(cov, 40.5, 54, 40.5, 62, LINE);
    c.covLine(cov, 27, 66, 54, 66, LINE);
  },
  /** 设置：三档滑杆（细杆 + 空心旋钮）。 */
  settings: (cov, c) => {
    for (const { y, knob } of [
      { y: 23, knob: 58 },
      { y: 40.5, knob: 28 },
      { y: 58, knob: 47 },
    ]) {
      c.covLine(cov, 14, y, 67, y, LINE);
      c.covCircle(cov, knob, y, 8.5, LINE);
    }
  },
};

mkdirSync(OUT_DIR, { recursive: true });
const files = [];
for (const [name, draw] of Object.entries(SHAPES)) {
  for (const [suffix, color] of [
    ["", COLORS.gray],
    ["-active", COLORS.green],
  ]) {
    const canvas = new Canvas();
    const cov = canvas.allocCoverage();
    draw(cov, canvas);
    canvas.strokeCoverage(
      [parseInt(color.slice(1, 3), 16), parseInt(color.slice(3, 5), 16), parseInt(color.slice(5, 7), 16)],
      cov,
    );
    const png = canvas.toPng();
    writeFileSync(resolve(OUT_DIR, `${name}${suffix}.png`), png);
    files.push([`${name}${suffix}.png`, png.length]);
  }
}
for (const [name, size] of files) {
  console.log(`wrote src/assets/tabbar/${name} (${size} bytes)`);
}
