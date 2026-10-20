/**
 * UTF-8 编解码的纯 TS 实现。
 *
 * 为什么不用 TextEncoder/TextDecoder：微信小程序 JS 环境没有这两个全局。
 * 官方实现（packages/relay/src/crypto.ts）运行在有 DOM lib 的环境，我们这里
 * 需要行为等价的纯 JS 版本（含 fatal 语义：非法字节序列抛错，用于密文
 * 不是合法 UTF-8 时的二进制判定，与官方 decodeLegacyPlaintext 一致）。
 */

export function encodeUtf8(input: string): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < input.length; i += 1) {
    let codePoint = input.charCodeAt(i);
    // 代理对（surrogate pair）合成完整 code point
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = ((codePoint - 0xd800) << 10) | (next - 0xdc00 + 0x10000);
        i += 1;
      }
    }
    if (codePoint < 0x80) {
      out.push(codePoint);
    } else if (codePoint < 0x800) {
      out.push(0xc0 | (codePoint >> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint < 0x10000) {
      out.push(
        0xe0 | (codePoint >> 12),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      out.push(
        0xf0 | (codePoint >> 18),
        0x80 | ((codePoint >> 12) & 0x3f),
        0x80 | ((codePoint >> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(out);
}

/** 解码 UTF-8。fatal=true 时非法序列抛 Error（对齐 TextDecoder fatal 语义）。 */
export function decodeUtf8(bytes: Uint8Array, options?: { fatal?: boolean }): string {
  const fatal = options?.fatal ?? false;
  let out = "";
  let i = 0;
  while (i < bytes.length) {
    const byte = bytes[i];
    let codePoint: number;
    let extraBytes: number;
    if (byte < 0x80) {
      codePoint = byte;
      extraBytes = 0;
    } else if (byte >= 0xc2 && byte <= 0xdf) {
      codePoint = byte & 0x1f;
      extraBytes = 1;
    } else if (byte >= 0xe0 && byte <= 0xef) {
      codePoint = byte & 0x0f;
      extraBytes = 2;
    } else if (byte >= 0xf0 && byte <= 0xf4) {
      codePoint = byte & 0x07;
      extraBytes = 3;
    } else {
      codePoint = -1;
      extraBytes = 0;
    }
    if (codePoint < 0) {
      if (fatal) throw new Error("Invalid UTF-8 sequence");
      out += "\uFFFD";
      i += 1;
      continue;
    }
    let valid = i + extraBytes < bytes.length;
    for (let j = 1; valid && j <= extraBytes; j += 1) {
      const cont = bytes[i + j];
      if ((cont & 0xc0) !== 0x80) {
        valid = false;
        break;
      }
      codePoint = (codePoint << 6) | (cont & 0x3f);
    }
    if (!valid) {
      if (fatal) throw new Error("Invalid UTF-8 sequence");
      out += "\uFFFD";
      i += 1;
      continue;
    }
    // 过长的编码 / 超出 Unicode 范围
    if (
      codePoint > 0x10ffff ||
      (extraBytes === 2 && codePoint < 0x800) ||
      (extraBytes === 3 && codePoint < 0x10000) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff)
    ) {
      if (fatal) throw new Error("Invalid UTF-8 sequence");
      out += "\uFFFD";
      i += 1;
      continue;
    }
    if (codePoint < 0x10000) {
      out += String.fromCharCode(codePoint);
    } else {
      codePoint -= 0x10000;
      out += String.fromCharCode(0xd800 + (codePoint >> 10), 0xdc00 + (codePoint & 0x3ff));
    }
    i += extraBytes + 1;
  }
  return out;
}
