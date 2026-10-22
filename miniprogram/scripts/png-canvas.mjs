/**
 * 共享 PNG 绘图画布：纯 Node（zlib）最小 PNG 写出，3x 超采样抗锯齿。
 *
 * t20 在 t15 的填充原语之上补齐"1.5px 线条风"描边原语
 * （线段/圆/弧/圆角矩形/折线，按骨架距离做覆盖度抗锯齿），
 * 供 gen-tab-icons.mjs（tabBar）与 gen-icons.mjs（应用内图标）共用。
 *
 * 约定：坐标为 81x81 逻辑画布（SIZE），内部按 SS=3 超采样；
 * 描边宽度 w 为逻辑像素（81px 画布上 w≈5 对应 24px 渲染尺寸的 1.5px）。
 */

import { deflateSync } from "node:zlib";
import { Buffer } from "node:buffer";

export const SIZE = 81;
export const SS = 3;

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

export function encodePng(width, height, rgba) {
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

// ---------- 绘图画布 ----------

export function hex(color) {
  const v = parseInt(color.slice(1), 16);
  return [(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
}

export class Canvas {
  constructor(size = SIZE * SS) {
    this.size = size;
    this.data = new Float64Array(size * size * 4);
  }

  setPx(x, y, [r, g, b], a) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    const dstA = this.data[i + 3];
    const outA = a + dstA * (1 - a);
    this.data[i] = outA === 0 ? 0 : (r * a + this.data[i] * dstA * (1 - a)) / outA;
    this.data[i + 1] = outA === 0 ? 0 : (g * a + this.data[i + 1] * dstA * (1 - a)) / outA;
    this.data[i + 2] = outA === 0 ? 0 : (b * a + this.data[i + 2] * dstA * (1 - a)) / outA;
    this.data[i + 3] = outA;
  }

  // ----- 填充原语（t15 遗产） -----

  fillRoundRect(x, y, w, h, r, color) {
    const rgb = hex(color);
    const x1 = Math.ceil(x * SS), y1 = Math.ceil(y * SS);
    const x2 = Math.ceil((x + w) * SS), y2 = Math.ceil((y + h) * SS);
    const rr = r * SS;
    for (let py = y1; py < y2; py++) {
      for (let px = x1; px < x2; px++) {
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

  // ----- 描边原语（t20 线条风） -----
  // 覆盖度 = clamp(0.5 - (骨架距离 - w/2))：距骨架 w/2 内全亮，向外 1px 线性衰减。

  /** 按最大覆盖度描一层颜色（同色多原语取并集）。 */
  strokeCoverage(rgb, coverage) {
    for (let i = 0; i < coverage.length; i++) {
      const alpha = coverage[i];
      if (alpha <= 0) continue;
      const px = i % this.size;
      const py = (i / this.size) | 0;
      this.setPx(px, py, rgb, alpha);
    }
  }

  allocCoverage() {
    return new Float64Array(this.size * this.size);
  }

  covLine(cov, x1, y1, x2, y2, w) {
    const half = (w * SS) / 2;
    const ax = x1 * SS, ay = y1 * SS, bx = x2 * SS, by = y2 * SS;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    // 物理像素包围盒（超采样坐标）+ 2px 余量
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - half) - 2);
    const maxX = Math.min(this.size - 1, Math.ceil(Math.max(ax, bx) + half) + 2);
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - half) - 2);
    const maxY = Math.min(this.size - 1, Math.ceil(Math.max(ay, by) + half) + 2);
    for (let py = minY; py < maxY; py++) {
      if (py < 0 || py >= this.size) continue;
      for (let px = minX; px < maxX; px++) {
        if (px < 0 || px >= this.size) continue;
        const sx = px + 0.5, sy = py + 0.5;
        let t = len2 === 0 ? 0 : ((sx - ax) * dx + (sy - ay) * dy) / len2;
        t = Math.min(1, Math.max(0, t));
        const ex = ax + t * dx, ey = ay + t * dy;
        const dist = Math.sqrt((sx - ex) ** 2 + (sy - ey) ** 2) - half;
        const alpha = Math.min(Math.max(0.5 - dist, 0), 1);
        if (alpha > 0) {
          const i = py * this.size + px;
          if (alpha > cov[i]) cov[i] = alpha;
        }
      }
    }
  }

  covCircle(cov, cx, cy, r, w) {
    const half = (w * SS) / 2;
    const lo0 = Math.floor((cx - r) * SS - half) - 2;
    const hi0 = Math.ceil((cx + r) * SS + half) + 2;
    const lo = Math.max(0, lo0);
    const hi = Math.min(this.size - 1, hi0);
    for (let py = lo; py < hi; py++) {
      if (py < 0 || py >= this.size) continue;
      for (let px = lo; px < hi; px++) {
        if (px < 0 || px >= this.size) continue;
        const dx = px + 0.5 - cx * SS, dy = py + 0.5 - cy * SS;
        const dist = Math.abs(Math.sqrt(dx * dx + dy * dy) - r * SS) - half;
        const alpha = Math.min(Math.max(0.5 - dist, 0), 1);
        if (alpha > 0) {
          const i = py * this.size + px;
          if (alpha > cov[i]) cov[i] = alpha;
        }
      }
    }
  }

  /** 弧描边：角度制（度），0°=+x，顺时针（屏幕 y 向下为正）。 */
  covArc(cov, cx, cy, r, w, a0, a1) {
    const half = (w * SS) / 2;
    // 角度采样足够密（每 2° 一段折线），端点圆头由 covLine 端帽近似（butt）。
    const steps = Math.max(2, Math.ceil(Math.abs(a1 - a0) / 2));
    for (let s = 0; s < steps; s++) {
      const t0 = a0 + ((a1 - a0) * s) / steps;
      const t1 = a0 + ((a1 - a0) * (s + 1)) / steps;
      const p0 = [cx + r * Math.cos((t0 * Math.PI) / 180), cy + r * Math.sin((t0 * Math.PI) / 180)];
      const p1 = [cx + r * Math.cos((t1 * Math.PI) / 180), cy + r * Math.sin((t1 * Math.PI) / 180)];
      this.covLine(cov, p0[0], p0[1], p1[0], p1[1], w);
    }
    void half;
  }

  covRoundRect(cov, x, y, w, h, r, lineW) {
    const rr = Math.min(r, w / 2, h / 2);
    // 四段直边
    this.covLine(cov, x + rr, y, x + w - rr, y, lineW);
    this.covLine(cov, x + rr, y + h, x + w - rr, y + h, lineW);
    this.covLine(cov, x, y + rr, x, y + h - rr, lineW);
    this.covLine(cov, x + w, y + rr, x + w, y + h - rr, lineW);
    // 四个圆角
    this.covArc(cov, x + rr, y + rr, rr, lineW, 180, 270);
    this.covArc(cov, x + w - rr, y + rr, rr, lineW, 270, 360);
    this.covArc(cov, x + w - rr, y + h - rr, rr, lineW, 0, 90);
    this.covArc(cov, x + rr, y + h - rr, rr, lineW, 90, 180);
  }

  /** 折线（可选闭合）。 */
  covPolyline(cov, points, w, close = false) {
    for (let i = 0; i < points.length - 1; i++) {
      this.covLine(cov, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1], w);
    }
    if (close && points.length > 2) {
      const a = points[points.length - 1];
      const b = points[0];
      this.covLine(cov, a[0], a[1], b[0], b[1], w);
    }
  }

  /** 描边原语的统一入口：传入绘制回调，落一层颜色。 */
  stroke(color, draw) {
    const cov = this.allocCoverage();
    draw(cov, this);
    this.strokeCoverage(hex(color), cov);
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

/** 常用色（与 tabBar/theme.json 一致）。 */
export const COLORS = {
  gray: "#8A9099",
  green: "#07C160",
  danger: "#FA5151",
  warning: "#FAAD14",
  white: "#FFFFFF",
};

/** 统一线宽：81px 画布 ≈ 24px 渲染下的 1.5px。 */
export const LINE = 5;
