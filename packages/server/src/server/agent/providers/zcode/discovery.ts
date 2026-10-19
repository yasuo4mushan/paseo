/**
 * ZCode executable discovery.
 *
 * The ZCode app-server ships inside the Z.ai ZCode desktop app on macOS and is
 * not usually on PATH. Three launch strategies, in priority order:
 *
 *   1. A `command` override in config (`agents.providers.zcode.command`) —
 *      replaces the default command entirely (handled by resolveProviderLaunch).
 *   2. A `zcode` binary on PATH (`zcode app-server`).
 *   3. The macOS desktop-app bundle: `node <ZCode.app>/Contents/Resources/glm/
 *      zcode.cjs app-server` (login state is shared with the desktop app).
 */
import fs from "node:fs";
import path from "node:path";

import { findExecutable } from "../../../../executable-resolution/executable-resolution.js";
import {
  resolveProviderLaunch,
  type ProviderRuntimeSettings,
  type ResolvedProviderLaunch,
} from "../../provider-launch-config.js";

export const ZCODE_BINARY_NAME = "zcode";
export const ZCODE_APP_SERVER_ARG = "app-server";

/** macOS desktop-app bundle layout (verified against ZCode 0.16.9). */
export const ZCODE_MACOS_APP_CJS_PATH = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

export interface ZcodeLaunch {
  command: string;
  args: string[];
  source: "path" | "macos-app-bundle" | "override" | "append" | "unavailable";
}

export async function resolveZcodeLaunch(
  runtimeSettings?: ProviderRuntimeSettings,
): Promise<ZcodeLaunch> {
  const commandConfig = runtimeSettings?.command;
  const launch: ResolvedProviderLaunch = await resolveProviderLaunch({
    commandConfig,
    defaultBinary: ZCODE_BINARY_NAME,
  });

  if (launch.source === "override") {
    return {
      command: launch.command,
      args: [...launch.args, ZCODE_APP_SERVER_ARG],
      source: "override",
    };
  }

  const extraArgs = launch.source === "append" ? launch.args : [];
  const discovered = await discoverDefaultZcodeLaunch();
  if (!discovered) {
    return {
      command: ZCODE_BINARY_NAME,
      args: [...extraArgs, ZCODE_APP_SERVER_ARG],
      source: "unavailable",
    };
  }
  return {
    ...discovered,
    args: [...discovered.args, ...extraArgs, ZCODE_APP_SERVER_ARG],
    source: launch.source === "append" ? "append" : discovered.source,
  };
}

async function discoverDefaultZcodeLaunch(): Promise<{
  command: string;
  args: string[];
  source: "path" | "macos-app-bundle";
} | null> {
  const onPath = await findExecutable(ZCODE_BINARY_NAME);
  if (onPath) {
    return { command: onPath, args: [], source: "path" };
  }
  if (process.platform === "darwin" && zcodeAppBundleCjsExists()) {
    // The bundle only ships the .cjs entry; run it with the current node.
    return {
      command: process.execPath,
      args: [ZCODE_MACOS_APP_CJS_PATH],
      source: "macos-app-bundle",
    };
  }
  return null;
}

export function zcodeAppBundleCjsExists(): boolean {
  try {
    return fs.statSync(ZCODE_MACOS_APP_CJS_PATH).isFile();
  } catch {
    return false;
  }
}

export async function isZcodeLaunchAvailable(runtimeSettings?: ProviderRuntimeSettings): Promise<{
  available: boolean;
  launch: ZcodeLaunch;
}> {
  const launch = await resolveZcodeLaunch(runtimeSettings);
  if (launch.source === "override") {
    // Absolute paths can be checked directly; bare names need PATH resolution.
    if (path.isAbsolute(launch.command)) {
      try {
        return { available: fs.statSync(launch.command).isFile(), launch };
      } catch {
        return { available: false, launch };
      }
    }
    return { available: (await findExecutable(launch.command)) !== null, launch };
  }
  return { available: launch.source === "path" || launch.source === "macos-app-bundle", launch };
}

export function describeZcodeLaunchSource(launch: ZcodeLaunch): string {
  switch (launch.source) {
    case "path":
      return `zcode on PATH (${launch.command})`;
    case "macos-app-bundle":
      return `ZCode desktop app bundle (${ZCODE_MACOS_APP_CJS_PATH})`;
    case "override":
      return `configured command override (${[launch.command, ...launch.args].join(" ")})`;
    case "append":
      return "default launch with configured extra args";
    default:
      return "not found";
  }
}
