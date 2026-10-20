/**
 * 随机字节来源（tweetnacl PRNG 前置层）。
 *
 * 官方实现（packages/relay/src/crypto.ts ensurePrng）优先用
 * crypto.getRandomValues；微信小程序没有 WebCrypto，wx.getRandomValues 只有
 * 异步形态。策略：
 * - 启动时用 wx.getRandomValues 预灌一个同步字节池（installPooledRandomSource），
 *   池空时后台补充，取字节始终同步。
 * - 池彻底耗尽时退化为 Math.random 混合时间戳 + 计数器的兜底（安全性降级，
 *   README 中说明；正常路径下池在 App onLaunch 就已灌满）。
 * - Node 测试环境直接 installSystemRandomSource 用 node:crypto。
 *
 * tweetnacl 在小程序 bundle 里不能依赖其默认 PRNG 探测（它会尝试
 * require("crypto")，webpack 无法解析 node 内建模块），因此本模块必须
 * 在任何 nacl.randomBytes 调用前完成 setPRNG。
 */

import nacl from "tweetnacl";

type RandomProvider = (n: number) => Uint8Array;

let installed = false;
let pool: Uint8Array | null = null;
let poolOffset = 0;
let fallbackCounter = 0;

function systemRandom(n: number): Uint8Array {
  const g = globalThis as { crypto?: { getRandomValues?: (buf: Uint8Array) => Uint8Array } };
  if (g.crypto?.getRandomValues) {
    const buf = new Uint8Array(n);
    g.crypto.getRandomValues(buf);
    return buf;
  }
  return mathRandomFallback(n);
}

function mathRandomFallback(n: number): Uint8Array {
  // 兜底：非加密随机。仅当字节池耗尽且无 WebCrypto 时使用。
  const out = new Uint8Array(n);
  const now = Date.now();
  for (let i = 0; i < n; i += 1) {
    fallbackCounter = (fallbackCounter + 1) & 0xffff;
    const mix = Math.random() * 256 + (now ^ (fallbackCounter << 3)) + (out[i] || 0);
    out[i] = Math.floor(mix) & 0xff;
  }
  return out;
}

function pooledRandom(n: number): Uint8Array {
  if (!pool) {
    return systemRandom(n);
  }
  const remaining = pool.length - poolOffset;
  if (remaining >= n) {
    const slice = pool.slice(poolOffset, poolOffset + n);
    poolOffset += n;
    return slice;
  }
  // 池不够：先用掉剩余字节，其余走系统/兜底来源
  const out = new Uint8Array(n);
  if (remaining > 0) {
    out.set(pool.slice(poolOffset, pool.length), 0);
    poolOffset = pool.length;
  }
  const tail = systemRandom(n - remaining);
  out.set(tail, remaining);
  return out;
}

function install(provider: RandomProvider): void {
  nacl.setPRNG((target, n) => {
    const bytes = provider(n);
    target.set(bytes.subarray(0, n), 0);
  });
  installed = true;
}

/** 使用（字节池 + 系统）组合来源。返回后台补充池的函数。 */
export function installPooledRandomSource(refill: (n: number) => Promise<Uint8Array>): () => void {
  const POOL_SIZE = 8192;
  let refilling = false;
  let stopped = false;

  const doRefill = () => {
    if (refilling || stopped) return;
    refilling = true;
    refill(POOL_SIZE)
      .then((bytes) => {
        if (stopped) return;
        if (bytes.byteLength > 0) {
          pool = bytes;
          poolOffset = 0;
        }
        refilling = false;
        // 池低于一半时持续补充（空回调场景不轮询，避免空转）
        if (bytes.byteLength > 0 && (pool?.length ?? 0) - poolOffset < POOL_SIZE / 2) {
          setTimeout(doRefill, 50);
        }
      })
      .catch(() => {
        refilling = false;
      });
  };
  doRefill();

  install(pooledRandom);
  const keepWarm = setInterval(() => {
    if (stopped) return;
    if ((pool?.length ?? 0) - poolOffset < POOL_SIZE / 2) doRefill();
  }, 500);
  return () => {
    stopped = true;
    clearInterval(keepWarm);
  };
}

/** 使用系统随机来源（Node / 浏览器）。 */
export function installSystemRandomSource(): void {
  install(systemRandom);
}

/** 测试用：直接注入确定性来源。 */
export function installRandomProviderForTests(provider: RandomProvider): void {
  install(provider);
}

export function randomSourceInstalled(): boolean {
  return installed;
}
