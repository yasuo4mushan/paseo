import { spawn } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  getPidLockInfo,
  isPidLockOwnerRunning,
  isSamePidLock,
  releasePidLock,
  type PidLockInfo,
} from "./pid-lock.js";
import { legacyPaseoHomeCandidate, migrateLegacyPaseoHome } from "./paseo-home.js";
import { daemonLaunchEnvironment } from "./config-environment.js";
import { readPersistedConfig } from "./persisted-config.js";
import treeKill from "tree-kill";
const killTree = (pid: number, signal: string): Promise<void> =>
  new Promise((resolve, reject) =>
    treeKill(pid, signal, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    }),
  );

// Process ownership only: desktop and CLI load this entry in their own processes.
// Keep daemon bootstrap and WebSocket schemas out of its dependency tree.
export { resolvePaseoHome } from "./paseo-home.js";
export { legacyPaseoHomeCandidate, migrateLegacyPaseoHome } from "./paseo-home.js";
export {
  readEnvSetting,
  withLegacyPaseoEnvAliases,
  applyLegacyPaseoEnvAliases,
} from "./env-compat.js";
export { ensurePrivateDirectory } from "./private-files.js";
export { daemonLaunchEnvironment } from "./config-environment.js";
export { readLocalCredentialForTarget } from "./local-credential.js";
export {
  isSamePidLock as isSameDaemonInstance,
  type PidLockInfo as DaemonInstance,
} from "./pid-lock.js";

// COMPAT(paseoNames): added in v0.12.0, remove after 2027-04-30.
// Moves ~/.paseo (or a checkout's .dev/paseo-home) onto its aaswitch
// successor the first time a daemon starts against the new default home.
// Never overwrites an existing target and never migrates a home whose
// legacy directory still hosts a running daemon.
export async function ensureMigratedPaseoHome(home: string): Promise<void> {
  const legacyHome = legacyPaseoHomeCandidate(home);
  if (!legacyHome || existsSync(home) || !existsSync(legacyHome)) return;

  const legacyLock = await getPidLockInfo(legacyHome);
  const result = migrateLegacyPaseoHome(home, {
    isLegacyHomeInUse: () => legacyLock !== null && isPidLockOwnerRunning(legacyLock),
  });
  if (result.action === "none") return;

  const detail =
    result.action === "skipped"
      ? `legacy home ${result.from} still hosts a running daemon; starting fresh in ${result.to} instead`
      : `migrated home ${result.from} -> ${result.to}${result.copied ? " (copied; legacy directory retained as backup)" : ""}`;
  process.stderr.write(`aaswitch: ${detail}\n`);
  try {
    appendFileSync(
      path.join(result.to, "daemon.log"),
      `${JSON.stringify({
        level: "warn",
        time: new Date().toISOString(),
        pid: process.pid,
        name: "DaemonInstance",
        msg: `aaswitch home migration: ${detail}`,
      })}\n`,
    );
  } catch {
    // daemon.log is best-effort; stderr already carries the migration notice.
  }
}

export class DaemonInstanceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export async function readDaemonInstance(home: string): Promise<PidLockInfo | null> {
  const lock = await getPidLockInfo(home);
  return lock && isPidLockOwnerRunning(lock) ? lock : null;
}

export function daemonLogPath(home: string): string {
  try {
    return path.resolve(home, readPersistedConfig(home).log?.file?.path ?? "daemon.log");
  } catch {
    return path.join(home, "daemon.log");
  }
}

export async function waitForDaemonReady(
  home: string,
  options: {
    timeoutMs?: number;
    instance?: PidLockInfo;
    signal?: AbortSignal;
  } = {},
): Promise<PidLockInfo & { listen: string }> {
  const deadline = Date.now() + (options.timeoutMs ?? 600_000);
  while (true) {
    options.signal?.throwIfAborted();
    const instance = await readDaemonInstance(home);
    if (!instance)
      throw new DaemonInstanceError(
        "DAEMON_NOT_RUNNING",
        `Daemon is not running for ${home}. Start with: aaswitch daemon start --home ${JSON.stringify(home)}`,
      );
    if (options.instance && !isSamePidLock(instance, options.instance)) {
      throw new DaemonInstanceError(
        "DAEMON_REPLACED",
        `Supervisor changed for ${home}; refusing to follow PID ${instance.pid}.`,
      );
    }
    if (instance.listen) return { ...instance, listen: instance.listen };
    if (Date.now() >= deadline) throw notReady(home, instance);
    await delay(100, undefined, { signal: options.signal });
  }
}

function notReady(home: string, instance: PidLockInfo): DaemonInstanceError {
  return new DaemonInstanceError(
    "DAEMON_NOT_READY",
    `Daemon PID ${instance.pid} remains running but is not ready for ${home}.\nLogs: ${daemonLogPath(home)}\nStatus: aaswitch daemon status --home ${JSON.stringify(home)}\nStop: aaswitch daemon stop --home ${JSON.stringify(home)}`,
  );
}

async function requestInstanceStop(
  home: string,
  instance: PidLockInfo,
  options: {
    force?: boolean;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  },
) {
  let forced = false;
  let usedLifecycleRpc = false;
  if (process.platform === "win32") {
    if (instance.listen && options.requestShutdown) {
      try {
        await options.requestShutdown({ ...instance, listen: instance.listen });
        usedLifecycleRpc = true;
      } catch (error) {
        if (!options.force) throw error;
        const current = await getPidLockInfo(home);
        if (current && !isSamePidLock(instance, current))
          throw new DaemonInstanceError(
            "DAEMON_REPLACED",
            `Supervisor changed for ${home}; refusing forced cleanup.`,
          );
        await killTree(instance.pid, "SIGKILL");
        forced = true;
      }
    } else if (!options.force) {
      throw new DaemonInstanceError(
        "STOP_NO_GRACEFUL_CHANNEL",
        `PID ${instance.pid} for ${home} has no graceful shutdown channel. Use --force explicitly to terminate it.`,
      );
    } else {
      await killTree(instance.pid, "SIGKILL");
      forced = true;
    }
  } else {
    try {
      process.kill(instance.pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
  return { forced, usedLifecycleRpc };
}

export async function stopDaemonInstance(
  home: string,
  options: {
    instance?: PidLockInfo;
    force?: boolean;
    timeoutMs?: number;
    killTimeoutMs?: number;
    requestShutdown?: (instance: PidLockInfo & { listen: string }) => Promise<void>;
  } = {},
): Promise<{
  action: "stopped" | "not_running";
  pid: number | null;
  forced: boolean;
  usedLifecycleRpc: boolean;
}> {
  const { timeoutMs = 15_000, killTimeoutMs = 3_000 } = options;
  const deadline = Date.now() + timeoutMs;
  const instance = await getPidLockInfo(home);
  if (options.instance && instance && !isSamePidLock(instance, options.instance)) {
    throw new DaemonInstanceError(
      "DAEMON_REPLACED",
      `Supervisor changed for ${home}; refusing to stop PID ${instance.pid}.`,
    );
  }
  if (!instance || !isPidLockOwnerRunning(instance)) {
    if (instance)
      await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
    return {
      action: "not_running",
      pid: instance?.pid ?? null,
      forced: false,
      usedLifecycleRpc: false,
    };
  }
  if (instance.pid <= 1 || instance.pid === process.pid)
    throw new Error("Refusing to stop invalid supervisor PID");
  let { forced, usedLifecycleRpc } = await requestInstanceStop(home, instance, options);
  const waitForExit = async (waitMs: number) => {
    const exitDeadline = Date.now() + waitMs;
    while (isPidLockOwnerRunning(instance)) {
      const current = await getPidLockInfo(home);
      if (current && !isSamePidLock(instance, current))
        throw new DaemonInstanceError(
          "DAEMON_REPLACED",
          `Supervisor changed for ${home}; stop of PID ${instance.pid} was not confirmed.`,
        );
      if (Date.now() >= exitDeadline) return false;
      await delay(100);
    }
    return true;
  };
  let stopped = await waitForExit(forced ? killTimeoutMs : Math.max(0, deadline - Date.now()));
  if (!stopped && options.force && !forced) {
    await killTree(instance.pid, "SIGKILL");
    forced = true;
    stopped = await waitForExit(killTimeoutMs);
  }
  if (!stopped)
    throw new DaemonInstanceError(
      "STOP_NOT_CONFIRMED",
      `Timed out waiting for supervisor PID ${instance.pid} in ${home} to exit${options.force ? "" : "; use --force to permit forced cleanup"}.`,
    );
  await releasePidLock(home, { ownerPid: instance.pid, startedAt: instance.startedAt });
  return { action: "stopped", pid: instance.pid, forced, usedLifecycleRpc };
}

export async function startDaemonInstance(input: {
  home: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  mode: "managed" | "deployment";
  desktopManaged?: boolean;
  foreground?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onAcquired?: (instance: PidLockInfo) => void;
  onReady?: (instance: PidLockInfo & { listen: string }) => void;
}): Promise<{ instance: PidLockInfo; spawned: boolean; exitCode?: number }> {
  input.signal?.throwIfAborted();
  await ensureMigratedPaseoHome(input.home);
  const existing = await readDaemonInstance(input.home);
  if (existing) return { instance: existing, spawned: false };
  const {
    foreground = false,
    timeoutMs = 600_000,
    signal,
    onAcquired = () => {},
    onReady = () => {},
  } = input;
  const child = spawn(input.command, input.args, {
    env: daemonLaunchEnvironment(input),
    detached: !foreground,
    stdio: foreground ? "inherit" : "ignore",
    windowsHide: true,
  });
  let exit: { code: number; error?: Error } | undefined;
  const exited = new Promise<number>((resolve) => {
    child.once("error", (error) => {
      exit = { code: 1, error };
      resolve(1);
    });
    child.once("exit", (code) => {
      exit = { code: code ?? 1 };
      resolve(code ?? 1);
    });
  });
  const cancel = () => {
    if (child.pid && !exit) {
      child.ref();
      child.kill("SIGTERM");
    }
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (!foreground) child.unref();
  const deadline = foreground ? Infinity : Date.now() + timeoutMs;
  let acquired: PidLockInfo | undefined;
  async function waitUntilReady() {
    while (true) {
      signal?.throwIfAborted();
      const instance = await readDaemonInstance(input.home);
      if (instance && instance.pid !== child.pid) return { instance, spawned: false };
      if (instance && !acquired) {
        acquired = instance;
        onAcquired(instance);
      }
      if (exit) {
        const logPath = daemonLogPath(input.home);
        const log = await readFile(logPath, "utf8").catch(() => "");
        throw new DaemonInstanceError(
          "DAEMON_START_FAILED",
          `Daemon failed to start (${exit.error?.message ?? `exit ${exit.code}`}). Logs: ${logPath}\n${log.split("\n").slice(-30).join("\n")}`,
        );
      }
      if (instance?.listen) {
        const ready = { ...instance, listen: instance.listen };
        onReady(ready);
        return {
          instance: ready,
          spawned: true,
          ...(foreground ? { exitCode: await exited } : {}),
        };
      }
      if (Date.now() >= deadline) {
        if (acquired) throw notReady(input.home, acquired);
        throw new DaemonInstanceError(
          "DAEMON_NOT_READY",
          `Supervisor PID ${child.pid} remains running but has not published its lock for ${input.home}. Logs: ${daemonLogPath(input.home)}. Check aaswitch daemon status --home ${JSON.stringify(input.home)}. Stop with aaswitch daemon stop --home ${JSON.stringify(input.home)} once its lock is published, or signal this PID.`,
        );
      }
      await delay(100, undefined, { signal });
    }
  }
  try {
    return await waitUntilReady();
  } catch (error) {
    if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) {
      cancel();
      const stopped = await Promise.race([
        exited.then(() => true),
        delay(15_000, false, { ref: false }),
      ]);
      if (!stopped && child.pid) {
        await killTree(child.pid, "SIGKILL");
        await exited;
      }
    }
    throw error;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
