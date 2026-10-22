/**
 * tabBar 图标生成器：纯 Node（zlib）最小 PNG 写出，3x 超采样抗锯齿。
 *
 * 产物：src/assets/tabbar/{devices,settings}{,-active}.png（81x81 RGBA）
 * 用法：node scripts/gen-tab-icons.mjs
 */

import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(here, "../src/assets/tabbar");

const SIZE = 81;
const SS = 3; // 超采样倍数

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---------- 绘图（超采样画布） ----------

function hex(color) {
  const v = parseInt(color.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

class Canvas {
  constructor(size) {
    this.size = size;
    this.data = new Float64Array(size * size * 4);
  }

  setPx(x, y, [r, g, b], a) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    // source-over 合成
    const dstA = this.data[i + 3];
    const outA = a + dstA * (1 - a);
    this.data[i] = outA === 0 ? 0 : (r * a + this.data[i] * dstA * (1 - a)) / outA;
    this.data[i + 1] = outA === 0 ? 0 : (g * a + this.data[i + 1] * dstA * (1 - a)) / outA;
    this.data[i + 2] = outA === 0 ? 0 : (b * a + this.data[i + 2] * dstA * (1 - a)) / outA;
    this.data[i + 3] = outA;
  }

  fillRoundRect(x, y, w, h, r, color) {
    const rgb = hex(color);
    const x1 = Math.ceil(x * SS), y1 = Math.ceil(y * SS);
    const x2 = Math.ceil((x + w) * SS), y2 = Math.ceil((y + h) * SS);
    const rr = r * SS;
    for (let py = y1; py < y2; py++) {
      for (let px = x1; px < x2; px++) {
        // 圆角覆盖率：点到圆角矩形的有符号距离近似
        const cx = Math.min(Math.max(px + 0.5, x * SS + rr), (x + w) * SS - rr);
        const cy = Math.min(Math.max(py + 0.5, y * SS + rr), (y + h) * SS - rr);
        const dx = px + 0.5 - cx, dy = py + 0.5 - cy;
        const dist = Math.sqrt(dx * dx + dy * dy) - rr;
        const alpha = Math.min(Math.max(0.5 - dist, 0), 1);
        if (alpha > 0) this.setPx(px, py, rgb, alpha);
      }
    }
  }

  fillCircle(cx, cy, r, color) {
    const rgb = hex(color);
    const lo = Math.ceil((cx - r) * SS), hi = Math.ceil((cx + r) * SS);
    for (let py = lo; py < hi; py++) {
      for (let px = lo; px < hi; px++) {
        const dx = px + 0.5 - cx * SS, dy = py + 0.5 - cy * SS;
        const dist = Math.sqrt(dx * dx + dy * dy) - r * SS;
        const alpha = Math.min(Math.max(0.5 - dist, 0), 1);
        if (alpha > 0) this.setPx(px, py, rgb, alpha);
      }
    }
  }

  clearCircle(cx, cy, r) {
    const lo = Math.ceil((cx - r) * SS), hi = Math.ceil((cx + r) * SS);
    for (let py = lo; py < hi; py++) {
      for (let px = lo; px < hi; px++) {
        const dx = px + 0.5 - cx * SS, dy = py + 0.5 - cy * SS;
        const dist = Math.sqrt(dx * dx + dy * dy) - r * SS;
        if (dist < 0) {
          const i = (py * this.size + px) * 4;
          this.data[i + 3] = 0;
        }
      }
    }
  }

  /** 3x 盒式降采样到 SIZE x SIZE 的 PNG buffer。 */
  toPng() {
    const out = Buffer.alloc(SIZE * SIZE * 4);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const i = ((y * SS + sy) * this.size + x * SS + sx) * 4;
            const pa = this.data[i + 3];
            r += this.data[i] * pa;
            g += this.data[i + 1] * pa;
            b += this.data[i + 2] * pa;
            a += pa;
          }
        }
        const o = (y * SIZE + x) * 4;
        if (a > 0) {
          out[o] = Math.round(r / a);
          out[o + 1] = Math.round(g / a);
          out[o + 2] = Math.round(b / a);
        }
        out[o + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
    return encodePng(SIZE, SIZE, out);
  }
}

// ---------- 图标形状 ----------

/** 设备：显示器（圆角屏幕 + 支架 + 底座）。 */
function drawDevices(color) {
  const c = new Canvas(SIZE * SS);
  c.fillRoundRect(10, 14, 61, 42, 8, color); // 屏幕
  c.fillRoundRect(36, 56, 9, 9, 2, color); // 支架
  c.fillRoundRect(24, 64, 33, 6, 3, color); // 底座
  return c.toPng();
}

/** 设置：三档滑杆（细杆 + 空心旋钮）。 */
function drawSettings(color) {
  const c = new Canvas(SIZE * SS);
  const bars = [
    { y: 23, knob: 58 },
    { y: 40.5, knob: 28 },
    { y: 58, knob: 47 },
  ];
  for (const { y, knob } of bars) {
    c.fillRoundRect(14, y - 2.5, 53, 5, 2.5, color);
    c.fillCircle(knob, y, 10, color);
    c.clearCircle(knob, y, 4.5);
  }
  return c.toPng();
}

const BRAND = "#07C160";
const GRAY = "#8A9099";

mkdirSync(OUT_DIR, { recursive: true });
const files = [
  ["devices.png", drawDevices(GRAY)],
  ["devices-active.png", drawDevices(BRAND)],
  ["settings.png", drawSettings(GRAY)],
  ["settings-active.png", drawSettings(BRAND)],
];
for (const [name, png] of files) {
  writeFileSync(resolve(OUT_DIR, name), png);
  console.log(`wrote src/assets/tabbar/${name} (${png.length} bytes)`);
}
