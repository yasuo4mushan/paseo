/**
 * 解析主仓 node_modules 里的官方 @getpaseo/relay（互通测试的对端）。
 *
 * miniprogram/ 不在主仓 npm workspaces 里（刻意为之，避免污染主仓依赖），
 * 因此这里按优先级探测官方实现的位置：
 * 1. 环境变量 PASEO_MAIN_CHECKOUT 指定的主仓根目录
 * 2. worktree 旁的主仓检出（worktree 是 <repo>/../paseo-worktrees/<name>、
 *    主仓是 <repo>/../paseo 的布局）
 * 3. worktree 自身根目录（若主仓依赖已安装在本 worktree）
 *
 * 找不到时返回 null —— 互通测试 describe.skipIf 跳过而不是失败。
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/** 官方 Transport 接口（packages/relay/src/encrypted-channel.ts）。 */
export interface OfficialTransport {
  send(data: string | ArrayBuffer): void | Promise<void>;
  close(code?: number, reason?: string): void;
  onmessage: ((message: { data: string | ArrayBuffer; isBinary: boolean }) => void) | null;
  onclose: ((code: number, reason: string) => void) | null;
  onerror: ((error: Error) => void) | null;
}

export interface OfficialChannel {
  send(data: string | ArrayBuffer): Promise<void> | void;
  close(code?: number, reason?: string): void;
  isOpen(): boolean;
}

export interface OfficialRelay {
  createClientChannel(
    transport: OfficialTransport,
    daemonPublicKeyB64: string,
    events: {
      onopen?: () => void;
      onmessage?: (data: string | ArrayBuffer) => void;
      onclose?: (code: number, reason: string) => void;
      onerror?: (error: Error) => void;
    },
  ): Promise<OfficialChannel>;
  createDaemonChannel(
    transport: OfficialTransport,
    daemonKeyPair: { publicKey: Uint8Array; secretKey: Uint8Array },
    events: {
      onopen?: () => void;
      onmessage?: (data: string | ArrayBuffer) => void;
      onclose?: (code: number, reason: string) => void;
      onerror?: (error: Error) => void;
    },
  ): Promise<OfficialChannel>;
  generateKeyPair(): { publicKey: Uint8Array; secretKey: Uint8Array };
  exportPublicKey(publicKey: Uint8Array): string;
  importPublicKey(base64: string): Uint8Array;
}

function candidateDirs(): string[] {
  const out: string[] = [];
  if (process.env.PASEO_MAIN_CHECKOUT) {
    out.push(process.env.PASEO_MAIN_CHECKOUT);
  }
  // worktree 布局：.../companyproj/paseo-worktrees/<name> 与主仓 .../companyproj/paseo
  // （本文件位于 miniprogram/tests/helpers/，主仓检出在上五级目录旁）
  out.push(path.resolve(__dirname, "..", "..", "..", "..", "..", "paseo"));
  // worktree 自身根目录（主仓依赖已安装在本 worktree 的情况）
  out.push(path.resolve(__dirname, "..", "..", ".."));
  return out;
}

let cached: OfficialRelay | null | undefined;

export function loadOfficialRelay(): OfficialRelay | null {
  if (cached !== undefined) return cached;
  for (const dir of candidateDirs()) {
    const e2eePath = path.join(dir, "node_modules", "@getpaseo", "relay", "dist", "e2ee.js");
    if (!existsSync(e2eePath)) continue;
    const requireFromFile = createRequire(path.join(dir, "package.json"));
    const mod = requireFromFile(e2eePath) as unknown;
    if (
      mod &&
      typeof (mod as OfficialRelay).createClientChannel === "function" &&
      typeof (mod as OfficialRelay).createDaemonChannel === "function" &&
      typeof (mod as OfficialRelay).generateKeyPair === "function"
    ) {
      cached = mod as OfficialRelay;
      return cached;
    }
  }
  cached = null;
  return null;
}
