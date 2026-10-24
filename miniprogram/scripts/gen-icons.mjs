/**
 * 应用内线条图标生成器（t20）：1.5px 线条风，与 tabBar 同风格。
 *
 * 产物：src/assets/icons/<name>.png（81x81 RGBA）+ manifest.json（名称→用途）。
 * 用法：node scripts/gen-icons.mjs
 *
 * 颜色策略：单中性灰 #8A9099 同档适配浅/深主题（tabBar 图标先例）；
 * 语义变体追加后缀：-active（品牌绿）/ -danger / -warning / -inverse（白）。
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Canvas, COLORS, LINE, hex } from "./png-canvas.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../src/assets/icons");

const shapes = {
  chat: (cov, c) => {
    c.covRoundRect(cov, 12, 14, 57, 42, 12, LINE);
    c.covPolyline(
      cov,
      [
        [26, 54],
        [22, 68],
        [38, 56],
      ],
      LINE,
    );
    c.covLine(cov, 25, 29, 56, 29, LINE);
    c.covLine(cov, 25, 40, 46, 40, LINE);
  },
  devices: (cov, c) => {
    c.covRoundRect(cov, 12, 15, 57, 39, 7, LINE);
    c.covLine(cov, 40.5, 54, 40.5, 62, LINE);
    c.covLine(cov, 27, 66, 54, 66, LINE);
  },
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
  file: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [24, 12],
        [50, 12],
        [62, 24],
        [62, 68],
        [24, 68],
        [24, 12],
      ],
      LINE,
    );
    c.covPolyline(
      cov,
      [
        [50, 12],
        [50, 24],
        [62, 24],
      ],
      LINE,
    );
    c.covLine(cov, 33, 40, 53, 40, LINE);
    c.covLine(cov, 33, 50, 46, 50, LINE);
  },
  terminal: (cov, c) => {
    c.covRoundRect(cov, 12, 16, 57, 49, 8, LINE);
    c.covPolyline(
      cov,
      [
        [24, 31],
        [34, 40.5],
        [24, 50],
      ],
      LINE,
    );
    c.covLine(cov, 40, 50, 53, 50, LINE);
  },
  diff: (cov, c) => {
    c.covLine(cov, 25, 30, 45, 30, LINE);
    c.covLine(cov, 35, 20, 35, 40, LINE);
    c.covLine(cov, 25, 57, 45, 57, LINE);
    c.covLine(cov, 56, 16, 56, 65, LINE);
  },
  schedule: (cov, c) => {
    c.covCircle(cov, 40.5, 40.5, 26, LINE);
    c.covLine(cov, 40.5, 40.5, 40.5, 25, LINE);
    c.covLine(cov, 40.5, 40.5, 52, 47, LINE);
  },
  bell: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [26, 52],
        [26, 37],
        [32, 25],
        [40.5, 20],
        [49, 25],
        [55, 37],
        [55, 52],
      ],
      LINE,
    );
    c.covLine(cov, 22, 57, 59, 57, LINE);
    c.covArc(cov, 40.5, 60, 5, LINE, 20, 160);
  },
  archive: (cov, c) => {
    c.covRoundRect(cov, 13, 20, 55, 20, 4, LINE);
    c.covPolyline(
      cov,
      [
        [19, 40],
        [19, 66],
        [62, 66],
        [62, 40],
      ],
      LINE,
    );
    c.covLine(cov, 34, 30, 47, 30, LINE);
    c.covLine(cov, 35, 50, 46, 50, LINE);
  },
  tag: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [22, 22],
        [54, 12],
        [68, 46],
        [36, 60],
        [22, 22],
      ],
      LINE,
    );
    c.covCircle(cov, 31, 49, 4.5, LINE);
  },
  plus: (cov, c) => {
    c.covLine(cov, 40.5, 19, 40.5, 62, LINE);
    c.covLine(cov, 19, 40.5, 62, 40.5, LINE);
  },
  send: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [21, 17],
        [65, 40.5],
        [21, 64],
        [32, 40.5],
        [21, 17],
      ],
      LINE,
    );
  },
  paperclip: (cov, c) => {
    c.covArc(cov, 40.5, 36, 14.5, LINE, 10, 170); // 底部 U 弧
    c.covLine(cov, 26.2, 38.5, 26.2, 22, LINE);
    c.covLine(cov, 54.8, 38.5, 54.8, 22, LINE);
    c.covArc(cov, 40.5, 22, 14.3, LINE, 180, 360); // 顶部外弧
    c.covLine(cov, 33, 38, 33, 27, LINE);
    c.covArc(cov, 40.5, 27, 7.5, LINE, 180, 360); // 内钩
  },
  close: (cov, c) => {
    c.covLine(cov, 26, 26, 55, 55, LINE);
    c.covLine(cov, 55, 26, 26, 55, LINE);
  },
  back: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [51, 19],
        [28, 40.5],
        [51, 62],
      ],
      LINE,
    );
  },
  "chevron-down": (cov, c) => {
    c.covPolyline(
      cov,
      [
        [25, 34],
        [40.5, 50],
        [56, 34],
      ],
      LINE,
    );
  },
  mic: (cov, c) => {
    // 麦克风（t32 语音输入）：胶囊 + 下颌弧 + 立柱底座
    c.covRoundRect(cov, 30, 13, 21, 34, 10.5, LINE);
    c.covArc(cov, 40.5, 43, 14.5, LINE, 20, 160);
    c.covLine(cov, 40.5, 57.5, 40.5, 66, LINE);
    c.covLine(cov, 31, 66, 50, 66, LINE);
  },
  expand: (cov, c) => {
    c.covRoundRect(cov, 12, 18, 57, 45, 7, LINE);
    c.covLine(cov, 49, 18, 49, 63, LINE);
    c.covLine(cov, 56, 18, 56, 63, LINE);
  },
  project: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [14, 24],
        [33, 24],
        [39, 30],
        [67, 30],
        [67, 60],
        [14, 60],
        [14, 24],
      ],
      LINE,
    );
  },
  check: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [21, 43],
        [34, 56],
        [60, 26],
      ],
      LINE,
    );
  },
  more: (cov, c) => {
    // t25 消息操作入口：三个圆点（小半径 + 5px 线宽叠出近似实心）
    c.covCircle(cov, 20, 40.5, 3.5, LINE);
    c.covCircle(cov, 40.5, 40.5, 3.5, LINE);
    c.covCircle(cov, 61, 40.5, 3.5, LINE);
  },
  warning: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [40.5, 15],
        [64, 59],
        [17, 59],
        [40.5, 15],
      ],
      LINE,
    );
    c.covLine(cov, 40.5, 30, 40.5, 44, LINE);
    c.covLine(cov, 40.5, 50, 40.5, 52.5, LINE);
  },
  image: (cov, c) => {
    c.covRoundRect(cov, 13, 19, 55, 43, 6, LINE);
    c.covCircle(cov, 29, 32, 4.5, LINE);
    c.covPolyline(
      cov,
      [
        [21, 56],
        [38, 41],
        [47, 50],
        [55, 43],
        [62, 56],
      ],
      LINE,
    );
  },
  bot: (cov, c) => {
    c.covRoundRect(cov, 18, 27, 45, 38, 11, LINE);
    c.covLine(cov, 40.5, 27, 40.5, 17, LINE);
    c.covCircle(cov, 40.5, 14.5, 3, LINE);
    c.covLine(cov, 30, 40, 30, 46, LINE);
    c.covLine(cov, 51, 40, 51, 46, LINE);
    c.covLine(cov, 33, 55, 48, 55, LINE);
  },
  spark: (cov, c) => {
    c.covPolyline(
      cov,
      [
        [23, 23],
        [58, 58],
      ],
      LINE,
    );
    c.covPolyline(
      cov,
      [
        [58, 23],
        [23, 58],
      ],
      LINE,
    );
    c.covLine(cov, 40.5, 14, 40.5, 30, LINE);
    c.covLine(cov, 40.5, 51, 40.5, 67, LINE);
    c.covLine(cov, 14, 40.5, 30, 40.5, LINE);
    c.covLine(cov, 51, 40.5, 67, 40.5, LINE);
  },
  refresh: (cov, c) => {
    // 开口圆弧（缺口在左上-顶部）+ 顺时针切向箭头（Material refresh 简化）
    c.covArc(cov, 40.5, 40.5, 24, LINE, 270, 570);
    c.covPolyline(
      cov,
      [
        [11.5, 30.7],
        [22.7, 23.3],
        [21.9, 36.7],
      ],
      LINE,
    );
  },
  import: (cov, c) => {
    // 导入（下载入托盘）：竖线 + 箭头头 + 底部托盘
    c.covLine(cov, 40.5, 13, 40.5, 42, LINE);
    c.covPolyline(
      cov,
      [
        [28, 32],
        [40.5, 45],
        [53, 32],
      ],
      LINE,
    );
    c.covPolyline(
      cov,
      [
        [16, 52],
        [16, 66],
        [65, 66],
        [65, 52],
      ],
      LINE,
    );
  },
};

/** agent 品牌简约字形标（线条几何，非官方 logo，仅识别用）。 */
const brandShapes = {
  "brand-claude": (cov, c) => {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      c.covLine(
        cov,
        40.5 + 8 * Math.cos(a),
        40.5 + 8 * Math.sin(a),
        40.5 + 25 * Math.cos(a),
        40.5 + 25 * Math.sin(a),
        LINE,
      );
    }
  },
  "brand-codex": (cov, c) => {
    const pts = [];
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI) / 3 - Math.PI / 2;
      pts.push([40.5 + 25 * Math.cos(a), 40.5 + 25 * Math.sin(a)]);
    }
    c.covPolyline(cov, pts, LINE, true);
  },
  "brand-zcode": (cov, c) => {
    c.covPolyline(
      cov,
      [
        [27, 19],
        [55, 19],
        [27, 62],
        [55, 62],
      ],
      LINE,
    );
  },
  "brand-kimi": (cov, c) => {
    c.covCircle(cov, 40.5, 40.5, 23, LINE);
    c.covCircle(cov, 56.5, 24.5, 4.5, LINE);
  },
  "brand-codebuddy": (cov, c) => {
    c.covCircle(cov, 40.5, 40.5, 23, LINE);
    c.covCircle(cov, 40.5, 40.5, 5.5, LINE);
  },
  "brand-qoder": (cov, c) => {
    c.covPolyline(
      cov,
      [
        [40.5, 13],
        [68, 40.5],
        [40.5, 68],
        [13, 40.5],
        [40.5, 13],
      ],
      LINE,
    );
  },
  "brand-qwen": (cov, c) => {
    c.covArc(cov, 40.5, 40.5, 24, LINE, -55, 55);
    c.covArc(cov, 40.5, 40.5, 24, LINE, 125, 235);
    c.covArc(cov, 40.5, 40.5, 12, LINE, 55, 125);
  },
};

/** 产物清单：name → { draw, 变体色 }。缺省中性灰。 */
const VARIANTS = {
  active: COLORS.green,
  danger: COLORS.danger,
  warning: COLORS.warning,
  inverse: COLORS.white,
};

const MANIFEST_ENTRIES = [
  // [名称, 用途说明, 变体列表]
  ["chat", "会话（气泡）", ["active"]],
  ["devices", "设备（显示器）", ["active"]],
  ["settings", "设置（三档滑杆）", ["active"]],
  ["file", "文件（折角文档）", []],
  ["terminal", "终端（> _）", []],
  ["diff", "改动（+/− 与分隔线）", []],
  ["schedule", "定时（时钟）", ["warning"]],
  ["bell", "通知（铃铛）", []],
  ["archive", "归档（收纳盒）", []],
  ["tag", "标签（价签）", []],
  ["plus", "加号（新建/附件）", ["inverse"]],
  ["send", "发送（纸飞机）", ["active", "inverse"]],
  ["paperclip", "附件（回形针）", []],
  ["close", "关闭（×）", ["inverse"]],
  ["mic", "麦克风（语音输入）", ["inverse"]],
  ["back", "返回（左箭头）", []],
  ["chevron-down", "下箭头（选择器）", []],
  ["expand", "展开栏（右侧轨道）", []],
  ["project", "项目（文件夹）", []],
  ["check", "完成（✓）", ["active"]],
  ["more", "更多操作（三点）", []],
  ["warning", "警告（三角）", []],
  ["image", "图片（山与日）", []],
  ["bot", "机器人（空态）", []],
  ["spark", "星芒（空态点缀）", ["active"]],
  ["refresh", "刷新（循环箭头）", []],
  ["import", "导入（下载入托盘）", []],
  ["brand-claude", "Claude 品牌标（星芒）", []],
  ["brand-codex", "Codex 品牌标（六边形）", []],
  ["brand-zcode", "zcode 品牌标（Z）", []],
  ["brand-kimi", "Kimi 品牌标（轨道圆）", []],
  ["brand-codebuddy", "CodeBuddy 品牌标（同心圆）", []],
  ["brand-qoder", "Qoder 品牌标（菱形）", []],
  ["brand-qwen", "Qwen 品牌标（双弧）", []],
];

mkdirSync(OUT_DIR, { recursive: true });
const allShapes = { ...shapes, ...brandShapes };
const manifest = {};
let total = 0;
for (const [name, description, variants] of MANIFEST_ENTRIES) {
  const draw = allShapes[name];
  if (!draw) throw new Error(`缺少绘制定义：${name}`);
  const files = [];
  const emit = (fileName, color) => {
    const canvas = new Canvas();
    const cov = canvas.allocCoverage();
    draw(cov, canvas);
    canvas.strokeCoverage(hex(color), cov);
    const png = canvas.toPng();
    writeFileSync(resolve(OUT_DIR, fileName), png);
    files.push(fileName);
    total += png.length;
    console.log(`wrote src/assets/icons/${fileName} (${png.length} bytes)`);
  };
  emit(`${name}.png`, COLORS.gray);
  for (const variant of variants) {
    emit(`${name}-${variant}.png`, VARIANTS[variant]);
  }
  manifest[name] = { description, files };
}
writeFileSync(resolve(OUT_DIR, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`manifest.json（${Object.keys(manifest).length} 图标，${total} bytes 总量）`);
